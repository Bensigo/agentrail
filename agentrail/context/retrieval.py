from __future__ import annotations

import hashlib
import json
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from agentrail.context.compiler import compiler_contract, extract_anchors
from agentrail.context.config import read_context_config
from agentrail.context.embeddings import embedding_config_hash, provider_name, configured_model, run_custom_command, run_openai_compatible
from agentrail.context.expansion import expand_query_tokens, query_expansion_enabled
from agentrail.context.index import append_audit, build_index, load_index
from agentrail.context.llm_rerank import LLM_RERANK_METHOD, llm_rerank, llm_rerank_enabled
from agentrail.context.pack_quality import compute_pack_quality
from agentrail.context.rerank import rerank_candidates, rerank_enabled
from agentrail.context.symbol_candidates import (
    cross_file_imported_symbols,
    definition_site_paths,
    select_definition_promotions,
)
from agentrail.shared.fs import sha256_text


# Retrieve-wide factors for the deterministic rerank stage (issue #904): the
# reranker sees max(limit * FACTOR, limit + MIN_EXTRA) candidates so a
# lower-retrieved-but-more-relevant source can be promoted into the kept top-K.
_RERANK_WIDEN_FACTOR = 3
_RERANK_WIDEN_MIN_EXTRA = 10

# Symbol-level recall layer monotonicity guard (#1043 AC4): the fraction of the
# flag-OFF baseline pack's top score a dropped baseline member must clear to be
# re-inserted over the injected pack's weakest tail. High enough to protect a
# genuinely relevant member the injection demoted (e.g. a top-scored spec doc)
# while ignoring the low-score keyword noise the injection legitimately
# out-ranked, so the recall win is kept and no relevant member is lost.
_RECALL_GUARD_SCORE_RATIO = 0.5

# Definition-aware rerank tier (#1104): how many of the pack's TOP-RANKED code
# files anchor the promotion. The token-split arm injects the imported symbols of
# every BM25 seed, including noisy ones (a fixtures.json / test file pulled in by
# keyword overlap contributes its own generic imports like `run`/`_build`). The
# promotion must instead key on the file the query actually retrieved -- the top
# code definition in the pack -- so it promotes THAT file's genuine dependencies
# and nothing else. 1 keeps it to the single strongest anchor.
_DEF_AWARE_SEED_TOPK = 1


def _graph_distance_by_path(index: Dict[str, Any], anchors: List[Dict[str, str]], *, max_hops: int = 2) -> Dict[str, int]:
    """Map candidate path -> min BFS depth from the task's TRUE anchor nodes.

    Distance is measured from deterministically-extracted *anchors* only (symbol
    / test / path identifiers in the task), NOT from BM25 retrieval seeds — a
    seed is just a keyword echo, so seed-distance would reward keyword-noise
    rather than graph-proximity to the task's real anchor.  Deterministic only:
    BFS depth over the deterministic Code Graph, never Graph Enrichment edges.

    ``_QUERY_TIME_EXCLUDED_EDGE_KINDS`` (e.g. ``unit_depends_on``, the Repo
    Wiki rollup) is never traversed here — see the module note above
    ``_graph_neighbors`` for why this is checked twice.
    """
    anchor_start_nodes, _started_from = _anchor_start_nodes(index, anchors)
    if not anchor_start_nodes:
        return {}
    graph = index.get("graph") if isinstance(index.get("graph"), dict) else {}
    neighbors = _graph_neighbors(graph)
    nodes_by_id = {
        str(node.get("id")): node
        for node in graph.get("nodes", [])
        if isinstance(node, dict) and node.get("id")
    }
    best_depth: Dict[str, int] = {str(n): 0 for n in anchor_start_nodes}
    queue: List[Tuple[str, int]] = [(str(n), 0) for n in anchor_start_nodes]
    while queue:
        node_id, depth = queue.pop(0)
        if depth >= max_hops:
            continue
        for edge in neighbors.get(node_id, []):
            # Redundant, explicit guard (defense-in-depth): _graph_neighbors
            # already strips these edges, but distance feeds ranking, so this
            # is checked again here rather than trusted solely to the shared
            # builder — see _QUERY_TIME_EXCLUDED_EDGE_KINDS.
            if edge.get("kind") in _QUERY_TIME_EXCLUDED_EDGE_KINDS:
                continue
            nxt = str(edge.get("to") or "")
            if not nxt:
                continue
            nd = depth + 1
            if nxt in best_depth and best_depth[nxt] <= nd:
                continue
            best_depth[nxt] = nd
            queue.append((nxt, nd))
    distance: Dict[str, int] = {}
    for node_id, depth in best_depth.items():
        node = nodes_by_id.get(node_id)
        if not node or not node.get("path"):
            continue
        path = str(node["path"])
        if path not in distance or depth < distance[path]:
            distance[path] = depth
    return distance


def _candidate_id_for_result(item: Dict[str, Any]) -> str:
    """Match the compiler's candidate-id derivation for a retrieval result."""
    for field in ("chunkId", "sourceId", "citation", "path"):
        value = item.get(field)
        if value:
            return str(value)
    return "candidate:unknown"


def tokenize(text: str) -> List[str]:
    return re.findall(r"[a-z0-9_.-]+/[a-z0-9_./-]+|[#]?\d+|[a-z][a-z0-9_-]*|[a-z0-9_.-]+", text.lower())


def unique(values: List[str]) -> List[str]:
    seen: Set[str] = set()
    result: List[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def issue_refs(text: str) -> List[int]:
    refs: Set[int] = set()
    for match in re.finditer(r"(?:^|[^A-Za-z])#(\d+)\b", text):
        prefix = text[: match.start() + len(match.group(0)) - len(match.group(1)) - 1]
        if re.search(r"(?:^|\b)(?:pr|pull\s+request)\s*$", prefix, re.IGNORECASE):
            continue
        refs.add(int(match.group(1)))
    refs.update(int(match.group(1)) for match in re.finditer(r"/issues/(\d+)\b", text))
    return sorted(refs)


def pr_refs(text: str) -> List[int]:
    refs = {int(match.group(1)) for match in re.finditer(r"/pull/(\d+)\b", text)}
    refs.update(int(match.group(1)) for match in re.finditer(r"\bpr\s*#?(\d+)\b", text, re.IGNORECASE))
    refs.update(int(match.group(1)) for match in re.finditer(r"\bpull\s+request\s*#?(\d+)\b", text, re.IGNORECASE))
    return sorted(refs)


def score_authority(record: Dict[str, Any]) -> float:
    if record.get("authority") == "critical":
        return 0.45
    if record.get("authority") == "high":
        return 0.3
    return 0.0


def authority_demotion(record: Dict[str, Any]) -> float:
    if record.get("authority") == "low":
        return 0.45
    if record.get("authority") == "denied":
        return 999.0
    return 0.0


def memory_freshness(memory: Optional[Dict[str, Any]]) -> Tuple[float, List[str]]:
    if not memory:
        return 0.0, []
    demotion = 0.0
    reasons: List[str] = []
    now = datetime.now(timezone.utc).timestamp()
    if memory.get("expires_at"):
        try:
            expires = datetime.fromisoformat(str(memory["expires_at"]).replace("Z", "+00:00")).timestamp()
            if expires < now:
                demotion += 1.5
                reasons.append("expired memory")
        except Exception:
            pass
    if memory.get("created_at"):
        try:
            created = datetime.fromisoformat(str(memory["created_at"]).replace("Z", "+00:00")).timestamp()
            if created < now - 180 * 24 * 60 * 60:
                demotion += 0.4
                reasons.append("stale memory")
        except Exception:
            pass
    if str(memory.get("confidence", "")).lower() == "low":
        demotion += 0.25
        reasons.append("low-confidence memory")
    return demotion, reasons


def freshness_demotion(record: Dict[str, Any], chunk: Optional[Dict[str, Any]]) -> Tuple[float, List[str]]:
    status = str(record.get("freshness", {}).get("status", "current")).lower()
    demotion = 0.0
    reasons: List[str] = []
    if status == "expired":
        demotion += 1.5
        reasons.append("expired source")
    elif status == "stale":
        demotion += 0.75
        reasons.append("stale source")
    elif status == "unknown":
        demotion += 0.15
        reasons.append("unknown freshness")
    memory_demotion, memory_reasons = memory_freshness((chunk or {}).get("memory") or record.get("memory"))
    return demotion + memory_demotion, reasons + memory_reasons


def prior_mistake_demotion(prior_mistake: Optional[Dict[str, Any]], effective_issue_refs: List[int]) -> Tuple[float, List[str]]:
    if not prior_mistake:
        return 0.0, []
    issue = prior_mistake.get("issue")
    same_issue = isinstance(issue, int) and issue in effective_issue_refs
    status = str(prior_mistake.get("status") or "").lower()
    if same_issue:
        return 0.0, []
    if status in {"stale", "expired"}:
        return 1.25, ["stale prior mistake"]
    if status in {"resolved", "closed", "done", "fixed", "merged"}:
        return 1.5, ["resolved prior mistake"]
    if isinstance(issue, int):
        return 2.0, ["unrelated prior mistake"]
    return 0.0, []


def record_text(source: Dict[str, Any], chunk: Optional[Dict[str, Any]]) -> str:
    return "\n".join([
        str(source.get("path", "")),
        str(source.get("id", "")),
        str(source.get("sourceType", "")),
        str(source.get("authority", "")),
        str((chunk or {}).get("content") or source.get("content") or ""),
        str((chunk or {}).get("citation", "")),
        str((chunk or {}).get("parentContext", "")),
        json.dumps((chunk or {}).get("headingPath", [])),
        json.dumps((chunk or {}).get("symbolHints", [])),
        json.dumps((chunk or {}).get("importHints", [])),
        json.dumps((chunk or {}).get("priorMistake") or source.get("priorMistake") or {}),
        json.dumps(source.get("linkedIssues", [])),
        json.dumps(source.get("linkedPullRequests", [])),
    ])


def reciprocal_rank(rank: int) -> float:
    return 1 / (60 + rank) if rank > 0 else 0.0


def build_reason(parts: Set[str]) -> str:
    ordered = ["deterministic required context", "active workflow state", "same issue prior failure", "prior mistake", "linked issue", "linked pull request", "symbol definition", "exact identifier", "exact path", "lesson target", "graph expansion", "BM25 keyword match", "embedding similarity", "high authority source", "current memory", "stale memory", "expired memory", "stale prior mistake", "resolved prior mistake", "unrelated prior mistake", "low authority source"]
    return "; ".join(item for item in ordered if item in parts) or "Included by hybrid retrieval score."


def bounded_content(source: Dict[str, Any], chunk: Optional[Dict[str, Any]]) -> Any:
    """Return full chunk/source content without truncation.

    Token-budget enforcement happens in packs.py via greedy budget fill, which
    drops entire low-relevance candidates instead of mutilating high-value ones.
    """
    return (chunk or {}).get("content") if chunk else source.get("content")


def estimate_tokens(text: str) -> int:
    """Rough shared token estimator (chars / 4) used across compact retrieval."""
    return (len(text) + 3) // 4


# Token budget for run-level retrieval and context packs. The same budget is
# recorded in pack retrievalBudget metadata and pushed as token_budget telemetry.
RETRIEVAL_MAX_TOKENS = 6000


def compute_tokens_saved(root: Path, items: Iterable[Dict[str, Any]]) -> int:
    """Estimated tokens saved by bounded retrieval versus reading whole files.

    For each distinct file path among the selected items, compares the
    full-file token estimate (ceil(chars/4)) against the tokens actually used
    by the bounded snippets selected from that file (summed when several
    snippets come from one file; the full file is counted once). Items whose
    path cannot be read under ``root`` (memory entries, deleted files, binary
    content) contribute nothing. Each file's saving is clamped at >= 0, so the
    result is always >= 0.
    """
    root = root.resolve()
    used_by_path: Dict[str, int] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        path = item.get("path")
        if not isinstance(path, str) or not path:
            continue
        content = item.get("content")
        if isinstance(content, str):
            used = estimate_tokens(content)
        else:
            token_estimate = item.get("tokenEstimate")
            is_number = isinstance(token_estimate, (int, float)) and not isinstance(token_estimate, bool)
            used = int(token_estimate) if is_number else 0
        used_by_path[path] = used_by_path.get(path, 0) + used
    saved = 0
    for path, used in used_by_path.items():
        try:
            file_path = (root / path).resolve()
            if root not in file_path.parents and file_path != root:
                continue
            full = estimate_tokens(file_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, ValueError):
            continue
        saved += max(0, full - used)
    return saved


def get_file_lines(target_dir: Path, path: str, line_start: int, line_end: int) -> Dict[str, Any]:
    """Return only the requested inclusive line range of a file, never the whole file.

    Line numbers are 1-based and clamped to the file bounds.
    """
    root = target_dir.resolve()
    file_path = (root / path).resolve()
    if root not in file_path.parents and file_path != root:
        raise SystemExit(f"context get path escapes target directory: {path}")
    if not file_path.is_file():
        raise SystemExit(f"context get file not found: {path}")
    lines = file_path.read_text(encoding="utf-8").splitlines()
    total = len(lines)
    start = max(1, int(line_start))
    end = min(total, int(line_end))
    if end < start:
        end = start
    selected = lines[start - 1:end]
    content = "\n".join(selected)
    return {
        "command": "context.get",
        "path": path,
        "lineStart": start,
        "lineEnd": end,
        "totalLines": total,
        "content": content,
        "tokenEstimate": estimate_tokens(content),
    }


def context_def(root: Path, name: str, *, index: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Look up symbol NAME in index.json symbolTable (O(1)).

    Returns house-schema items for all matching definitions.  Multi-definition
    aware: all matches are returned (same name, multiple files).  Entries with
    ``authority: "denied"`` are excluded.  Returns an empty list when the symbol
    is unknown or the index has no symbolTable.

    Pass ``index=`` to skip the disk read (daemon warm path).
    """
    if index is None:
        index = load_index(root)
    records = index.get("symbolTable", {}).get(name, [])
    results: List[Dict[str, Any]] = []
    for rec in records:
        if rec.get("authority") == "denied":
            continue
        path = rec.get("path", "")
        line_start = int(rec.get("lineStart", 1))
        line_end = int(rec.get("lineEnd", line_start))
        citation = rec.get("citation") or f"{path}:{line_start}"
        try:
            file_info = get_file_lines(root, path, line_start, line_end)
            content = file_info["content"]
            token_estimate = file_info["tokenEstimate"]
        except SystemExit:
            content = ""
            token_estimate = estimate_tokens(content)
        results.append({
            "path": path,
            "lineStart": line_start,
            "lineEnd": line_end,
            "content": content,
            "citation": citation,
            "reason": "symbol definition",
            "score": 1.0,
            "tokenEstimate": token_estimate,
            "deterministic": True,
            "kind": rec.get("kind", "symbol"),
        })
    return results


def context_callers(root: Path, name: str, *, index: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Return house-schema items for every distinct call site that invokes NAME.

    Traverses ``calls`` graph edges where ``to`` resolves to a symbol node
    for NAME.  One item per distinct ``(callerPath, callerLine)`` call site.
    Denied-authority sources are excluded.  Returns [] when NAME has no
    inbound edges or is unknown.

    Pass ``index=`` to skip the disk read (daemon warm path).
    """
    if index is None:
        index = load_index(root)
    graph = index.get("graph", {})

    # Build denied-path set from symbolTable authority records (belt-and-suspenders;
    # graph build already excludes denied edges).
    denied_paths: Set[str] = set()
    for sym_records in index.get("symbolTable", {}).values():
        for rec in sym_records:
            if rec.get("authority") == "denied":
                denied_paths.add(str(rec.get("path", "")))

    # Get symbol node IDs for NAME (O(1) via pre-built map).
    symbol_node_map = _build_symbol_node_map(index)
    target_node_ids: Set[str] = {
        str(entry["id"])
        for entry in symbol_node_map.get(name, [])
        if entry.get("id")
    }
    if not target_node_ids:
        return []

    seen: Set[Tuple[str, int]] = set()
    results: List[Dict[str, Any]] = []

    for edge in graph.get("edges", []):
        if not isinstance(edge, dict) or edge.get("kind") != "calls":
            continue
        if not edge.get("resolved"):
            continue
        to_id = edge.get("to")
        if to_id is None or str(to_id) not in target_node_ids:
            continue

        caller_path = str(edge.get("callerPath", ""))
        caller_line = int(edge.get("callerLine", 0))
        if not caller_path or not caller_line:
            continue

        if caller_path in denied_paths:
            continue

        key: Tuple[str, int] = (caller_path, caller_line)
        if key in seen:
            continue
        seen.add(key)

        citation = f"{caller_path}:{caller_line}"
        try:
            file_info = get_file_lines(root, caller_path, caller_line, caller_line)
            content = file_info["content"]
            token_estimate = file_info["tokenEstimate"]
        except SystemExit:
            content = ""
            token_estimate = estimate_tokens(content)

        results.append({
            "path": caller_path,
            "lineStart": caller_line,
            "lineEnd": caller_line,
            "content": content,
            "citation": citation,
            "reason": f"calls {name}",
            "score": 1.0,
            "tokenEstimate": token_estimate,
            "deterministic": True,
            "callerPath": caller_path,
            "callerLine": caller_line,
        })

    return results


def context_callees(root: Path, name: str, *, index: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Return house-schema items for every symbol NAME calls.

    Traverses ``calls`` graph edges where ``from`` resolves to a symbol node
    for NAME.  Resolved callees become house-schema items for the callee
    definition.  Unresolved stubs are always included with ``resolved: false``
    and ``unresolvedReason``.  Resolved items from denied-authority sources
    are excluded.  Returns [] when NAME has no outbound edges or is unknown.

    Pass ``index=`` to skip the disk read (daemon warm path).
    """
    if index is None:
        index = load_index(root)
    graph = index.get("graph", {})
    symbol_table = index.get("symbolTable", {})

    # Build denied-path set.
    denied_paths: Set[str] = set()
    for sym_records in symbol_table.values():
        for rec in sym_records:
            if rec.get("authority") == "denied":
                denied_paths.add(str(rec.get("path", "")))

    # Build node_id → node map for symbol nodes.
    node_map: Dict[str, Dict[str, Any]] = {}
    for node in graph.get("nodes", []):
        if isinstance(node, dict) and node.get("id"):
            node_map[str(node["id"])] = node

    # Get symbol node IDs for NAME (O(1) via pre-built map).
    symbol_node_map = _build_symbol_node_map(index)
    from_node_ids: Set[str] = {
        str(entry["id"])
        for entry in symbol_node_map.get(name, [])
        if entry.get("id")
    }
    if not from_node_ids:
        return []

    seen_resolved: Set[str] = set()  # keyed by to-node ID
    seen_unresolved: Set[Tuple[str, str]] = set()  # keyed by (callee, reason)
    results: List[Dict[str, Any]] = []

    for edge in graph.get("edges", []):
        if not isinstance(edge, dict) or edge.get("kind") != "calls":
            continue
        from_id = edge.get("from")
        if from_id is None or str(from_id) not in from_node_ids:
            continue

        if edge.get("resolved"):
            to_id = edge.get("to")
            if to_id is None:
                continue
            to_id_str = str(to_id)
            if to_id_str in seen_resolved:
                continue
            seen_resolved.add(to_id_str)

            to_node = node_map.get(to_id_str)
            if not to_node:
                continue
            callee_path = str(to_node.get("path", ""))
            callee_line = int(to_node.get("line", 0))

            if callee_path in denied_paths:
                continue

            # Resolve lineEnd from symbolTable by matching (path, lineStart).
            callee_name = str(to_node.get("name", ""))
            line_end = callee_line
            citation = f"{callee_path}:{callee_line}"
            for rec in symbol_table.get(callee_name, []):
                if (rec.get("path") == callee_path
                        and int(rec.get("lineStart", 0)) == callee_line):
                    line_end = int(rec.get("lineEnd", callee_line))
                    citation = rec.get("citation") or citation
                    break

            try:
                file_info = get_file_lines(root, callee_path, callee_line, line_end)
                content = file_info["content"]
                token_estimate = file_info["tokenEstimate"]
            except SystemExit:
                content = ""
                token_estimate = estimate_tokens(content)

            results.append({
                "path": callee_path,
                "lineStart": callee_line,
                "lineEnd": line_end,
                "content": content,
                "citation": citation,
                "reason": f"called by {name}",
                "score": 1.0,
                "tokenEstimate": token_estimate,
                "deterministic": True,
                "resolved": True,
            })
        else:
            # Unresolved stub — always included regardless of source authority.
            callee_sym = str(edge.get("callee", ""))
            unresolved_reason = str(edge.get("unresolvedReason", ""))
            key_u: Tuple[str, str] = (callee_sym, unresolved_reason)
            if key_u in seen_unresolved:
                continue
            seen_unresolved.add(key_u)

            citation = f"unresolved:{callee_sym}" if callee_sym else "unresolved"
            results.append({
                "path": "",
                "lineStart": 0,
                "lineEnd": 0,
                "content": "",
                "citation": citation,
                "reason": unresolved_reason or "unresolved",
                "score": 1.0,
                "tokenEstimate": 0,
                "deterministic": True,
                "resolved": False,
                "unresolvedReason": unresolved_reason,
            })

    return results


def _bfs_transitive_callers(
    graph: Dict[str, Any],
    start_node_ids: Set[str],
    max_depth: int,
) -> Set[str]:
    """BFS over inbound ``calls`` edges starting from ``start_node_ids``.

    Builds a ``to → [from, ...]`` adjacency map from resolved ``calls`` edges,
    then walks up to ``max_depth`` hops collecting all reached caller node IDs.
    The seed nodes themselves are NOT included in the returned set.

    Returns an empty set when there are no inbound calls edges or start_node_ids
    is empty.
    """
    # Build to → [from] adjacency for resolved calls edges.
    inbound: Dict[str, List[str]] = {}
    for edge in graph.get("edges", []):
        if not isinstance(edge, dict) or edge.get("kind") != "calls":
            continue
        if not edge.get("resolved"):
            continue
        to_id = edge.get("to")
        from_id = edge.get("from")
        if to_id is None or from_id is None:
            continue
        inbound.setdefault(str(to_id), []).append(str(from_id))

    visited: Set[str] = set()
    frontier: Set[str] = set(start_node_ids)
    for _depth in range(max_depth):
        next_frontier: Set[str] = set()
        for node_id in frontier:
            for caller_id in inbound.get(node_id, []):
                if caller_id not in visited and caller_id not in start_node_ids:
                    next_frontier.add(caller_id)
        if not next_frontier:
            break
        visited.update(next_frontier)
        frontier = next_frontier

    return visited


def context_impact(root: Path, name: str, depth: int = 3, *, index: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Return house-schema items for the blast radius of NAME.

    Performs BFS over inbound ``calls`` edges from NAME's symbol node(s) up to
    ``depth`` hops (default 3), then expands the affected file set by following
    ``tests_source`` edges (test files linked to affected source files) and
    ``imports_file`` edges (files that import affected paths).

    Denied-authority sources are excluded.  Returns ``[]`` (not an error) when
    NAME has no symbol nodes or no callers/tests/importers.

    Pass ``index=`` to skip the disk read (daemon warm path).
    """
    if index is None:
        index = load_index(root)
    graph = index.get("graph", {})

    # Build denied-path set from symbolTable authority records.
    denied_paths: Set[str] = set()
    for sym_records in index.get("symbolTable", {}).values():
        for rec in sym_records:
            if rec.get("authority") == "denied":
                denied_paths.add(str(rec.get("path", "")))

    # Resolve NAME's symbol node IDs (O(1) via pre-built map).
    symbol_node_map = _build_symbol_node_map(index)
    seed_node_ids: Set[str] = {
        str(entry["id"])
        for entry in symbol_node_map.get(name, [])
        if entry.get("id")
    }
    if not seed_node_ids:
        return []

    # Build node_id → node dict for all nodes.
    node_map: Dict[str, Dict[str, Any]] = {}
    for node in graph.get("nodes", []):
        if isinstance(node, dict) and node.get("id"):
            node_map[str(node["id"])] = node

    # Collect seed def file paths (NAME's own definition files).
    seed_paths: Set[str] = set()
    for node_id in seed_node_ids:
        node = node_map.get(node_id)
        if node and node.get("path"):
            seed_paths.add(str(node["path"]))

    # BFS to collect transitive caller node IDs.
    caller_node_ids = _bfs_transitive_callers(graph, seed_node_ids, max_depth=depth)

    # Affected file paths = seed definition files + files containing caller nodes.
    affected_paths: Set[str] = set(seed_paths)
    for caller_id in caller_node_ids:
        caller_node = node_map.get(caller_id)
        if caller_node and caller_node.get("path"):
            affected_paths.add(str(caller_node["path"]))

    results: List[Dict[str, Any]] = []
    seen: Set[Tuple[str, int, str]] = set()  # (path, line, category)

    def _add_item(path: str, line_start: int, line_end: int, reason: str, category: str, extra: Dict[str, Any] | None = None) -> None:
        if path in denied_paths:
            return
        key: Tuple[str, int, str] = (path, line_start, category)
        if key in seen:
            return
        seen.add(key)
        citation = f"{path}:{line_start}" if line_start else path
        try:
            file_info = get_file_lines(root, path, line_start or 1, line_end or 1)
            content = file_info["content"]
            token_estimate = file_info["tokenEstimate"]
        except SystemExit:
            content = ""
            token_estimate = estimate_tokens(content)
        item: Dict[str, Any] = {
            "path": path,
            "lineStart": line_start,
            "lineEnd": line_end,
            "content": content,
            "citation": citation,
            "reason": reason,
            "score": 1.0,
            "tokenEstimate": token_estimate,
            "deterministic": True,
        }
        if extra:
            item.update(extra)
        results.append(item)

    # 1. Transitive caller nodes — one item per caller call site.
    #    Mirror context_callers: emit (callerPath, callerLine) for each resolved edge
    #    whose `from` is in caller_node_ids.
    caller_seen: Set[Tuple[str, int]] = set()
    for edge in graph.get("edges", []):
        if not isinstance(edge, dict) or edge.get("kind") != "calls":
            continue
        if not edge.get("resolved"):
            continue
        from_id = edge.get("from")
        if from_id is None or str(from_id) not in caller_node_ids:
            continue
        # Also include edges where `from` is a seed node calling something else
        # (seed's own call sites are not the blast radius — skip seed-from edges).
        caller_path = str(edge.get("callerPath", ""))
        caller_line = int(edge.get("callerLine", 0))
        if not caller_path or not caller_line:
            continue
        site_key = (caller_path, caller_line)
        if site_key in caller_seen:
            continue
        caller_seen.add(site_key)
        if caller_path in denied_paths:
            continue
        key3: Tuple[str, int, str] = (caller_path, caller_line, "caller")
        if key3 in seen:
            continue
        seen.add(key3)
        citation = f"{caller_path}:{caller_line}"
        try:
            file_info = get_file_lines(root, caller_path, caller_line, caller_line)
            content = file_info["content"]
            token_estimate = file_info["tokenEstimate"]
        except SystemExit:
            content = ""
            token_estimate = estimate_tokens(content)
        results.append({
            "path": caller_path,
            "lineStart": caller_line,
            "lineEnd": caller_line,
            "content": content,
            "citation": citation,
            "reason": f"transitive caller of {name}",
            "score": 1.0,
            "tokenEstimate": token_estimate,
            "deterministic": True,
            "callerPath": caller_path,
            "callerLine": caller_line,
        })

    # 2. Test files reachable via tests_source edges from affected paths.
    for edge in graph.get("edges", []):
        if not isinstance(edge, dict) or edge.get("kind") != "tests_source":
            continue
        target_path = str(edge.get("targetPath", ""))
        if target_path not in affected_paths:
            continue
        test_path = str(edge.get("path", ""))
        if not test_path:
            continue
        _add_item(test_path, 1, 1, f"tests source affected by {name}", "test")

    # 3. Files reachable via imports_file edges from affected paths.
    for edge in graph.get("edges", []):
        if not isinstance(edge, dict) or edge.get("kind") != "imports_file":
            continue
        target_path = str(edge.get("targetPath", ""))
        if target_path not in affected_paths:
            continue
        importer_path = str(edge.get("path", ""))
        if not importer_path:
            continue
        _add_item(importer_path, 1, 1, f"imports path affected by {name}", "import")

    return results


def get_file_symbol(target_dir: Path, path: str, symbol: str) -> Dict[str, Any]:
    """Return only the line range of a named symbol in a file, never the whole file."""
    from agentrail.context.index import extracted_symbols

    root = target_dir.resolve()
    file_path = (root / path).resolve()
    if not file_path.is_file():
        raise SystemExit(f"context get file not found: {path}")
    text = file_path.read_text(encoding="utf-8")
    symbols = extracted_symbols(text, path)
    total = len(text.splitlines())
    name = _normalized_anchor_symbol(symbol)
    for i, sym in enumerate(symbols):
        if sym.get("name") != name:
            continue
        start_line = int(sym["line"])
        end_line = symbols[i + 1]["line"] - 1 if i + 1 < len(symbols) else total
        result = get_file_lines(root, path, start_line, end_line)
        result["symbol"] = name
        return result
    raise SystemExit(f"context get symbol not found in {path}: {symbol}")


def cosine_similarity(a: List[float], b: List[float]) -> float:
    if not a or len(a) != len(b):
        return 0.0
    dot = sum(left * right for left, right in zip(a, b))
    left_norm = math.sqrt(sum(left * left for left in a))
    right_norm = math.sqrt(sum(right * right for right in b))
    return dot / (left_norm * right_norm) if left_norm and right_norm else 0.0


def _normalized_anchor_symbol(value: str) -> str:
    return value.strip().removesuffix("()")


def _anchor_path(value: str) -> str:
    return value.split("::", 1)[0].strip()


# Edge kinds that must NEVER be traversed at query time. Currently just
# unit_depends_on: the Repo Wiki spec's deterministic unit-grain dependency
# rollup (aggregated from imports_file edges -- see _unit_depends_on_edges in
# index.py). It exists for wiki-skeleton rendering ("Depends on: X. Depended
# on by: Y"), not for BFS expansion or ranking -- traversing it would let a
# single cross-unit import fan a query out to every file in a dependent unit.
# Excluded here (the shared adjacency builder both graph_expansion_for_query
# and _graph_distance_by_path call) AND, redundantly, inside
# _graph_distance_by_path's own BFS loop, so a future refactor that stops
# routing through this builder cannot silently reintroduce it into ranking.
_QUERY_TIME_EXCLUDED_EDGE_KINDS: frozenset[str] = frozenset({"unit_depends_on"})


def _graph_neighbors(graph: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    neighbors: Dict[str, List[Dict[str, Any]]] = {}
    for edge in graph.get("edges", []):
        if not isinstance(edge, dict):
            continue
        if edge.get("kind") in _QUERY_TIME_EXCLUDED_EDGE_KINDS:
            continue
        left = edge.get("from")
        right = edge.get("to")
        if not left or not right:
            continue
        neighbors.setdefault(str(left), []).append(edge)
        reverse = dict(edge)
        reverse["from"], reverse["to"] = right, left
        reverse["reversed"] = True
        neighbors.setdefault(str(right), []).append(reverse)
    return neighbors


_SYMBOL_NODE_MAP_CACHE_KEY = "_agentrail_symbol_node_map"


def _build_symbol_node_map(index: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    """Build a name → [graph node dict, ...] map via symbolTable (O(1) per name).

    The map is cached on the index dict so it is built at most once per loaded
    index object.  Each graph node dict has at minimum an ``id`` key.

    Fall back to an empty dict — callers must then do their own linear scan —
    when the index lacks a ``symbolTable`` key (schemaVersion 1).
    """
    cached = index.get(_SYMBOL_NODE_MAP_CACHE_KEY)
    if cached is not None:
        return cached  # type: ignore[return-value]

    # Build (path, line) → node_id from the graph symbol nodes.
    path_line_to_node_id: Dict[Tuple[str, int], str] = {}
    for node in index.get("graph", {}).get("nodes", []):
        if not isinstance(node, dict):
            continue
        if node.get("kind") == "symbol" and node.get("id"):
            key = (str(node.get("path", "")), int(node.get("line", 0)))
            path_line_to_node_id[key] = str(node["id"])

    # Map symbol name → list of matching graph node dicts via symbolTable.
    result: Dict[str, List[Dict[str, Any]]] = {}
    for sym_name, sym_records in index.get("symbolTable", {}).items():
        node_dicts: List[Dict[str, Any]] = []
        for rec in sym_records:
            key = (str(rec.get("path", "")), int(rec.get("lineStart", 0)))
            node_id = path_line_to_node_id.get(key)
            if node_id:
                node_dicts.append({"id": node_id})
        if node_dicts:
            result[str(sym_name)] = node_dicts

    index[_SYMBOL_NODE_MAP_CACHE_KEY] = result
    return result


def _anchor_start_nodes(index: Dict[str, Any], anchors: List[Dict[str, str]]) -> Tuple[List[str], List[Dict[str, Any]]]:
    nodes = [node for node in index.get("graph", {}).get("nodes", []) if isinstance(node, dict)]
    starts: List[str] = []
    started_from: List[Dict[str, Any]] = []
    for anchor in anchors:
        kind = anchor.get("kind")
        value = anchor.get("normalized") or anchor.get("value") or ""
        matches: List[Dict[str, Any]] = []
        if kind in {"path", "test"}:
            path = _anchor_path(value)
            matches = [node for node in nodes if node.get("path") == path and node.get("kind") in {"file", "test", "chunk", "symbol"}]
        elif kind == "symbol":
            symbol = _normalized_anchor_symbol(value)
            if "symbolTable" in index:
                # O(1) lookup via pre-built symbol→node map.
                symbol_node_map = _build_symbol_node_map(index)
                matches = symbol_node_map.get(symbol, [])
            else:
                # schemaVersion 1 fallback: linear scan over all graph nodes.
                matches = [node for node in nodes if node.get("kind") == "symbol" and node.get("name") == symbol]
        if not matches:
            continue
        node_ids = [str(node["id"]) for node in matches if node.get("id")]
        starts.extend(node_ids)
        started_from.append({"anchor": anchor, "nodeIds": node_ids})
    return unique(starts), started_from


def _retrieval_seed_start_nodes(index: Dict[str, Any], seed_paths: List[str]) -> List[str]:
    """Map retrieval seed paths to graph chunk-node IDs for BFS seeding.

    Chunk nodes are used (not file nodes) to preserve the max_hops=2 budget.
    A file node at depth-0 reaches the codebase-unit node at depth-1 and then
    all project files at depth-2, flooding graph_paths.  A chunk node at depth-0
    reaches the file node at depth-1 and the codebase-unit at depth-2, so
    codebase-unit children are only reachable at depth-3 and are rejected.
    """
    if not seed_paths:
        return []
    nodes = [node for node in index.get("graph", {}).get("nodes", []) if isinstance(node, dict)]
    seed_node_ids: List[str] = []
    for path in seed_paths:
        for node in nodes:
            if node.get("path") == path and node.get("kind") == "chunk":
                node_id = str(node.get("id", ""))
                if node_id and node_id not in seed_node_ids:
                    seed_node_ids.append(node_id)
    return seed_node_ids


# Keywords that indicate a relational query (callers, callees, call graph traversal).
# When these appear in the query, `calls` edges are included in the BFS traversal.
# Non-relational queries exclude `calls` edges to prevent noise fan-out.
_RELATIONAL_CALL_KEYWORDS: frozenset[str] = frozenset({
    "callers", "callees", "calls", "depends", "impact",
})


def _is_relational_call_query(query: str) -> bool:
    """Return True when the query contains a relational keyword for call-graph traversal."""
    ql = query.lower()
    return any(kw in ql for kw in _RELATIONAL_CALL_KEYWORDS)


def graph_expansion_for_query(index: Dict[str, Any], query: str, root: Path, *, max_hops: int = 2, retrieval_seeds: Optional[List[str]] = None) -> Dict[str, Any]:
    """Expand the code graph starting from anchor-matched nodes and, optionally,
    hybrid-retrieval seed paths (top-K BM25 candidates).

    ``retrieval_seeds`` is a list of file paths from the BM25 pre-score pass.
    A maximum of 5 seeds is recommended to prevent hop fanout.

    ``calls`` edges are only traversed when the query contains a relational keyword
    (callers, callees, calls, depends, impact).  This prevents call-graph fan-out
    on non-relational queries while keeping ``calls`` edges available for BFS
    seeding on targeted relationship queries (AC5).

    ``_QUERY_TIME_EXCLUDED_EDGE_KINDS`` (``unit_depends_on``, the Repo Wiki
    rollup) is never traversed regardless of query content -- unlike
    ``calls``, there is no query shape where unit-grain rollup edges should
    reach retrieval ranking or candidate expansion.
    """
    anchors = extract_anchors(query, root=root)
    anchor_start_nodes, started_from = _anchor_start_nodes(index, anchors)
    seed_start_nodes = _retrieval_seed_start_nodes(index, retrieval_seeds or [])
    start_nodes = unique(anchor_start_nodes + seed_start_nodes)
    graph = index.get("graph") if isinstance(index.get("graph"), dict) else {}
    neighbors = _graph_neighbors(graph)
    relational = _is_relational_call_query(query)
    queue: List[Tuple[str, int, List[str]]] = [(node_id, 0, []) for node_id in start_nodes]
    best_depth: Dict[str, int] = {node_id: 0 for node_id in start_nodes}
    visited: List[Dict[str, Any]] = []
    expanded_node_ids: Set[str] = set(start_nodes)
    rejected: List[Dict[str, Any]] = []
    while queue:
        node_id, depth, path = queue.pop(0)
        visited.append({"nodeId": node_id, "depth": depth, "path": path})
        if depth >= max_hops:
            continue
        for edge in neighbors.get(node_id, []):
            # Gate calls edges: only traverse them on relational queries (AC5).
            if edge.get("kind") == "calls" and not relational:
                continue
            # Redundant, explicit guard (defense-in-depth): _graph_neighbors
            # already strips _QUERY_TIME_EXCLUDED_EDGE_KINDS (unit_depends_on),
            # checked again here so this traversal can never regress silently.
            if edge.get("kind") in _QUERY_TIME_EXCLUDED_EDGE_KINDS:
                continue
            next_node = str(edge.get("to") or "")
            if not next_node:
                continue
            next_depth = depth + 1
            if next_depth > max_hops:
                rejected.append({"nodeId": next_node, "reason": "hop_limit", "edgeId": edge.get("id")})
                continue
            if next_node in best_depth and best_depth[next_node] <= next_depth:
                continue
            best_depth[next_node] = next_depth
            expanded_node_ids.add(next_node)
            queue.append((next_node, next_depth, [*path, str(edge.get("id") or edge.get("kind") or "edge")]))
    nodes_by_id = {str(node.get("id")): node for node in graph.get("nodes", []) if isinstance(node, dict) and node.get("id")}
    source_ids: Set[str] = set()
    paths: Set[str] = set()
    chunk_ids: Set[str] = set()
    for node_id in expanded_node_ids:
        node = nodes_by_id.get(node_id)
        if not node:
            continue
        if node.get("sourceId"):
            source_ids.add(str(node["sourceId"]))
        if node.get("path"):
            paths.add(str(node["path"]))
        if node.get("chunkId"):
            chunk_ids.add(str(node["chunkId"]))
    added_candidate_ids = sorted(source_ids | paths | chunk_ids)
    return {
        "status": "expanded" if start_nodes else "no_strong_anchors",
        "maxHops": max_hops,
        "startedFromAnchors": started_from,
        "startedFromRetrievalSeeds": list(retrieval_seeds or []),
        "visited": visited,
        "addedCandidateIds": added_candidate_ids,
        "rejected": rejected,
        "sourceIds": sorted(source_ids),
        "paths": sorted(paths),
        "chunkIds": sorted(chunk_ids),
        "candidatePolicy": [],
        "excludedExpansionCandidates": [],
        "demotedExpansionCandidates": [],
    }


def apply_graph_expansion_policy(index: Dict[str, Any], graph_expansion: Dict[str, Any]) -> Dict[str, Any]:
    sources = {record["id"]: record for record in index.get("records", []) if isinstance(record, dict) and record.get("id")}
    chunks = {chunk["id"]: chunk for chunk in index.get("chunks", []) if isinstance(chunk, dict) and chunk.get("id")}
    graph_source_ids = set(graph_expansion.get("sourceIds") or [])
    graph_paths = set(graph_expansion.get("paths") or [])
    graph_chunk_ids = set(graph_expansion.get("chunkIds") or [])
    policy_items: List[Dict[str, Any]] = []

    def add_policy(source: Dict[str, Any], chunk: Optional[Dict[str, Any]], candidate_id: str) -> None:
        freshness_penalty, freshness_reasons = freshness_demotion(source, chunk)
        freshness = str(source.get("freshness", {}).get("status", "current")).lower()
        authority = str(source.get("authority") or "unknown")
        visibility = str(source.get("visibility") or "unknown")
        if authority == "denied" or visibility == "denied":
            effect = "excluded"
            reason = "denied graph-expanded source"
        elif freshness in {"stale", "expired"} or freshness_penalty > 0:
            effect = "demoted"
            reason = "; ".join(freshness_reasons) or f"{freshness} graph-expanded source"
        else:
            effect = "allowed"
            reason = "graph-expanded candidate passed retrieval policy"
        policy_items.append(
            {
                "candidateId": candidate_id,
                "sourceId": source.get("id"),
                "chunkId": (chunk or {}).get("id"),
                "path": source.get("path"),
                "citation": (chunk or {}).get("citation") or source.get("path"),
                "effect": effect,
                "reason": reason,
                "policy": {
                    "visibility": visibility,
                    "authority": authority,
                    "freshness": freshness,
                    "freshnessDemotion": round(freshness_penalty, 6),
                    "sourceCustody": {
                        "mode": "metadata_only",
                        "fullSourceUploadAllowed": False,
                        "snippetUploadAllowed": False,
                        "reason": "Default enterprise mode does not upload full source code.",
                    },
                },
            }
        )

    for source_id in sorted(graph_source_ids):
        source = sources.get(source_id)
        if source:
            add_policy(source, None, source_id)
    for path in sorted(graph_paths):
        source = next((record for record in sources.values() if record.get("path") == path), None)
        if source:
            add_policy(source, None, path)
    for chunk_id in sorted(graph_chunk_ids):
        chunk = chunks.get(chunk_id)
        source = sources.get(str((chunk or {}).get("sourceId")))
        if source:
            add_policy(source, chunk, chunk_id)

    deduped: Dict[str, Dict[str, Any]] = {}
    for item in policy_items:
        key = str(item.get("candidateId") or item.get("path"))
        prior = deduped.get(key)
        if not prior or {"allowed": 0, "demoted": 1, "excluded": 2}[str(item["effect"])] > {"allowed": 0, "demoted": 1, "excluded": 2}[str(prior["effect"])]:
            deduped[key] = item
    graph_expansion["candidatePolicy"] = sorted(deduped.values(), key=lambda item: str(item.get("candidateId") or ""))
    graph_expansion["excludedExpansionCandidates"] = [item for item in graph_expansion["candidatePolicy"] if item.get("effect") == "excluded"]
    graph_expansion["demotedExpansionCandidates"] = [item for item in graph_expansion["candidatePolicy"] if item.get("effect") == "demoted"]
    return graph_expansion


def _load_postings(root: Path, index: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Load precomputed postings.json if it exists, is valid JSON, and matches the index builtAt.

    Returns a term-centric postings dict ``{term: [{id, tf}, ...]}`` on success,
    or ``None`` when the file is absent, malformed, schema-mismatched, or stale
    (different builtAt than the index).  Callers must fall back to tokenize() on None.
    """
    postings_path = root / ".agentrail" / "context" / "index" / "postings.json"
    try:
        data = json.loads(postings_path.read_text(encoding="utf-8"))
        if (
            data.get("version") == 1
            and "postings" in data
            and "builtAt" in data
            and data.get("builtAt") == index.get("builtAt")
        ):
            return data["postings"]
    except Exception:
        pass
    return None


def _pre_bm25_scores(corpus: List[Dict[str, Any]], query_tokens: List[str], doc_count: int, avg_len: float, doc_freq: Dict[str, int]) -> Dict[str, float]:
    """Compute a lightweight BM25 score for each corpus item for retrieval seed extraction.

    Only pure BM25 term frequency scoring is used here (no deterministic boosts),
    so the result is used solely to seed graph expansion with the top-K candidates.
    """
    scores: Dict[str, float] = {}
    for doc in corpus:
        chunk = doc["chunk"]
        source = doc["source"]
        item_id = str((chunk or {}).get("id") or source.get("id"))
        score = 0.0
        for token in query_tokens:
            tf = doc["termCounts"].get(token, 0)
            if tf:
                df = doc_freq.get(token, 0)
                idf = math.log(1 + (doc_count - df + 0.5) / (df + 0.5))
                score += idf * ((tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * (doc["tokenLen"] / avg_len))))
        scores[item_id] = score
    return scores


# Graph expansion only fires from high-confidence seeds: a candidate must score
# at least this fraction of the strongest BM25 score, otherwise weak lexical
# matches flood the code graph and tank precision-at-budget.
_SEED_CONFIDENCE_RATIO = 0.5
_LESSON_TARGET_BOOST = 3.0
_MAX_LESSON_TARGET_MEMORIES = 5
_MAX_LESSON_TARGET_PATHS = 8


def _extract_retrieval_seeds(corpus: List[Dict[str, Any]], pre_bm25: Dict[str, float], max_seeds: int = 5) -> List[str]:
    """Return up to max_seeds unique file paths from high-confidence BM25 candidates.

    Only candidates scoring at least ``_SEED_CONFIDENCE_RATIO`` of the top score
    seed graph expansion, so low-confidence matches never pull noisy neighbours
    into the context pack.
    """
    doc_by_id = {str((doc["chunk"] or {}).get("id") or doc["source"].get("id")): doc for doc in corpus}
    top_score = max(pre_bm25.values(), default=0.0)
    if top_score <= 0:
        return []
    threshold = top_score * _SEED_CONFIDENCE_RATIO
    seeds: List[str] = []
    for item_id, _score in sorted(pre_bm25.items(), key=lambda kv: kv[1], reverse=True):
        if _score < threshold or len(seeds) >= max_seeds:
            break
        doc = doc_by_id.get(item_id)
        if not doc:
            continue
        path = doc["source"].get("path")
        if path and path not in seeds:
            seeds.append(path)
    return seeds


def _lesson_target_hints(
    root: Path,
    index: Dict[str, Any],
    corpus: List[Dict[str, Any]],
    pre_bm25: Dict[str, float],
    effective_issue_refs: List[int],
    query_pr_refs: List[int],
) -> Dict[str, Any]:
    """Extract advisory source targets from current, relevant memory lessons.

    Memory is allowed to pre-target current source areas, but only when the
    memory itself is fresh/current. Stale or low-confidence lessons remain
    searchable evidence and never create source boosts.
    """
    eligible_sources = [
        record
        for record in index.get("records", [])
        if isinstance(record, dict)
        and record.get("sourceType") != "memory"
        and record.get("authority") != "denied"
        and record.get("visibility") != "denied"
        and str(record.get("freshness", {}).get("status", "current")).lower() == "current"
        and record.get("path")
    ]
    eligible_paths = [str(record["path"]) for record in eligible_sources]
    if not eligible_paths:
        return {"enabled": False, "lessonPaths": [], "targetPaths": []}

    target_paths: List[str] = []
    lesson_paths: List[str] = []
    memory_docs: List[Tuple[float, Dict[str, Any]]] = []
    for doc in corpus:
        source = doc["source"]
        chunk = doc["chunk"]
        if source.get("sourceType") != "memory":
            continue
        if source.get("authority") == "denied" or source.get("visibility") == "denied":
            continue
        freshness_penalty, _freshness_reasons = freshness_demotion(source, chunk)
        if freshness_penalty > 0:
            continue
        memory = (chunk or {}).get("memory") or source.get("memory") or {}
        if str(memory.get("confidence", "")).lower() == "low":
            continue
        item_id = str((chunk or {}).get("id") or source.get("id"))
        relevance = pre_bm25.get(item_id, 0.0)
        linked_issue = any(number in source.get("linkedIssues", []) for number in effective_issue_refs)
        linked_pr = any(number in source.get("linkedPullRequests", []) for number in query_pr_refs)
        if relevance <= 0 and not linked_issue and not linked_pr:
            continue
        memory_docs.append((relevance, doc))

    for _score, doc in sorted(memory_docs, key=lambda item: item[0], reverse=True)[:_MAX_LESSON_TARGET_MEMORIES]:
        source = doc["source"]
        memory_path = str(source.get("path") or "")
        if memory_path and memory_path not in lesson_paths:
            lesson_paths.append(memory_path)
        for anchor in extract_anchors(doc["text"], root=root, source="memory"):
            if anchor.get("kind") not in {"path", "test"}:
                continue
            anchor_path = _anchor_path(str(anchor.get("normalized") or anchor.get("value") or ""))
            if not anchor_path:
                continue
            prefix = anchor_path.rstrip("/")
            for source_path in eligible_paths:
                if source_path == anchor_path or (prefix and source_path.startswith(f"{prefix}/")):
                    if source_path not in target_paths:
                        target_paths.append(source_path)
                    break
            if len(target_paths) >= _MAX_LESSON_TARGET_PATHS:
                break
        if len(target_paths) >= _MAX_LESSON_TARGET_PATHS:
            break

    return {
        "enabled": bool(target_paths),
        "lessonPaths": lesson_paths,
        "targetPaths": target_paths,
    }


# Query-independent scoring corpus, cached per (root, index builtAt). A long-lived
# daemon process builds it once and reuses it across queries; a fresh CLI process
# builds it once. Invalidates automatically when the index is rebuilt (builtAt
# changes). Bounded to a few entries so re-indexing doesn't leak memory.
_corpus_cache: Dict[str, Any] = {}


def _prepare_corpus(root: Path, index: Dict[str, Any]):
    """Build (and cache) the query-independent scoring corpus for *index*.

    Returns ``(corpus, postings_by_id, precomputed_postings, doc_count, avg_len)``.
    The corpus (per-chunk text / textLower / termCounts / tokenLen) depends only
    on the index, never the query, so it is safe to cache and reuse — only
    per-query ``doc_freq`` and scoring are recomputed by the caller. This is the
    fix for warm-query latency: previously ``record_text``/lowercasing ran over
    every chunk on *every* query even with the index in memory.
    """
    cache_key = (
        f"{root}|{index.get('builtAt', '')}|"
        f"{len(index.get('chunks') or [])}|{len(index.get('records') or [])}"
    )
    cached = _corpus_cache.get(cache_key)
    if cached is not None:
        return cached

    sources = {record["id"]: record for record in index.get("records", [])}
    items = (
        [(sources.get(chunk.get("sourceId"), {}), chunk) for chunk in index.get("chunks", [])]
        if index.get("chunks")
        else [(record, None) for record in index.get("records", [])]
    )
    precomputed_postings = _load_postings(root, index)
    postings_by_id: Optional[Dict[str, Dict[str, int]]] = None
    if precomputed_postings is not None:
        postings_by_id = {}
        for _term, _entries in precomputed_postings.items():
            for _entry in _entries:
                _pid = str(_entry["id"])
                if _pid not in postings_by_id:
                    postings_by_id[_pid] = {}
                postings_by_id[_pid][_term] = int(_entry.get("tf", 0))
    corpus: List[Dict[str, Any]] = []
    for source, chunk in items:
        text = record_text(source, chunk)
        item_id = str((chunk or {}).get("id") or source.get("id"))
        if postings_by_id is not None:
            term_counts: Dict[str, int] = postings_by_id.get(item_id, {})
            token_len = sum(term_counts.values())
            tokens: List[str] = []
        else:
            tokens = tokenize(text)
            term_counts = {}
            for token in tokens:
                term_counts[token] = term_counts.get(token, 0) + 1
            token_len = len(tokens)
        corpus.append({"source": source, "chunk": chunk, "text": text, "textLower": text.lower(), "tokens": tokens, "termCounts": term_counts, "tokenLen": token_len})
    doc_count = max(1, len(corpus))
    avg_len = sum(doc["tokenLen"] for doc in corpus) / doc_count if corpus else 1

    result = (corpus, postings_by_id, precomputed_postings, doc_count, avg_len)
    if len(_corpus_cache) >= 4:  # bound memory across re-indexes
        _corpus_cache.pop(next(iter(_corpus_cache)))
    _corpus_cache[cache_key] = result
    return result


_PACK_CUTOFF_TRUTHY = {"1", "true", "on", "yes"}


def resolve_pack_cutoff(root: Path) -> Tuple[bool, float]:
    """Resolve the adaptive pack-tail cutoff (#1096): ``(enabled, min_score_ratio)``.

    Config is the product path (AC4): ``read_context_config(root).packCutoff``.  The
    ``AGENTRAIL_CONTEXT_PACK_CUTOFF`` env flag (truthy) additionally enables it and
    ``AGENTRAIL_CONTEXT_PACK_CUTOFF_RATIO`` overrides the ratio — this env toggle
    exists ONLY so the offline eval can run OFF-vs-ON in one process; it mirrors the
    LLM rerank layer's ``AGENTRAIL_CONTEXT_LLM_RERANK`` pattern.  Default-OFF.
    """
    cfg = read_context_config(root).packCutoff
    raw = os.environ.get("AGENTRAIL_CONTEXT_PACK_CUTOFF")
    env_enabled = raw is not None and raw.strip().lower() in _PACK_CUTOFF_TRUTHY
    enabled = env_enabled or cfg.enabled
    ratio = cfg.minScoreRatio
    ratio_raw = (os.environ.get("AGENTRAIL_CONTEXT_PACK_CUTOFF_RATIO") or "").strip()
    if ratio_raw:
        try:
            ratio = float(ratio_raw)
        except ValueError:
            ratio = cfg.minScoreRatio
    # Clamp to [0.0, 1.0] (both config and env override): a ratio > 1.0 would set
    # the threshold above the top score and drop even the top item, emptying the
    # pack; a negative ratio would keep everything. ratio == 1.0 is safe — it keeps
    # items tied at the top.
    ratio = min(max(ratio, 0.0), 1.0)
    return enabled, ratio


def _excluded_key(entry: Dict[str, Any]) -> str:
    """Stable key matching the compiler's excluded-candidate id derivation
    (``sourceId|chunkId|path|citation``, first non-empty; see compiler
    ``_candidate_id``). Shared by the rerank-rejection and pack-cutoff drop paths
    so excluded-candidate ids — and ``compiler.metrics.excludedCount`` — stay
    unique across both.
    """
    for field in ("sourceId", "chunkId", "path", "citation"):
        value = entry.get(field)
        if value:
            return str(value)
    return "candidate:unknown"


def _format_result_entry(rank: int, entry: Dict[str, Any]) -> Dict[str, Any]:
    """Format a scored candidate ``entry`` into the house result-item dict.

    Extracted verbatim from the wide-candidate formatting loop so the same
    projection can build result items OUTSIDE that loop — the definition-aware
    promotion (#1104) formats a def-site chunk pulled from deeper in the scored
    ranking, and it must be byte-for-byte the shape every other result carries.
    """
    source = entry["source"]
    chunk = entry["chunk"]
    score = {key: (None if value is None else round(float(value), 6)) for key, value in entry["score"].items()}
    return {"rank": rank, "kind": "indexed_context", "sourceType": source.get("sourceType"), "path": source.get("path"), "sourceId": source.get("id"), "chunkId": (chunk or {}).get("id"), "startLine": (chunk or {}).get("startLine"), "endLine": (chunk or {}).get("endLine"), "citation": (chunk or {}).get("citation") or source.get("path"), "reason": build_reason(entry["reasons"]), "contentHash": source.get("contentHash"), "textHash": (chunk or {}).get("textHash"), "headingPath": (chunk or {}).get("headingPath", []), "parentContext": (chunk or {}).get("parentContext") or source.get("path"), "matchContext": " > ".join([value for value in [source.get("path"), (chunk or {}).get("parentContext"), *((chunk or {}).get("headingPath", []))] if value]), "symbol": (chunk or {}).get("symbol"), "symbolKind": (chunk or {}).get("kind"), "symbolHints": (chunk or {}).get("symbolHints", []), "importHints": (chunk or {}).get("importHints", []), "memory": (chunk or {}).get("memory") or source.get("memory"), "priorMistake": (chunk or {}).get("priorMistake") or source.get("priorMistake"), "authority": source.get("authority"), "visibility": source.get("visibility"), "freshness": source.get("freshness"), "redactions": source.get("redactions", []), "content": bounded_content(source, chunk), "score": score}


def query_context(target_dir: Path, query: str, *, limit: int = 20, index: Optional[Dict[str, Any]] = None, inject_symbols: Optional[bool] = None) -> Dict[str, Any]:
    from agentrail.context.planner import classify_query

    # Whether the symbol-level recall layer (#1043 AC4) runs. Defaults to the
    # public flag; the recall layer's own monotonicity guard passes ``False`` to
    # take a clean flag-OFF baseline pass without recursing forever.
    do_inject = query_expansion_enabled() if inject_symbols is None else bool(inject_symbols)
    planner = classify_query(query)
    exact_mode = planner["retrievalMode"] in {"exact", "exact_bm25", "exact_graph"}
    root = target_dir.resolve()
    if index is None:
        build_index(root)
        index = load_index(root)
    query_tokens = unique(tokenize(query))
    # Recall layer (#1043, default-OFF): widen the retrieval token set with
    # identifier subtokens recovered from the RAW query (camelCase / snake_case /
    # dotted / path boundaries) so BM25 doc-freq, pre-scoring and the candidate
    # filter all see the extra terms. Recall-monotone: originals are never
    # dropped, so the candidate set can only grow.
    if query_expansion_enabled():
        expanded, added_terms = expand_query_tokens(query, query_tokens)
        query_tokens = unique(expanded)
    else:
        added_terms = []
    # Normalized symbol candidates: strip edge punctuation ("req.param" tokenizes
    # to "req"/".param") and take the member after a dot, so a symbol query matches
    # the chunk that *defines* the symbol, not just files that mention it.
    query_symbols: Set[str] = set()
    for token in query_tokens:
        stripped = re.sub(r"^[^a-z0-9]+|[^a-z0-9]+$", "", token)
        if stripped:
            query_symbols.add(stripped)
        if "." in token:
            tail = token.rsplit(".", 1)[-1]
            if tail:
                query_symbols.add(tail)
    # Definition-site patterns: a file that *assigns/defines* the queried symbol
    # (e.g. "req.accepts =", "function View") is the answer for a symbol lookup —
    # far more precise than symbolHints, which miss chunk-spanning defs and fire
    # on test mocks. Used to tier definitions above dense reference/call sites.
    definition_patterns: List[Any] = []
    # Token(s) the patterns require: a chunk can only DEFINE one of these symbols
    # if it contains it, so we gate the (expensive) regex below on an O(1)
    # termCounts membership check — skipping the scan for chunks that can't match.
    definition_symbols: Set[str] = set()
    raw_lower = query.strip().lower()
    definition_use_hint = True
    if re.fullmatch(r"[a-z_$][\w$]*\.[a-z_$][\w$]*", raw_lower):
        # Dotted member ("res.json"): the only definition is the assignment
        # "res.json =". The bare tail ("json") and symbolHints fire on every
        # file defining an unrelated json — so use the precise pattern alone.
        definition_patterns.append(re.compile(re.escape(raw_lower) + r"\s*[:=]"))
        definition_use_hint = False
        # "res.json" contains the token "json" once tokenized — a necessary
        # condition for the literal to appear, so it's a safe (superset) gate.
        definition_symbols.add(raw_lower.rsplit(".", 1)[-1])
    else:
        for sym in query_symbols:
            if len(sym) >= 4:
                esc = re.escape(sym)
                definition_patterns.append(re.compile(rf"\bfunction\s+{esc}\b"))
                definition_patterns.append(re.compile(rf"\b{esc}\s*[:=]\s*(?:async\s*)?(?:function|\()"))
                definition_patterns.append(re.compile(rf"\b(?:def|class)\s+{esc}\b"))
                definition_symbols.add(sym)
    query_lower = query.lower()
    query_issue_refs = issue_refs(query)
    query_pr_refs = pr_refs(query)
    try:
        state = json.loads((root / ".agentrail" / "state.json").read_text(encoding="utf-8"))
        active_issue = int(state.get("workflow", {}).get("activeIssue") or state.get("workflow", {}).get("activeRun", {}).get("targetIssue") or 0) or None
    except Exception:
        active_issue = None
    effective_issue_refs = query_issue_refs or ([] if query_pr_refs or not active_issue else [active_issue])

    # Prepare (and cache) the query-independent scoring corpus once per index
    # version — the daemon holds the index hot, so warm queries reuse it instead
    # of rebuilding record_text/textLower/term-counts over every chunk per query
    # (that O(all chunks) rebuild was the dominant warm-query cost).
    corpus, postings_by_id, precomputed_postings, doc_count, avg_len = _prepare_corpus(root, index)
    if precomputed_postings is not None:
        # doc-frequency straight from the inverted index — O(query tokens), not
        # O(corpus): postings[token] already lists every doc containing it.
        doc_freq = {token: len(precomputed_postings.get(token, [])) for token in query_tokens}
    else:
        doc_freq = {token: sum(1 for doc in corpus if token in doc["termCounts"]) for token in query_tokens}

    # Symbol-aware hybrid retrieval: BM25 pre-score → seed extraction → graph expansion
    pre_bm25 = _pre_bm25_scores(corpus, query_tokens, doc_count, avg_len, doc_freq)
    intent_compounding = _lesson_target_hints(
        root,
        index,
        corpus,
        pre_bm25,
        effective_issue_refs,
        query_pr_refs,
    )
    lesson_target_paths = set(intent_compounding.get("targetPaths") or [])
    bm25_retrieval_seeds = _extract_retrieval_seeds(corpus, pre_bm25)
    retrieval_seeds = list(intent_compounding.get("targetPaths") or []) or bm25_retrieval_seeds
    graph_expansion = graph_expansion_for_query(index, query, root, retrieval_seeds=retrieval_seeds)
    graph_expansion = apply_graph_expansion_policy(index, graph_expansion)
    graph_source_ids = set(graph_expansion.get("sourceIds") or [])
    graph_paths = set(graph_expansion.get("paths") or [])
    graph_chunk_ids = set(graph_expansion.get("chunkIds") or [])

    # Symbol-level candidates (#1043 AC4, default-OFF via the SAME expansion flag).
    # The token-split expansion above can only recall vocabulary the task NAMES;
    # it cannot reach a genuine imported dependency the task never mentions (e.g.
    # index.py imports source_record_for_file from sources.py, but the task only
    # says "build_index"). Here we recover the seeds'+anchors' cross-file imported
    # symbols and inject each as (a) a retrieval token — so the chunk that DEFINES
    # it becomes a scored candidate — and (b) a definition pattern — so that chunk
    # earns the existing +2.5 "symbol definition" tier. The FULL scoring pipeline
    # then ranks the sharp missed dependency (a rare identifier -> high BM25 idf)
    # into the pack. Recall-monotonicity is restored after the pack is built by a
    # baseline-vs-injected guard (see below), so no member the flag-OFF pack held
    # can be lost. Flag-OFF (do_inject False) leaves the whole block a no-op.
    symbol_candidate_names: List[str] = []
    seed_anchor_paths: List[str] = []
    definition_promotions_applied: List[str] = []
    if do_inject:
        anchor_paths = [
            str(anchor.get("value"))
            for anchor in extract_anchors(query, root=root)
            if anchor.get("kind") == "path" and anchor.get("value")
        ]
        seed_anchor_paths = unique(list(retrieval_seeds) + anchor_paths)
        symbol_candidate_names = cross_file_imported_symbols(root, index, seed_anchor_paths)
        for _name in symbol_candidate_names:
            _tok = _name.lower()
            # Token injection: the imported symbol's identifier is a term the
            # candidate filter and BM25 can now see, so the chunk that DEFINES it
            # is scored at all.
            if _tok not in query_tokens:
                query_tokens.append(_tok)
                if precomputed_postings is not None:
                    doc_freq[_tok] = len(precomputed_postings.get(_tok, []))
                else:
                    doc_freq[_tok] = sum(1 for _doc in corpus if _tok in _doc["termCounts"])
            query_symbols.add(_tok)
            # The imported symbol's DEFINITION site earns the existing +2.5
            # "symbol definition" tier via the same pattern machinery as a queried
            # symbol, so the file that spells `def NAME` / `class NAME` /
            # `function NAME` is lifted toward the pack.
            if len(_tok) >= 4 and _tok not in definition_symbols:
                _esc = re.escape(_tok)
                definition_patterns.append(re.compile(rf"\bfunction\s+{_esc}\b"))
                definition_patterns.append(re.compile(rf"\b{_esc}\s*[:=]\s*(?:async\s*)?(?:function|\()"))
                definition_patterns.append(re.compile(rf"\b(?:def|class)\s+{_esc}\b"))
                definition_symbols.add(_tok)

    # Read embedding config once, before the scoring loop, so we can use it both
    # for candidate filtering and for the semantic scoring section below.
    embedding_cfg = read_context_config(root).embedding
    embedding_mode = embedding_cfg.mode
    if embedding_mode not in {"disabled", "custom-command", "openai-compatible"}:
        raise RuntimeError(f"context embedding mode '{embedding_mode}' is not supported by this AgentRail version; config is reserved for future provider extension")

    # Candidate-filter: when postings.json is loaded and embeddings are inactive,
    # build a candidate_ids set so we only score chunks that have query-term overlap
    # or are anchored by metadata/graph signals.  Non-candidates score exactly 0 and
    # are skipped, eliminating the ~O(corpus) definition-pattern regex calls.
    # Falls back to full-corpus scan when postings are absent/stale (AC4).
    embeddings_inactive = (
        embedding_mode == "disabled"
        or not (root / ".agentrail/context/index/embeddings.json").exists()
    )
    candidate_ids: Optional[Set[str]] = None
    if precomputed_postings is not None and embeddings_inactive:
        term_lookup = set(query_tokens) | {str(n) for n in effective_issue_refs} | {str(n) for n in query_pr_refs}
        candidate_ids = set()
        for _term in term_lookup:
            for _entry in precomputed_postings.get(_term, []):
                candidate_ids.add(str(_entry["id"]))
        # Metadata pass: graph anchors, linked issues/PRs, deterministic sources —
        # none of these are derivable from postings tokens alone.
        for _doc in corpus:
            _src = _doc["source"]
            _chk = _doc["chunk"]
            _iid = str((_chk or {}).get("id") or _src.get("id"))
            _sid = str(_src.get("id") or "")
            _spa = str(_src.get("path") or "")
            _cid = str((_chk or {}).get("id") or "")
            if _spa in lesson_target_paths:
                candidate_ids.add(_iid)
                continue
            if _sid in graph_source_ids or _spa in graph_paths or _cid in graph_chunk_ids:
                candidate_ids.add(_iid)
                continue
            if any(_n in _src.get("linkedIssues", []) for _n in effective_issue_refs):
                candidate_ids.add(_iid)
                continue
            if any(_n in _src.get("linkedPullRequests", []) for _n in query_pr_refs):
                candidate_ids.add(_iid)
                continue
            if _spa == ".agentrail/state.json" and active_issue and active_issue in effective_issue_refs:
                candidate_ids.add(_iid)
                continue
            if _src.get("sourceType") == "run_artifact" and any(
                f"issue-{_n}" in _doc["textLower"] or f'"issue": {_n}' in _doc["textLower"] or f'targetissue": {_n}' in _doc["textLower"]
                for _n in effective_issue_refs
            ):
                candidate_ids.add(_iid)
                continue
            if _src.get("sourceType") in {"context_doc", "taste_doc"} and re.search(r"context|taste|required", query_lower):
                candidate_ids.add(_iid)
                continue
            # Symbol hints (cheap metadata check, no regex)
            if definition_use_hint and query_symbols and any(str(_h).lower() in query_symbols for _h in ((_chk or {}).get("symbolHints") or [])):
                candidate_ids.add(_iid)
                continue
            # Substring issue/PR ref checks (#{n}, /issues/{n}, /pull/{n})
            for _n in effective_issue_refs:
                if f"#{_n}" in _doc["textLower"] or f"/issues/{_n}" in _doc["textLower"]:
                    candidate_ids.add(_iid)
                    break
            else:
                for _n in query_pr_refs:
                    if f"/pull/{_n}" in _doc["textLower"] or f"pr #{_n}" in _doc["textLower"]:
                        candidate_ids.add(_iid)
                        break

    scored: List[Dict[str, Any]] = []
    lexical_raw: Dict[str, float] = {}
    phrases = re.findall(r"[a-z0-9_-]+(?:\s+[a-z0-9_-]+){1,4}", query_lower)
    for doc in corpus:
        source = doc["source"]
        chunk = doc["chunk"]
        # Skip non-candidates early when candidate filtering is active (AC1/AC3).
        # All non-candidates score exactly 0 so skipping them is safe.
        if candidate_ids is not None:
            _doc_id = str((chunk or {}).get("id") or source.get("id"))
            if _doc_id not in candidate_ids:
                continue
        reasons: Set[str] = set()
        deterministic = keyword = bm25 = 0.0
        linked_issue = any(number in source.get("linkedIssues", []) for number in effective_issue_refs)
        linked_pr = any(number in source.get("linkedPullRequests", []) for number in query_pr_refs)
        same_issue = source.get("sourceType") == "run_artifact" and any(f"issue-{number}" in doc["textLower"] or f'"issue": {number}' in doc["textLower"] or f'targetissue": {number}' in doc["textLower"] for number in effective_issue_refs)
        if source.get("path") == ".agentrail/state.json" and active_issue and active_issue in effective_issue_refs:
            deterministic += 4; reasons.update({"active workflow state", "deterministic required context"})
        if same_issue:
            deterministic += 3.5; reasons.add("same issue prior failure")
        if linked_issue:
            deterministic += 3; reasons.add("linked issue")
        if linked_pr:
            deterministic += 2.5; reasons.add("linked pull request")
        if source.get("sourceType") in {"context_doc", "taste_doc"} and re.search(r"context|taste|required", query_lower):
            deterministic += 2; reasons.add("deterministic required context")
        chunk_id = str((chunk or {}).get("id") or "")
        source_id = str(source.get("id") or "")
        source_path = str(source.get("path") or "")
        lesson_target_boost = _LESSON_TARGET_BOOST if source_path in lesson_target_paths else 0.0
        if lesson_target_boost:
            deterministic += lesson_target_boost
            reasons.add("lesson target")
        if source_id in graph_source_ids or source_path in graph_paths or chunk_id in graph_chunk_ids:
            deterministic += 1.75
            reasons.add("graph expansion")
        for number in effective_issue_refs:
            if f"#{number}" in doc["textLower"] or f"/issues/{number}" in doc["textLower"]:
                keyword += 2; reasons.add("exact identifier")
        for number in query_pr_refs:
            if f"/pull/{number}" in doc["textLower"] or f"pr #{number}" in doc["textLower"]:
                keyword += 1.5; reasons.add("exact identifier")
        for token in query_tokens:
            if "/" in token and token in doc["textLower"]:
                keyword += 1.5; reasons.add("exact path")
            tf = doc["termCounts"].get(token, 0)
            if tf:
                df = doc_freq.get(token, 0)
                idf = math.log(1 + (doc_count - df + 0.5) / (df + 0.5))
                bm25 += idf * ((tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * (doc["tokenLen"] / avg_len))))
        for phrase in phrases:
            if len(phrase) > 8 and phrase in doc["textLower"]:
                keyword += 1; reasons.add("exact identifier")
        defines_by_pattern = (
            bool(definition_patterns)
            and any(s in doc["termCounts"] for s in definition_symbols)
            and any(p.search(doc["textLower"]) for p in definition_patterns)
        )
        defines_by_hint = definition_use_hint and bool(query_symbols and any(str(hint).lower() in query_symbols for hint in ((chunk or {}).get("symbolHints") or [])))
        is_definition = defines_by_pattern or defines_by_hint
        if is_definition:
            # The queried symbol is defined in this chunk — prefer the definition
            # site over files that merely call it. Injected imported-symbol names
            # (#1043 AC4) share this tier: the definition site of a cross-file
            # dependency is lifted exactly like a queried symbol's definition.
            deterministic += 2.5; reasons.add("symbol definition")
        if bm25 > 0:
            reasons.add("BM25 keyword match")
        authority_boost = score_authority(source)
        if authority_boost > 0:
            reasons.add("high authority source")
        authority_penalty = authority_demotion(source)
        if 0 < authority_penalty < 999:
            reasons.add("low authority source")
        freshness_penalty, freshness_reasons = freshness_demotion(source, chunk)
        reasons.update(freshness_reasons)
        prior_mistake = (chunk or {}).get("priorMistake") or source.get("priorMistake")
        prior_penalty, prior_reasons = prior_mistake_demotion(prior_mistake, effective_issue_refs)
        reasons.update(prior_reasons)
        if prior_mistake:
            reasons.add("prior mistake")
        if ((chunk or {}).get("memory") or source.get("memory")) and freshness_penalty == 0:
            reasons.add("current memory")
        item_id = (chunk or {}).get("id") or source.get("id")
        lexical = deterministic + keyword + bm25
        lexical_raw[str(item_id)] = lexical
        # lexicalScore = pure lexical (BM25 + keyword boosts, without deterministic)
        # denseScore and fusedScore are filled in after embedding scoring
        scored.append({"source": source, "chunk": chunk, "reasons": reasons, "definitionTier": 1 if (is_definition and exact_mode) else 0, "score": {"deterministic": deterministic, "keyword": keyword, "bm25": bm25, "lexicalScore": keyword + bm25, "denseScore": None, "fusedScore": 0.0, "embedding": None, "rrf": 0.0, "lessonTargetBoost": lesson_target_boost, "authorityBoost": authority_boost, "authorityDemotion": 0 if authority_penalty >= 999 else authority_penalty, "freshnessDemotion": freshness_penalty, "priorMistakeDemotion": prior_penalty, "final": 0.0}})

    graph_expansion["startedFromRetrievalSeeds"] = retrieval_seeds

    lexical_rank = {str((entry["chunk"] or {}).get("id") or entry["source"].get("id")): idx + 1 for idx, entry in enumerate(sorted([entry for entry in scored if lexical_raw[str((entry["chunk"] or {}).get("id") or entry["source"].get("id"))] > 0], key=lambda entry: lexical_raw[str((entry["chunk"] or {}).get("id") or entry["source"].get("id"))], reverse=True))}
    provider: Dict[str, Any] = {"mode": "disabled", "provider": None, "model": None}
    query_vector: Optional[List[float]] = None
    embedding_records: List[Dict[str, Any]] = []
    if embedding_mode != "disabled" and (root / ".agentrail/context/index/embeddings.json").exists():
        parsed = json.loads((root / ".agentrail/context/index/embeddings.json").read_text(encoding="utf-8"))
        embedding_records = parsed.get("embeddings", []) if isinstance(parsed.get("embeddings"), list) else []
        provider = parsed.get("provider") or {"mode": embedding_mode, "provider": provider_name(embedding_mode, embedding_cfg), "model": configured_model(embedding_mode, embedding_cfg)}
        if embedding_records:
            payload = {"mode": embedding_mode, "provider": provider_name(embedding_mode, embedding_cfg), "model": configured_model(embedding_mode, embedding_cfg), "chunkId": "query", "path": "query", "citation": "query", "contentHash": sha256_text(query), "textHash": sha256_text(query), "auditRef": f"audit:query:{sha256_text(query)[7:19]}", "content": query}
            append_audit(root, {"event": "embedding_provider_call", "mode": embedding_mode, "provider": payload["provider"], "model": payload["model"], "action": "embed_query", "queryHash": payload["textHash"]})
            try:
                query_vector = (run_custom_command(root, embedding_cfg, payload) if embedding_mode == "custom-command" else run_openai_compatible(embedding_cfg, payload))["vector"]
            except Exception:
                append_audit(root, {"event": "embedding_provider_failure", "mode": embedding_mode, "provider": payload["provider"], "model": payload["model"], "action": "embed_query_failed", "queryHash": payload["textHash"], "auditRef": payload["auditRef"], "message": "embedding provider failed"})
                query_vector = None
    semantic_rank: Dict[str, int] = {}
    stale_embeddings_excluded = 0
    stale_embedding_leakage = 0
    if query_vector:
        by_chunk = {record.get("chunkId"): record for record in embedding_records}
        ranked: List[Tuple[float, Dict[str, Any]]] = []
        config_hash = embedding_config_hash(embedding_mode, embedding_cfg)
        for entry in scored:
            chunk = entry["chunk"]
            if not chunk:
                continue
            emb = by_chunk.get(chunk.get("id"))
            source = entry["source"]
            if not emb or emb.get("mode") != embedding_mode or emb.get("configHash") != config_hash:
                continue
            fresh = emb.get("textHash") == chunk.get("textHash") and emb.get("contentHash") == source.get("contentHash")
            if not fresh:
                # Stale embedding: indexed text changed since it was generated.
                # Exclude it from semantic scoring — never demote-and-keep.
                stale_embeddings_excluded += 1
                continue
            similarity = max(0.0, cosine_similarity(query_vector, emb.get("embedding", [])))
            if similarity > 0:
                entry["score"]["embedding"] = similarity
                entry["reasons"].add("embedding similarity")
                ranked.append((similarity, entry))
        semantic_rank = {str((entry["chunk"] or {}).get("id") or entry["source"].get("id")): idx + 1 for idx, (_score, entry) in enumerate(sorted(ranked, key=lambda item: item[0], reverse=True))}

    semantic_active = query_vector is not None
    excluded = []
    for item in index.get("skipped", []):
        excluded.append(
            {
                "sourceType": "path",
                "path": item.get("path"),
                "sourceId": item.get("sourceId"),
                "reason": item.get("reason"),
                "citation": ".agentrail/context/index/index.json",
                "authority": item.get("authority"),
                "visibility": item.get("visibility"),
                "freshness": item.get("freshness"),
                "redactions": item.get("redactions", []),
            }
        )
    results = []
    for entry in scored:
        source = entry["source"]
        if source.get("authority") == "denied" or source.get("visibility") == "denied":
            excluded.append(
                {
                    "sourceType": source.get("sourceType"),
                    "path": source.get("path"),
                    "reason": "denied_source",
                    "citation": source.get("path"),
                    "authority": source.get("authority"),
                    "visibility": source.get("visibility"),
                    "freshness": source.get("freshness"),
                    "redactions": source.get("redactions", []),
                }
            )
            continue
        item_id = str((entry["chunk"] or {}).get("id") or source.get("id"))
        rrf = reciprocal_rank(lexical_rank.get(item_id, 0)) + reciprocal_rank(semantic_rank.get(item_id, 0))
        entry["score"]["rrf"] = rrf
        # Retrieval provenance aliases: expose fused/dense scores explicitly
        entry["score"]["fusedScore"] = rrf
        entry["score"]["denseScore"] = entry["score"]["embedding"]
        semantic = entry["score"]["embedding"] or 0.0
        # Relevance = lexical + semantic + fused rank. Authority only *boosts* an
        # already-relevant result's rank; it must not inject an otherwise
        # irrelevant high-authority doc into the budget (precision-at-budget noise).
        if not exact_mode and semantic_active:
            # Conceptual query with real embeddings: semantic similarity is the
            # primary signal. Heavily dampen the whole lexical signal — including
            # the BM25-seeded graph-expansion boost, which otherwise lifts a file
            # that merely repeats the question words — and up-weight semantics.
            lexical = lexical_raw[item_id] * 0.25
            semantic_weight = 10.0
        else:
            lexical = lexical_raw[item_id]
            semantic_weight = 2.0
        relevance = lexical + semantic * semantic_weight + entry["score"]["rrf"] * 10
        entry["score"]["relevance"] = round(relevance, 6)
        entry["score"]["final"] = relevance + entry["score"]["authorityBoost"] - entry["score"]["authorityDemotion"] - entry["score"]["freshnessDemotion"] - entry["score"]["priorMistakeDemotion"]
        if relevance > 0 and entry["score"]["final"] > 0:
            results.append(entry)
    # Definitions of the queried symbol rank in a strictly higher tier than
    # reference-only files, so dense callers/tests cannot bury the definition.
    results.sort(key=lambda entry: (-entry.get("definitionTier", 0), -entry["score"]["final"], str((entry["chunk"] or {}).get("citation") or entry["source"].get("path"))))

    # RETRIEVE WIDE (issue #904): before the deterministic rerank, take a wider
    # candidate set than the caller's top-K so the reranker has lower-retrieved-
    # but-more-relevant candidates available to promote.  The reranker then
    # keeps the top-K under budget; the rest are recorded as rejected.
    #
    # The deterministic code-aware rerank applies to exact / keyword / symbol
    # retrieval.  For a CONCEPTUAL query with active embeddings (semantic mode),
    # embedding similarity is already the relevance reranker — overriding it with
    # lexical code-aware signals would demote the true semantic match below a
    # surface-word decoy, so the rerank stays a pass-through there.
    rerank_active = rerank_enabled() and not (not exact_mode and semantic_active)
    wide_limit = max(limit * _RERANK_WIDEN_FACTOR, limit + _RERANK_WIDEN_MIN_EXTRA) if rerank_active else limit
    formatted = [_format_result_entry(rank, entry) for rank, entry in enumerate(results[:wide_limit], 1)]

    # RERANK (issue #904): deterministic code-aware re-scoring of the wide
    # candidate set, then keep the top-K under budget.  Rejected candidates are
    # appended to ``excluded`` with a rerank reason.  Toggleable via
    # AGENTRAIL_CONTEXT_RERANK=0 so the pre-rerank baseline stays measurable.
    rerank_meta: Optional[Dict[str, Any]] = None
    if rerank_active and formatted:
        rerank_anchors = extract_anchors(query, root=root)
        distance_by_path = _graph_distance_by_path(index, rerank_anchors)
        rerank_result = rerank_candidates(
            formatted,
            query=query,
            top_k=limit,
            anchors=rerank_anchors,
            distance_by_path=distance_by_path,
        )
        formatted = rerank_result["ranked"]
        for position, item in enumerate(formatted, 1):
            item["rank"] = position
        # Dedupe rerank-rejected entries against existing excluded ids using the
        # SAME key the compiler derives its excluded-candidate id from
        # (sourceId|chunkId|path|citation, first non-empty; see module-level
        # ``_excluded_key``) so the contract's excluded-candidate ids stay unique.
        seen_excluded_keys = {_excluded_key(entry) for entry in excluded}
        for dropped in rerank_result["rejected"]:
            rerank_block = dropped.get("rerank") or {}
            rejection = {
                "sourceType": dropped.get("sourceType"),
                "path": dropped.get("path"),
                "sourceId": dropped.get("sourceId"),
                "chunkId": dropped.get("chunkId"),
                "reason": rerank_block.get("reason") or "rejected by deterministic rerank",
                "citation": dropped.get("citation") or dropped.get("path"),
                "authority": dropped.get("authority"),
                "visibility": dropped.get("visibility"),
                "freshness": dropped.get("freshness"),
                "redactions": dropped.get("redactions", []),
                "rerank": rerank_block,
            }
            key = _excluded_key(rejection)
            if key in seen_excluded_keys:
                continue
            seen_excluded_keys.add(key)
            excluded.append(rejection)
        rerank_meta = {
            "status": "reranked",
            "method": rerank_result["method"],
            "model": None,
            "candidateCount": len(rerank_result["ranked"]) + len(rerank_result["rejected"]),
            "keptCount": len(rerank_result["ranked"]),
            "rejectedCount": len(rerank_result["rejected"]),
            "orderChanged": rerank_result["changed"],
            "rankedCandidateIds": [_candidate_id_for_result(item) for item in rerank_result["ranked"]],
            "rejected": [
                {
                    "candidateId": _candidate_id_for_result(item),
                    "path": item.get("path"),
                    "reason": (item.get("rerank") or {}).get("reason") or "rejected by deterministic rerank",
                }
                for item in rerank_result["rejected"]
            ],
        }
        # LLM listwise rerank (issue #1044): default-OFF second stage that only
        # REORDERS the deterministic rerank's kept list — membership (and thus
        # recall) is untouched, and rejection stays deterministic-only.  Fail-open:
        # on fallback the deterministic order and method string stand, with the
        # fallback reason surfaced honestly in the metadata.
        if llm_rerank_enabled():
            llm_result = llm_rerank(formatted, query=query)
            rerank_meta["llm"] = llm_result["llm"]
            if llm_result["fallback"] is not None:
                rerank_meta["llmFallback"] = llm_result["fallback"]
            else:
                formatted = llm_result["ordered"]
                for position, item in enumerate(formatted, 1):
                    item["rank"] = position
                rerank_meta["method"] = f"{rerank_meta['method']}+{LLM_RERANK_METHOD}"
                rerank_meta["model"] = llm_result["llm"]["model"]
                rerank_meta["orderChanged"] = rerank_meta["orderChanged"] or llm_result["changed"]
                rerank_meta["rankedCandidateIds"] = [_candidate_id_for_result(item) for item in formatted]
    # Adaptive confidence cutoff (#1096): default-OFF tail trim on ``formatted`` —
    # keep candidates whose ``score.final`` is >= ratio * the top final score, move
    # the rest into ``excluded``.  The threshold is RELATIVE (not absolute) so it
    # travels across queries.  This is the single seam that feeds BOTH the returned
    # ``results`` and ``compiler_contract(source_items=formatted, ...)``, so trimming
    # here makes the eval's file-level pack metric and build_context_pack reflect the
    # same trimmed tail.  Flag-OFF is a strict no-op: ``formatted``/``excluded`` are
    # left untouched (byte-identical to today).  Items with a non-numeric final score
    # are always kept — we never drop what we cannot confidently score.
    cutoff_enabled, cutoff_ratio = resolve_pack_cutoff(root)
    if cutoff_enabled and formatted:
        finals = [
            item["score"]["final"]
            for item in formatted
            if isinstance(item.get("score"), dict)
            and isinstance(item["score"].get("final"), (int, float))
            and not isinstance(item["score"].get("final"), bool)
        ]
        if finals:
            top_final = max(finals)
            threshold = cutoff_ratio * top_final
            kept: List[Dict[str, Any]] = []
            # Dedupe appended cutoff exclusions against ids already in ``excluded``
            # (rerank rejections and other dropped chunks of the same source) using
            # the SAME key the compiler derives its excluded-candidate id from, so
            # ``compiler.metrics.excludedCount`` stays equal to the unique-id count.
            seen_excluded_keys = {_excluded_key(entry) for entry in excluded}
            for item in formatted:
                score = item.get("score") if isinstance(item.get("score"), dict) else {}
                final = score.get("final")
                if isinstance(final, (int, float)) and not isinstance(final, bool) and final < threshold:
                    exclusion = {
                        "sourceType": item.get("sourceType"),
                        "path": item.get("path"),
                        "sourceId": item.get("sourceId"),
                        "chunkId": item.get("chunkId"),
                        "reason": f"below pack confidence cutoff (score {round(float(final), 6)} < ratio*top {round(threshold, 6)})",
                        "citation": item.get("citation") or item.get("path"),
                        "authority": item.get("authority"),
                        "visibility": item.get("visibility"),
                        "freshness": item.get("freshness"),
                        "redactions": item.get("redactions", []),
                        "packCutoff": {
                            "scoreFinal": round(float(final), 6),
                            "threshold": round(threshold, 6),
                            "ratio": cutoff_ratio,
                            "topScore": round(float(top_final), 6),
                        },
                    }
                    key = _excluded_key(exclusion)
                    if key not in seen_excluded_keys:
                        seen_excluded_keys.add(key)
                        excluded.append(exclusion)
                    # The item leaves the pack either way; dedupe only guards the
                    # excluded list against a duplicate candidate id.
                else:
                    kept.append(item)
            if len(kept) != len(formatted):
                formatted = kept
                for position, item in enumerate(formatted, 1):
                    item["rank"] = position

    # Symbol-level recall layer monotonicity guard (#1043 AC4). The injection
    # above lets the full scoring pipeline surface a genuinely-missed imported
    # definition (its win), but the same re-scoring + rerank can also demote a
    # member the flag-OFF pack held (e.g. a relevant spec doc pushed below a code
    # definition). To keep the layer recall-MONOTONE, take a clean flag-OFF
    # baseline pass and RE-INSERT any HIGH-CONFIDENCE baseline pack member the
    # injection dropped, displacing the injected pack's weakest members (which are
    # pushed down but stay in the pack). Low-score baseline members (keyword noise
    # the injection legitimately out-ranked) are NOT re-inserted, so the recall
    # win is preserved. Guarded by ``do_inject`` and the recursion sentinel so the
    # baseline pass never recurses.
    if do_inject and symbol_candidate_names:
        baseline = query_context(target_dir, query, limit=limit, index=index, inject_symbols=False)
        baseline_results = baseline.get("results", [])[:limit]
        injected_paths = {item.get("path") for item in formatted}
        # Confidence floor for a baseline member worth protecting: relative to the
        # baseline pack's own top score, so it travels across queries.
        baseline_finals = [
            float(r["score"]["final"])
            for r in baseline_results
            if isinstance(r.get("score"), dict)
            and isinstance(r["score"].get("final"), (int, float))
            and not isinstance(r["score"].get("final"), bool)
        ]
        baseline_top = max(baseline_finals) if baseline_finals else 0.0
        floor = _RECALL_GUARD_SCORE_RATIO * baseline_top
        dropped = [
            r for r in baseline_results
            if r.get("path") and r.get("path") not in injected_paths
            and isinstance(r.get("score"), dict)
            and isinstance(r["score"].get("final"), (int, float))
            and not isinstance(r["score"].get("final"), bool)
            and float(r["score"]["final"]) >= floor
        ]
        if dropped:
            # Re-insert the protected baseline members just below the injected
            # members that out-score them, displacing the weakest injected tail
            # (kept, at a lower rank). Nothing the baseline packed above the floor
            # can leave the injected pack -> recall-monotone.
            keep_n = max(0, min(len(formatted), limit) - len(dropped))
            formatted = formatted[:keep_n] + dropped + formatted[keep_n:]
            _seen_paths: Set[str] = set()
            _deduped: List[Dict[str, Any]] = []
            for _item in formatted:
                _p = _item.get("path")
                key = str(_item.get("chunkId") or _item.get("sourceId") or _item.get("citation") or _p)
                if key in _seen_paths:
                    continue
                _seen_paths.add(key)
                _deduped.append(_item)
            formatted = _deduped
            for _position, _item in enumerate(formatted, 1):
                _item["rank"] = _position

        # Definition-aware rerank tier (#1104). The token+pattern injection above
        # lifts a missed dependency only when its imported symbol is a RARE name
        # (high BM25 idf). When the symbol is a COMMON token (compute_pack_quality
        # appears in ~106 chunks), BM25 cannot separate the one file that DEFINES
        # it from the ~105 that merely call it, so pack_quality.py stays out of the
        # pack and fileRecall sticks at 0.5. This tier fixes that by keying on
        # definition-site IDENTITY instead of token frequency: symbolTable resolves
        # each imported name to the exact file that spells its `def`, and #1103
        # already plumbs the per-chunk `symbol`/`symbolKind` through the result
        # boundary, so the DEFINING chunk is identifiable (symbol == name, path ==
        # its symbolTable def path, definition kind) however common the token is.
        #
        # Each such def-site chunk NOT already in the pack is promoted by evicting a
        # NOISE slot -- a member that is neither a seed/anchor, nor an imported
        # symbol's definition file (a recalled cross-file dependency, e.g. sources.py
        # on index-build-hard), nor a high-confidence flag-OFF baseline member (the
        # spec docs the guard above protects). Because every relevant file is one of
        # those three protected classes, fileRecall cannot regress; and because each
        # promotion evicts exactly one noise slot, the pack size (the precision
        # denominator) is unchanged. It is self-limiting: on a SATURATED pack there
        # are no noise slots to give up, so nothing is promoted and precision is
        # untouched -- only a pack padded with keyword noise (the common-symbol case)
        # makes room for the missed definition.
        # Anchor the promotion on the file the query actually retrieved -- the
        # top-ranked code definition(s) in the pack + any explicit path anchor --
        # NOT every BM25 seed. A noisy seed (fixtures.json, a test pulled in on
        # keyword overlap) would otherwise contribute generic imports (`run`,
        # `_build`) whose "definition sites" are themselves noise files, both
        # crowding out the real missed dependency and shielding noise from
        # displacement. The strongest anchor's imports are the genuine deps.
        promo_seed_paths: List[str] = list(anchor_paths)
        for item in formatted:
            if len(promo_seed_paths) >= _DEF_AWARE_SEED_TOPK + len(anchor_paths):
                break
            path = item.get("path")
            if item.get("symbolKind") and path and path not in promo_seed_paths:
                promo_seed_paths.append(path)
        promo_names = cross_file_imported_symbols(root, index, promo_seed_paths)
        def_site_map = definition_site_paths(index, promo_seed_paths, promo_names)
        if def_site_map:
            pack_files = {item.get("path") for item in formatted}
            # Candidate def-site chunks pulled from the FULL scored ranking (kept
            # in its (-definitionTier, -final) order), then narrowed to genuine
            # definition sites by IDENTITY in select_definition_promotions.
            def_candidates = [
                _format_result_entry(0, entry)
                for entry in results
                if (entry["chunk"] or {}).get("symbol") in def_site_map
                and entry["source"].get("path")
                in def_site_map.get((entry["chunk"] or {}).get("symbol"), set())
            ]
            promotions = select_definition_promotions(
                def_candidates, def_site_map, exclude_files=pack_files
            )
            if promotions:
                def _final_of(item: Dict[str, Any]) -> float:
                    sc = item.get("score")
                    if (
                        isinstance(sc, dict)
                        and isinstance(sc.get("final"), (int, float))
                        and not isinstance(sc.get("final"), bool)
                    ):
                        return float(sc["final"])
                    return 0.0

                # Never-evict set: seeds/anchors, every imported symbol's def file
                # (a genuine dependency, whichever arm recalled it), and the
                # high-confidence flag-OFF baseline members the guard just protected
                # (score >= the same ``floor``). Everything else in the pack is
                # keyword noise, displaceable weakest-first to seat a definition.
                protected_files = set(seed_anchor_paths)
                for _paths in def_site_map.values():
                    protected_files |= set(_paths)
                protected_files |= {
                    r.get("path")
                    for r in baseline_results
                    if r.get("path")
                    and isinstance(r.get("score"), dict)
                    and isinstance(r["score"].get("final"), (int, float))
                    and not isinstance(r["score"].get("final"), bool)
                    and float(r["score"]["final"]) >= floor
                }
                displaceable = sorted(
                    [item for item in formatted if item.get("path") not in protected_files],
                    key=_final_of,
                )
                n = min(len(promotions), len(displaceable))
                if n:
                    def _key(item: Dict[str, Any]) -> str:
                        return str(
                            item.get("chunkId")
                            or item.get("sourceId")
                            or item.get("citation")
                            or item.get("path")
                        )

                    evict = {_key(item) for item in displaceable[:n]}
                    kept = [item for item in formatted if _key(item) not in evict]
                    # Seat the promoted definitions in the vacated NOISE slots at
                    # the tail, preserving the rank of every kept member. Placing
                    # them higher would demote a genuinely-relevant member out of
                    # the top-R window and cost file-level R-precision (e.g.
                    # benchmark.py on retrieval-evaluation); recall only needs pack
                    # MEMBERSHIP, so the tail is enough.
                    formatted = kept + promotions[:n]
                    definition_promotions_applied = [
                        str(item.get("path")) for item in promotions[:n]
                    ]
                    _seen_p: Set[str] = set()
                    _dedup_p: List[Dict[str, Any]] = []
                    for _item in formatted:
                        _k = _key(_item)
                        if _k in _seen_p:
                            continue
                        _seen_p.add(_k)
                        _dedup_p.append(_item)
                    formatted = _dedup_p
                    for _pos, _item in enumerate(formatted, 1):
                        _item["rank"] = _pos

    audit = {
        "event": "context_query",
        "citation": ".agentrail/context/audit/events.jsonl",
        "queryHash": sha256_text(query),
        "retrievalMode": planner["retrievalMode"],
        "staleEmbeddingLeakage": stale_embedding_leakage,
        "staleEmbeddingsExcluded": stale_embeddings_excluded,
        "resultCount": len(formatted),
        "excludedCount": len(excluded),
        "providerMode": provider.get("mode") or embedding_mode,
    }
    retrieval_budget = {"maxItems": limit, "maxTokens": None}
    output = {
        "schemaVersion": 1,
        "command": "context.query",
        "target": {"kind": "query", "query": query},
        "query": query,
        "limit": limit,
        "retrievalMode": planner["retrievalMode"],
        "planner": planner,
        "retrievalIntegrity": {"staleEmbeddingLeakage": stale_embedding_leakage, "staleEmbeddingsExcluded": stale_embeddings_excluded},
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "index": {"version": index.get("version"), "builtAt": index.get("builtAt")},
        "retrievalBudget": retrieval_budget,
        "provider": provider,
        "audit": audit,
        "intentCompounding": intent_compounding,
        "results": formatted,
        "excluded": excluded,
        "compiler": compiler_contract(
            "query",
            query,
            root=root,
            token_budget=retrieval_budget,
            source_items=formatted,
            excluded_items=excluded,
            compatibility={
                "queryResultsMapTo": "compiler.candidates[kind=source_evidence]",
                "queryExcludedMapTo": "compiler.candidates[kind=excluded_context]",
            },
            graph_expansion=graph_expansion,
            rerank=rerank_meta,
        ),
    }
    # Recall-layer telemetry (#1043): report whether query expansion ran, the
    # subtokens the token-split arm added, and how many cross-file symbol
    # candidates the symbol-level arm (AC4) injected. Both arms are fully
    # deterministic — no model call, no tokens — so cost is auditably 0.0.
    output["expansion"] = {
        "enabled": query_expansion_enabled(),
        "addedTerms": added_terms,
        "symbolCandidateCount": len(symbol_candidate_names),
        "cost": 0.0,
    }
    # Definition-aware rerank tier telemetry (#1104): the cross-file definition
    # files it promoted into the pack (common-symbol dependencies BM25 could not
    # lift). Still a deterministic, $0 layer -- no model call. Added ONLY when the
    # recall flag is on, so the flag-OFF ``expansion`` block stays byte-identical
    # to the pre-#1104 baseline.
    if query_expansion_enabled():
        output["expansion"]["definitionPromotions"] = definition_promotions_applied
        output["expansion"]["definitionPromotionCount"] = len(definition_promotions_applied)
    append_audit(root, audit)
    return output


def _bounded_snippet(
    content: Any,
    query_tokens: Optional[List[str]] = None,
    *,
    max_lines: int = 10,
    max_chars: int = 600,
) -> Tuple[str, int, int]:
    """Trim chunk content to a bounded snippet anchored on the matched span.

    When ``query_tokens`` are provided and the first match falls past the head
    window, anchors on the enclosing symbol signature (first content line) plus
    a window around the match so the snippet contains both the definition
    boundary and the matched span (issue #903).  Falls back to head-biased
    extraction when no deep match exists.

    Returns ``(snippet, span_start_offset, span_end_offset)`` where the offsets
    are 0-based line indices *within the chunk content* of the first and last
    chunk lines the returned snippet actually covers.  Callers add the chunk's
    absolute ``startLine`` to these offsets to produce an honest citation range
    for the returned window — not the whole chunk (issue #903 AC2).
    """
    if not isinstance(content, str):
        return "", 0, 0
    lines = content.splitlines()
    total = len(lines)
    if not lines:
        return "", 0, 0

    # Find the first line that contains a long query token (≥4 chars).
    match_idx: Optional[int] = None
    if query_tokens:
        for i, line in enumerate(lines):
            line_lower = line.lower()
            if any(tok in line_lower for tok in query_tokens if len(tok) >= 4):
                match_idx = i
                break

    # Head-biased path: match is within the first max_lines, or no match found.
    if match_idx is None or match_idx < max_lines:
        head_count = min(max_lines, total)
        snippet = "\n".join(lines[:head_count])
        if len(snippet) > max_chars:
            snippet = snippet[:max_chars].rstrip() + " …"
        elif total > max_lines:
            snippet += " …"
        # The head window covers chunk lines 0 .. head_count - 1.
        return snippet, 0, head_count - 1

    # Deep-match path: sig (line 0) + window around the match.
    # Budget: 1 sig line + up to (max_lines - 1) window lines.
    window_budget = max_lines - 1
    half = window_budget // 2
    win_start = max(1, match_idx - half)
    win_end = min(total, win_start + window_budget)
    # Slide the window left if it hit the end of the content.
    if win_end - win_start < window_budget:
        win_start = max(1, win_end - window_budget)

    sig_line = lines[0]
    window_lines = lines[win_start:win_end]
    # Insert an ellipsis between the sig and the window when there is a gap.
    if win_start > 1:
        parts = [sig_line, "    …", *window_lines]
    else:
        parts = [sig_line, *window_lines]

    snippet = "\n".join(parts)
    if len(snippet) > max_chars:
        snippet = snippet[:max_chars].rstrip() + " …"
    # The window covers the signature (chunk line 0) through win_end - 1; the
    # citation range reflects this span, not the whole chunk.
    return snippet, 0, win_end - 1


def search_context(target_dir: Path, query: str, *, limit: int = 20, index: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Compact exact-leaning retrieval.

    Returns ranked candidates as path + line range + symbol + bounded snippet +
    reason + score, never whole-file bodies.  Whole-file or wider context must be
    fetched explicitly with ``get_file_lines`` / ``get_file_symbol``.

    Pass ``index=`` to skip the disk read (daemon warm path).
    """
    raw = query_context(target_dir, query, limit=limit, index=index)
    _snippet_query_tokens = unique(tokenize(query))
    results: List[Dict[str, Any]] = []
    for entry in raw.get("results", []):
        chunk_start = int(entry.get("startLine") or 1)
        chunk_end = int(entry.get("endLine") or chunk_start)
        symbol_hints = entry.get("symbolHints") or []
        snippet, span_start_off, span_end_off = _bounded_snippet(
            entry.get("content"), _snippet_query_tokens
        )
        # The citation must reflect the *returned window*, not the whole chunk
        # (issue #903 AC2): map the snippet's in-chunk line offsets back to
        # absolute file lines, clamped to the chunk bounds.
        line_start = min(chunk_end, chunk_start + max(0, span_start_off))
        line_end = min(chunk_end, chunk_start + max(span_start_off, span_end_off))
        results.append({
            "rank": entry.get("rank"),
            "path": entry.get("path"),
            "lineStart": int(line_start),
            "lineEnd": int(line_end),
            "symbol": symbol_hints[0] if symbol_hints else None,
            "citation": entry.get("citation"),
            "snippet": snippet,
            "reason": entry.get("reason"),
            "score": (entry.get("score") or {}).get("final"),
            "tokenEstimate": estimate_tokens(snippet),
        })
    selected_sources = [entry["path"] for entry in results]
    integrity = raw.get("retrievalIntegrity") or {}
    # query_context records maxTokens=None (a plain query has no token budget),
    # but run-level retrieval operates under the shared pack budget. Fill in the
    # real numeric budget so downstream telemetry never reports 0.
    run_budget = dict(raw.get("retrievalBudget") or {})
    run_budget.setdefault("maxItems", limit)
    if not run_budget.get("maxTokens"):
        run_budget["maxTokens"] = RETRIEVAL_MAX_TOKENS
    run_metadata = {
        "retrievalMode": raw.get("retrievalMode"),
        "selectedSources": selected_sources,
        "selectedContextTokens": sum(entry["tokenEstimate"] for entry in results),
        "tokensSaved": compute_tokens_saved(target_dir.resolve(), results),
        # Ground-truth-free at run time; the benchmark measures waste against
        # known required sources. Recorded for schema completeness.
        "wastedContextTokens": 0,
        "retrievalBudget": run_budget,
        "citations": [entry["citation"] for entry in results],
        "reasons": [entry["reason"] for entry in results],
        "scores": [entry["score"] for entry in results],
        "staleOrDeniedLeakage": len(raw.get("excluded") or []),
        "staleEmbeddingLeakage": integrity.get("staleEmbeddingLeakage", 0),
        "intentCompounding": raw.get("intentCompounding") or {"enabled": False, "lessonPaths": [], "targetPaths": []},
    }
    # Live context-pack quality proxies. The compacted ``results`` above drop the
    # policy/provenance fields, so compute from the richer pre-compaction items
    # (``raw["results"]`` carry sourceType/authority/freshness/contentHash/textHash)
    # while keeping the selected set aligned with ``selectedContextTokens`` via the
    # shared ``tokenEstimate``. Failure-tolerant: defaults if anything goes wrong.
    try:
        selected_rich: List[Dict[str, Any]] = []
        for compact, rich in zip(results, raw.get("results", [])):
            merged = dict(rich) if isinstance(rich, dict) else {}
            merged["tokenEstimate"] = compact.get("tokenEstimate")
            selected_rich.append(merged)
        run_metadata.update(
            compute_pack_quality(
                selected_rich,
                raw.get("excluded") or [],
                run_metadata["selectedContextTokens"],
            )
        )
    except Exception:  # noqa: BLE001 — metrics are best-effort, never fatal
        run_metadata.update(
            {
                "precision_at_budget": 0.0,
                "citation_coverage": 0.0,
                "stale_count": 0,
                "denied_count": 0,
                "source_hash_list": [],
            }
        )
    return {
        "schemaVersion": 1,
        "command": "context.search",
        "query": query,
        "limit": limit,
        "retrievalMode": raw.get("retrievalMode"),
        "planner": raw.get("planner"),
        "runMetadata": run_metadata,
        "generatedAt": raw.get("generatedAt"),
        "provider": raw.get("provider"),
        "intentCompounding": raw.get("intentCompounding") or {"enabled": False, "lessonPaths": [], "targetPaths": []},
        "retrievalBudget": raw.get("retrievalBudget"),
        "results": results,
        "excluded": raw.get("excluded", []),
    }
