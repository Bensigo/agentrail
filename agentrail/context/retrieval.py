from __future__ import annotations

import hashlib
import json
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from agentrail.context.compiler import compiler_contract, extract_anchors
from agentrail.context.config import read_context_config
from agentrail.context.embeddings import embedding_config_hash, provider_name, configured_model, run_custom_command, run_openai_compatible
from agentrail.context.index import append_audit, build_index, load_index
from agentrail.shared.fs import sha256_text


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
    ordered = ["deterministic required context", "active workflow state", "same issue prior failure", "prior mistake", "linked issue", "linked pull request", "exact identifier", "exact path", "graph expansion", "BM25 keyword match", "embedding similarity", "high authority source", "current memory", "stale memory", "expired memory", "stale prior mistake", "resolved prior mistake", "unrelated prior mistake", "low authority source"]
    return "; ".join(item for item in ordered if item in parts) or "Included by hybrid retrieval score."


def bounded_content(source: Dict[str, Any], chunk: Optional[Dict[str, Any]]) -> Any:
    content = (chunk or {}).get("content") if chunk else source.get("content")
    if isinstance(content, str) and len(content) > 2000:
        return f"{content[:2000]}\n[TRUNCATED]"
    return content


def estimate_tokens(text: str) -> int:
    """Rough shared token estimator (chars / 4) used across compact retrieval."""
    return (len(text) + 3) // 4


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


def _graph_neighbors(graph: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    neighbors: Dict[str, List[Dict[str, Any]]] = {}
    for edge in graph.get("edges", []):
        if not isinstance(edge, dict):
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


def graph_expansion_for_query(index: Dict[str, Any], query: str, root: Path, *, max_hops: int = 2, retrieval_seeds: Optional[List[str]] = None) -> Dict[str, Any]:
    """Expand the code graph starting from anchor-matched nodes and, optionally,
    hybrid-retrieval seed paths (top-K BM25 candidates).

    ``retrieval_seeds`` is a list of file paths from the BM25 pre-score pass.
    A maximum of 5 seeds is recommended to prevent hop fanout.
    """
    anchors = extract_anchors(query, root=root)
    anchor_start_nodes, started_from = _anchor_start_nodes(index, anchors)
    seed_start_nodes = _retrieval_seed_start_nodes(index, retrieval_seeds or [])
    start_nodes = unique(anchor_start_nodes + seed_start_nodes)
    graph = index.get("graph") if isinstance(index.get("graph"), dict) else {}
    neighbors = _graph_neighbors(graph)
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
                score += idf * ((tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * (len(doc["tokens"]) / avg_len))))
        scores[item_id] = score
    return scores


def _extract_retrieval_seeds(corpus: List[Dict[str, Any]], pre_bm25: Dict[str, float], max_seeds: int = 5) -> List[str]:
    """Return up to max_seeds unique file paths with the highest pre-BM25 scores."""
    doc_by_id = {str((doc["chunk"] or {}).get("id") or doc["source"].get("id")): doc for doc in corpus}
    seeds: List[str] = []
    for item_id, _score in sorted(pre_bm25.items(), key=lambda kv: kv[1], reverse=True):
        if _score <= 0 or len(seeds) >= max_seeds:
            break
        doc = doc_by_id.get(item_id)
        if not doc:
            continue
        path = doc["source"].get("path")
        if path and path not in seeds:
            seeds.append(path)
    return seeds


def query_context(target_dir: Path, query: str, *, limit: int = 20) -> Dict[str, Any]:
    from agentrail.context.planner import classify_query

    planner = classify_query(query)
    root = target_dir.resolve()
    build_index(root)
    index = load_index(root)
    sources = {record["id"]: record for record in index.get("records", [])}
    items = [(sources.get(chunk.get("sourceId"), {}), chunk) for chunk in index.get("chunks", [])] if index.get("chunks") else [(record, None) for record in index.get("records", [])]
    query_tokens = unique(tokenize(query))
    query_lower = query.lower()
    query_issue_refs = issue_refs(query)
    query_pr_refs = pr_refs(query)
    try:
        state = json.loads((root / ".agentrail" / "state.json").read_text(encoding="utf-8"))
        active_issue = int(state.get("workflow", {}).get("activeIssue") or state.get("workflow", {}).get("activeRun", {}).get("targetIssue") or 0) or None
    except Exception:
        active_issue = None
    effective_issue_refs = query_issue_refs or ([] if query_pr_refs or not active_issue else [active_issue])

    # Build corpus once; used for both pre-BM25 seed extraction and full scoring
    corpus: List[Dict[str, Any]] = []
    for source, chunk in items:
        text = record_text(source, chunk)
        tokens = tokenize(text)
        term_counts: Dict[str, int] = {}
        for token in tokens:
            term_counts[token] = term_counts.get(token, 0) + 1
        corpus.append({"source": source, "chunk": chunk, "text": text, "textLower": text.lower(), "tokens": tokens, "termCounts": term_counts})
    doc_count = max(1, len(corpus))
    avg_len = sum(len(doc["tokens"]) for doc in corpus) / doc_count if corpus else 1
    doc_freq = {token: sum(1 for doc in corpus if token in doc["termCounts"]) for token in query_tokens}

    # Symbol-aware hybrid retrieval: BM25 pre-score → seed extraction → graph expansion
    pre_bm25 = _pre_bm25_scores(corpus, query_tokens, doc_count, avg_len, doc_freq)
    retrieval_seeds = _extract_retrieval_seeds(corpus, pre_bm25)
    graph_expansion = graph_expansion_for_query(index, query, root, retrieval_seeds=retrieval_seeds)
    graph_expansion = apply_graph_expansion_policy(index, graph_expansion)
    graph_source_ids = set(graph_expansion.get("sourceIds") or [])
    graph_paths = set(graph_expansion.get("paths") or [])
    graph_chunk_ids = set(graph_expansion.get("chunkIds") or [])

    scored: List[Dict[str, Any]] = []
    lexical_raw: Dict[str, float] = {}
    phrases = re.findall(r"[a-z0-9_-]+(?:\s+[a-z0-9_-]+){1,4}", query_lower)
    for doc in corpus:
        source = doc["source"]
        chunk = doc["chunk"]
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
                bm25 += idf * ((tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * (len(doc["tokens"]) / avg_len))))
        for phrase in phrases:
            if len(phrase) > 8 and phrase in doc["textLower"]:
                keyword += 1; reasons.add("exact identifier")
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
        scored.append({"source": source, "chunk": chunk, "reasons": reasons, "score": {"deterministic": deterministic, "keyword": keyword, "bm25": bm25, "lexicalScore": keyword + bm25, "denseScore": None, "fusedScore": 0.0, "embedding": None, "rrf": 0.0, "authorityBoost": authority_boost, "authorityDemotion": 0 if authority_penalty >= 999 else authority_penalty, "freshnessDemotion": freshness_penalty, "priorMistakeDemotion": prior_penalty, "final": 0.0}})

    _bm25_by_path: List[Tuple[float, str]] = [(entry["score"]["bm25"], str(entry["source"].get("path") or "")) for entry in scored if entry["score"]["bm25"] > 0 and entry["source"].get("path")]
    _bm25_by_path.sort(key=lambda _x: _x[0], reverse=True)
    _seen_seed_paths: Set[str] = set()
    _seed_paths: List[str] = []
    for _, _p in _bm25_by_path:
        if _p not in _seen_seed_paths:
            _seen_seed_paths.add(_p)
            _seed_paths.append(_p)
    graph_expansion["startedFromRetrievalSeeds"] = _seed_paths

    lexical_rank = {str((entry["chunk"] or {}).get("id") or entry["source"].get("id")): idx + 1 for idx, entry in enumerate(sorted([entry for entry in scored if lexical_raw[str((entry["chunk"] or {}).get("id") or entry["source"].get("id"))] > 0], key=lambda entry: lexical_raw[str((entry["chunk"] or {}).get("id") or entry["source"].get("id"))], reverse=True))}
    provider: Dict[str, Any] = {"mode": "disabled", "provider": None, "model": None}
    embedding_cfg = read_context_config(root).embedding
    embedding_mode = embedding_cfg.mode
    if embedding_mode not in {"disabled", "custom-command", "openai-compatible"}:
        raise RuntimeError(f"context embedding mode '{embedding_mode}' is not supported by this AgentRail version; config is reserved for future provider extension")
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
        entry["score"]["final"] = lexical_raw[item_id] + semantic * 2 + entry["score"]["rrf"] * 10 + entry["score"]["authorityBoost"] - entry["score"]["authorityDemotion"] - entry["score"]["freshnessDemotion"] - entry["score"]["priorMistakeDemotion"]
        if entry["score"]["final"] > 0:
            results.append(entry)
    results.sort(key=lambda entry: (-entry["score"]["final"], str((entry["chunk"] or {}).get("citation") or entry["source"].get("path"))))
    formatted = []
    for rank, entry in enumerate(results[:limit], 1):
        source = entry["source"]
        chunk = entry["chunk"]
        score = {key: (None if value is None else round(float(value), 6)) for key, value in entry["score"].items()}
        formatted.append({"rank": rank, "kind": "indexed_context", "sourceType": source.get("sourceType"), "path": source.get("path"), "sourceId": source.get("id"), "chunkId": (chunk or {}).get("id"), "startLine": (chunk or {}).get("startLine"), "endLine": (chunk or {}).get("endLine"), "citation": (chunk or {}).get("citation") or source.get("path"), "reason": build_reason(entry["reasons"]), "contentHash": source.get("contentHash"), "textHash": (chunk or {}).get("textHash"), "headingPath": (chunk or {}).get("headingPath", []), "parentContext": (chunk or {}).get("parentContext") or source.get("path"), "matchContext": " > ".join([value for value in [source.get("path"), (chunk or {}).get("parentContext"), *((chunk or {}).get("headingPath", []))] if value]), "symbolHints": (chunk or {}).get("symbolHints", []), "importHints": (chunk or {}).get("importHints", []), "memory": (chunk or {}).get("memory") or source.get("memory"), "priorMistake": (chunk or {}).get("priorMistake") or source.get("priorMistake"), "authority": source.get("authority"), "visibility": source.get("visibility"), "freshness": source.get("freshness"), "redactions": source.get("redactions", []), "content": bounded_content(source, chunk), "score": score})
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
        ),
    }
    append_audit(root, audit)
    return output


def _bounded_snippet(content: Any, *, max_lines: int = 10, max_chars: int = 600) -> str:
    """Trim chunk content to a small snippet so search never echoes whole files."""
    if not isinstance(content, str):
        return ""
    lines = content.splitlines()
    snippet = "\n".join(lines[:max_lines])
    if len(snippet) > max_chars:
        snippet = snippet[:max_chars].rstrip() + " …"
    elif len(lines) > max_lines:
        snippet = snippet + " …"
    return snippet


def search_context(target_dir: Path, query: str, *, limit: int = 20) -> Dict[str, Any]:
    """Compact exact-leaning retrieval.

    Returns ranked candidates as path + line range + symbol + bounded snippet +
    reason + score, never whole-file bodies.  Whole-file or wider context must be
    fetched explicitly with ``get_file_lines`` / ``get_file_symbol``.
    """
    raw = query_context(target_dir, query, limit=limit)
    results: List[Dict[str, Any]] = []
    for entry in raw.get("results", []):
        line_start = entry.get("startLine") or 1
        line_end = entry.get("endLine") or line_start
        symbol_hints = entry.get("symbolHints") or []
        snippet = _bounded_snippet(entry.get("content"))
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
    return {
        "schemaVersion": 1,
        "command": "context.search",
        "query": query,
        "limit": limit,
        "retrievalMode": raw.get("retrievalMode"),
        "planner": raw.get("planner"),
        "generatedAt": raw.get("generatedAt"),
        "provider": raw.get("provider"),
        "retrievalBudget": raw.get("retrievalBudget"),
        "results": results,
        "excluded": raw.get("excluded", []),
    }
