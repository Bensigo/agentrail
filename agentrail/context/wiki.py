"""Repo Wiki compiler — deterministic skeleton + bounded prose, local-only.

Repo Wiki spec (docs/superpowers/specs/2026-07-23-repo-wiki-compiled-repo-knowledge-design.md),
delivery plan S7 row 2. Compiles a per-repository set of cited pages — one
repo overview + one page per Codebase Unit (see ``index.detect_codebase_units``
and PR 1's ``unit_depends_on`` rollup) — at index time:

  * The SKELETON (file roster, exported symbols, unit dependency edges, test
    counts) is 100% deterministic, read straight off the index/graph PR 1
    already built. It costs nothing and never hallucinates structure.
  * The PROSE (Responsibility / per-file one-liners / Relationships &
    invariants) is a bounded, cheap-model pass grounded ONLY in the skeleton
    plus capped file-head excerpts. It organizes; it never invents structure,
    and every relationship claim must cite a roster path — citations that
    don't resolve to a roster path are stripped (`validate_citations`).

This module is entirely LOCAL: pages are materialized under
``.agentrail/context/wiki/`` (a generated-cache dir already excluded from the
file walk — see ``config.DEFAULT_EXCLUDE_GLOBS``) and ingested as
``sourceType="wiki_doc"`` / ``authority="generated"`` SourceRecords so they
land in index.json/postings like any other source. Server persistence,
cross-clone hydration, and the onboard.py wiring that turns this on for real
runs are later PRs (spec S7 rows 4/2 respectively) — until then this compiler
only ever runs when explicitly enabled (env flag + config, both default OFF)
or invoked directly via ``agentrail context wiki build``.

Fail-open throughout: any prose-provider error, missing binary, or cost-
ceiling breach ships a skeleton-only page (never a hard failure) — mirrors
the house convention in ``runner/onboard.py`` and ``context/llm_rerank.py``.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from agentrail.context.config import ContextConfig, ProviderConfig
from agentrail.context.index import append_audit, chunks_for_source, now_iso, unit_contains_path
from agentrail.context.models import ChunkRecord, Freshness, SourceRecord
from agentrail.context.pricing import cost_for
from agentrail.context.redaction import redact_text
from agentrail.context.sources import audit_ref_for, linked_refs_from_text
from agentrail.run.proc import sanitized_env
from agentrail.shared.fs import sha256_text, to_posix
from agentrail.shared.json import write_json

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Flags / constants
# ---------------------------------------------------------------------------

# Rollout flag (spec S3 "Rollout": default OFF, same opt-in-only convention as
# AGENTRAIL_JIT_GATHER — absent, blank, "0", or any other value keeps
# build_index byte-identical to before this module existed).
REPO_WIKI_ENV = "AGENTRAIL_CONTEXT_REPO_WIKI"

# CLI-only escape hatch: ``agentrail context wiki build --force`` sets this so
# compile_wiki ignores hash-reuse for the duration of one call, without
# threading a new parameter through build_index's fixed signature.
WIKI_FORCE_ENV = "AGENTRAIL_CONTEXT_WIKI_FORCE"

WIKI_MAX_COST_ENV = "AGENTRAIL_WIKI_MAX_COST_USD"
DEFAULT_WIKI_MAX_COST_USD = 0.50

SOURCE_TYPE = "wiki_doc"
AUTHORITY = "generated"

DEFAULT_PROSE_MODEL = "claude-haiku-4-5-20251001"
_CLAUDE_CLI_BIN = "claude"
_CALL_TIMEOUT_SECONDS = 60

OVERVIEW_SLUG = "wiki/overview"
_UNIT_SLUG_PREFIX = "wiki/unit/"
_UNIT_ID_PREFIX = "codebase-unit:"

# Page grain cap (spec S4.1): larger repos get the biggest MAX_UNIT_PAGES units
# by fileCount; the cap is logged, never silent (see compile_wiki's audit call).
MAX_UNIT_PAGES = 24

# Prompt bounding (spec build step 3): per-unit roster + file-head sampling.
UNIT_ROSTER_CAP = 15
FILE_HEAD_LINES = 40
FILE_HEAD_MAX_CHARS = 1600
PROMPT_CHAR_BUDGET = 4000

# Output bounding (spec S4.1: "<= 1,200 output tokens per page"), enforced as a
# char-based truncation guard (~4 chars/token, the house convention used
# elsewhere for provider input caps — see embeddings.py's MAX_EMBED_CHARS).
MAX_PROSE_CHARS = 1200 * 4

_PROSE_UNAVAILABLE = "_Prose unavailable (provider error, cost ceiling reached, or nothing to describe); skeleton-only._"

_OVERVIEW_DOC_CANDIDATES = ("README.md", ".agentrail/context.md", "CONTEXT.md")

_FRONTMATTER_DELIM = "---"


def repo_wiki_enabled() -> bool:
    """Is the repo wiki compiler ON for this process? DEFAULT OFF.

    Turns on ONLY when ``AGENTRAIL_CONTEXT_REPO_WIKI`` is explicitly ``"1"`` —
    absent, blank, ``"0"``, or any other value keeps build_index's output
    byte-identical to before this module existed (the flag-OFF AC). Mirrors
    ``agentrail.run.pipeline.jit_gather_enabled``'s exact convention.
    """
    return (os.environ.get(REPO_WIKI_ENV) or "").strip() == "1"


def wiki_max_cost_usd() -> float:
    """The per-compile dollar ceiling (spec S4.2), overridable via env."""
    raw = os.environ.get(WIKI_MAX_COST_ENV)
    if raw is None or not raw.strip():
        return DEFAULT_WIKI_MAX_COST_USD
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_WIKI_MAX_COST_USD
    return value if value >= 0 else DEFAULT_WIKI_MAX_COST_USD


def _env_force_enabled() -> bool:
    return (os.environ.get(WIKI_FORCE_ENV) or "").strip() == "1"


def wiki_dir_for(root: Path) -> Path:
    return root / ".agentrail" / "context" / "wiki"


# ---------------------------------------------------------------------------
# Slugs / filenames (FROZEN contract — other PRs materialize the same shapes)
# ---------------------------------------------------------------------------


def _unit_local_id(unit: Dict[str, Any]) -> str:
    """Strip the fixed ``codebase-unit:`` prefix ``index.codebase_unit`` always
    adds, leaving the already-slugified local id (e.g. ``agentrail-context``)."""
    raw = str(unit["id"])
    return raw[len(_UNIT_ID_PREFIX):] if raw.startswith(_UNIT_ID_PREFIX) else raw


def unit_slug(unit: Dict[str, Any]) -> str:
    return f"{_UNIT_SLUG_PREFIX}{_unit_local_id(unit)}"


def slug_to_filename(slug: str) -> str:
    """slug "wiki/overview" -> overview.md; "wiki/unit/<id>" -> unit__<id>.md."""
    if slug == OVERVIEW_SLUG:
        return "overview.md"
    if slug.startswith(_UNIT_SLUG_PREFIX):
        return f"unit__{slug[len(_UNIT_SLUG_PREFIX):]}.md"
    raise ValueError(f"unrecognized wiki slug: {slug!r}")


# ---------------------------------------------------------------------------
# Frontmatter (hand-rolled, deterministic; NOT a general YAML parser — it only
# needs to round-trip what _render_frontmatter itself writes, and avoiding a
# pyyaml dependency keeps this importable in a clean `agentrail` install,
# since pyyaml is not a declared project dependency).
# ---------------------------------------------------------------------------


def _render_frontmatter(fields: Dict[str, Any]) -> str:
    lines = [_FRONTMATTER_DELIM]
    for key, value in fields.items():
        # ensure_ascii=False: keep e.g. em dashes in titles human-readable
        # (matches the spec's illustrated frontmatter) rather than \uXXXX
        # escapes -- json.loads round-trips either form identically.
        lines.append(f"{key}: {json.dumps(value, ensure_ascii=False)}")
    lines.append(_FRONTMATTER_DELIM)
    return "\n".join(lines)


def parse_page(text: str) -> Tuple[Dict[str, Any], str]:
    """Split a compiled page's TEXT into (frontmatter_dict, body_markdown).

    Defensive: text without a well-formed ``---``-delimited frontmatter block
    returns ``({}, text)`` unchanged rather than raising.
    """
    if not text.startswith(_FRONTMATTER_DELIM):
        return {}, text
    lines = text.split("\n")
    end_index: Optional[int] = None
    for index in range(1, len(lines)):
        if lines[index].strip() == _FRONTMATTER_DELIM:
            end_index = index
            break
    if end_index is None:
        return {}, text
    fields: Dict[str, Any] = {}
    for line in lines[1:end_index]:
        if ":" not in line:
            continue
        key, _, raw_value = line.partition(":")
        key = key.strip()
        raw_value = raw_value.strip()
        try:
            fields[key] = json.loads(raw_value)
        except (json.JSONDecodeError, ValueError):
            fields[key] = raw_value
    body = "\n".join(lines[end_index + 1:]).lstrip("\n")
    return fields, body


def _existing_page_hash(page_path: Path) -> Optional[str]:
    try:
        text = page_path.read_text(encoding="utf-8")
    except OSError:
        return None
    fields, _ = parse_page(text)
    value = fields.get("inputsHash")
    return value if isinstance(value, str) else None


# ---------------------------------------------------------------------------
# Hashing (FROZEN semantics — spec S4.2)
# ---------------------------------------------------------------------------


def unit_inputs_hash(unit_files: List[SourceRecord]) -> str:
    """sha256 over the sorted (path, contentHash) pairs of a unit's files."""
    pairs = sorted((record.path, record.contentHash) for record in unit_files)
    return sha256_text(json.dumps(pairs, separators=(",", ":")))


def overview_inputs_hash(unit_hashes: List[str]) -> str:
    """sha256 over all unit inputsHashes, sorted."""
    return sha256_text(json.dumps(sorted(unit_hashes), separators=(",", ":")))


# ---------------------------------------------------------------------------
# Citation post-validation (spec build step 3)
# ---------------------------------------------------------------------------

_BACKTICK_TOKEN_RE = re.compile(r"`([^`]+)`")


def _looks_like_path(token: str) -> bool:
    """Heuristic: a backtick token is a PATH claim (validated against the
    roster) when it contains a path separator or a short file extension.
    Bare symbol/identifier names (e.g. `build_index`) are left untouched —
    only file citations are subject to roster validation."""
    return "/" in token or bool(re.search(r"\.[A-Za-z0-9]{1,6}$", token))


def validate_citations(text: str, roster_paths: set) -> Tuple[str, int]:
    """Strip backtick-quoted path-like tokens not present in ``roster_paths``.

    Keeps the page (never rejects the whole claim) but drops the false
    citation marker so a reader is never pointed at a file the compiler did
    not actually show the model. Returns ``(cleaned_text, removed_count)``.
    """
    removed = 0

    def _sub(match: "re.Match[str]") -> str:
        nonlocal removed
        token = match.group(1)
        if _looks_like_path(token) and token not in roster_paths:
            removed += 1
            return token
        return match.group(0)

    cleaned = _BACKTICK_TOKEN_RE.sub(_sub, text)
    return cleaned, removed


# ---------------------------------------------------------------------------
# Prose truncation guard (spec S4.1: "<= 1,200 output tokens per page")
# ---------------------------------------------------------------------------


def _truncate_prose(responsibility: str, file_notes: Dict[str, str], relationships: str) -> Tuple[str, Dict[str, str], str]:
    notes_len = sum(len(k) + len(v) for k, v in file_notes.items())
    total = len(responsibility) + notes_len + len(relationships)
    if total <= MAX_PROSE_CHARS:
        return responsibility, file_notes, relationships
    budget = max(0, MAX_PROSE_CHARS - len(responsibility) - notes_len)
    if len(relationships) > budget:
        keep = max(0, budget - 16)
        relationships = relationships[:keep].rstrip() + " … (truncated)"
    return responsibility, file_notes, relationships


# ---------------------------------------------------------------------------
# Cost tracking
# ---------------------------------------------------------------------------


@dataclass
class _CostTracker:
    ceiling: float
    total_usd: float = 0.0
    calls: int = 0
    provider_errors: int = 0

    @property
    def exceeded(self) -> bool:
        return self.total_usd >= self.ceiling

    def add(self, usd: float) -> None:
        self.total_usd += usd
        self.calls += 1


# ---------------------------------------------------------------------------
# Provider call seam (ProviderConfig-driven; mirrors embeddings.py's
# run_custom_command for the test seam, and onboard.py/llm_rerank.py's
# _call_model for the headless-CLI production path).
# ---------------------------------------------------------------------------


def _call_claude_cli(model: str, prompt: str) -> Tuple[str, Dict[str, int]]:
    """The ONE network seam for ``claude-cli`` mode (monkeypatch in tests).

    Mirrors ``runner.onboard._call_model`` / ``context.llm_rerank._call_model``
    exactly: headless ``claude -p --output-format json``, agent-session env
    stripped via :func:`sanitized_env`, no ``anthropic`` SDK, no
    ``ANTHROPIC_API_KEY`` dependency. A non-zero exit or a missing ``result``
    raises so the fail-open caller ships a skeleton-only page.
    """
    argv = [_CLAUDE_CLI_BIN, "-p", "--dangerously-skip-permissions", "--output-format", "json", "--model", model]
    completed = subprocess.run(
        argv,
        input=prompt,
        text=True,
        capture_output=True,
        timeout=_CALL_TIMEOUT_SECONDS,
        env=sanitized_env(),
    )
    if completed.returncode != 0:
        raise RuntimeError(f"headless wiki prose call exited {completed.returncode}")
    envelope = json.loads(completed.stdout or "")
    result = envelope.get("result") if isinstance(envelope, dict) else None
    if not isinstance(result, str):
        raise ValueError("headless wiki prose response missing 'result' text")
    raw_usage = envelope.get("usage") if isinstance(envelope, dict) else None
    raw_usage = raw_usage if isinstance(raw_usage, dict) else {}
    usage = {
        "inputTokens": int(raw_usage.get("input_tokens", 0) or 0),
        "outputTokens": int(raw_usage.get("output_tokens", 0) or 0),
    }
    return result, usage


def _call_custom_command(root: Path, provider_cfg: ProviderConfig, prompt: str) -> Tuple[str, Dict[str, int]]:
    """The ``custom-command`` test/injection seam — mirrors
    ``embeddings.run_custom_command`` exactly (shell command, JSON on stdin,
    JSON on stdout), so tests can inject a fake prose provider the same way
    ``test_embedding_setup.py`` injects a fake embedding provider.
    """
    command = provider_cfg.command or provider_cfg.customCommand
    if not command:
        raise RuntimeError("context.summary.command is required for custom-command mode")
    payload = {"mode": "custom-command", "provider": provider_cfg.provider, "model": provider_cfg.model, "prompt": prompt}
    result = subprocess.run(
        command,
        input=f"{json.dumps(payload)}\n",
        text=True,
        shell=True,
        cwd=root,
        env=os.environ.copy(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        suffix = f": {result.stderr.strip()}" if result.stderr.strip() else ""
        raise RuntimeError(f"custom wiki prose command failed with exit {result.returncode}{suffix}")
    parsed = json.loads(result.stdout.strip())
    text = str(parsed.get("text") or parsed.get("result") or "")
    raw_usage = parsed.get("usage") if isinstance(parsed.get("usage"), dict) else {}
    usage = {
        "inputTokens": int(raw_usage.get("inputTokens", 0) or 0),
        "outputTokens": int(raw_usage.get("outputTokens", 0) or 0),
    }
    return text, usage


def _call_prose_model(mode: str, root: Path, provider_cfg: ProviderConfig, model: str, prompt: str) -> Tuple[str, Dict[str, int]]:
    if mode == "claude-cli":
        return _call_claude_cli(model, prompt)
    if mode == "custom-command":
        return _call_custom_command(root, provider_cfg, prompt)
    raise RuntimeError(f"unsupported wiki summary mode: {mode}")


def _parse_prose_json(text: str) -> Optional[Dict[str, Any]]:
    """Model output -> {"responsibility", "fileNotes", "relationships"} (pure,
    defensive). Tolerates an accidental markdown fence and leading/trailing
    prose around the JSON object; returns None on anything unrecoverable so
    the caller falls open to a skeleton-only page."""
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw[:4].lower() == "json":
            raw = raw[4:]
        raw = raw.strip()
    parsed: Any = None
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        start, end = raw.find("{"), raw.rfind("}")
        if 0 <= start < end:
            try:
                parsed = json.loads(raw[start:end + 1])
            except json.JSONDecodeError:
                return None
    if not isinstance(parsed, dict):
        return None
    responsibility = parsed.get("responsibility")
    relationships = parsed.get("relationships")
    if not isinstance(responsibility, str) or not isinstance(relationships, str):
        return None
    file_notes = parsed.get("fileNotes")
    if not isinstance(file_notes, dict):
        file_notes = {}
    return {
        "responsibility": responsibility.strip(),
        "relationships": relationships.strip(),
        "fileNotes": {str(k): str(v).strip() for k, v in file_notes.items() if isinstance(v, (str, int, float))},
    }


def _generate_prose(root: Path, provider_cfg: ProviderConfig, mode: str, model: str, prompt: str, tracker: _CostTracker) -> Tuple[Optional[Dict[str, Any]], str]:
    """Fail-open prose call: returns (parsed_or_None, status). status is one
    of "ok" | "cost_ceiling" | "unavailable" | "error"."""
    if tracker.exceeded:
        return None, "cost_ceiling"
    if mode == "claude-cli" and shutil.which(_CLAUDE_CLI_BIN) is None:
        return None, "unavailable"
    try:
        text, usage = _call_prose_model(mode, root, provider_cfg, model, prompt)
    except Exception as exc:  # noqa: BLE001 - any provider failure falls open
        tracker.provider_errors += 1
        _log.warning("wiki: prose call failed (mode=%s): %s", mode, exc)
        return None, "error"
    cost = cost_for(model, input_tokens=int(usage.get("inputTokens", 0) or 0), output_tokens=int(usage.get("outputTokens", 0) or 0))["dollars"]
    tracker.add(cost)
    parsed = _parse_prose_json(text)
    if parsed is None:
        # The call itself succeeded (already priced above -- a malformed
        # response still cost real tokens) but its content is unusable; this
        # still counts as a provider error for report visibility.
        tracker.provider_errors += 1
        _log.warning("wiki: prose call returned unparseable content (mode=%s)", mode)
        return None, "error"
    return parsed, "ok"


# ---------------------------------------------------------------------------
# Skeleton renderers (pure functions over index/graph data — spec build step 1)
# ---------------------------------------------------------------------------

_KIND_PRIORITY = {"class": 0, "function": 1, "interface": 2, "type": 3, "enum": 4}


def _unit_symbol_defs(unit: Dict[str, Any], symbol_table: Dict[str, List[Dict[str, Any]]]) -> List[Tuple[str, Dict[str, Any]]]:
    """[(name, def), ...] for every symbolTable definition whose file is
    contained by this unit."""
    unit_path = str(unit["path"])
    out: List[Tuple[str, Dict[str, Any]]] = []
    for name, defs in symbol_table.items():
        for definition in defs:
            if unit_contains_path(unit_path, str(definition.get("path") or "")):
                out.append((name, definition))
    return out


def _file_symbol_counts(unit_symbol_defs: List[Tuple[str, Dict[str, Any]]]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for _name, definition in unit_symbol_defs:
        path = str(definition.get("path") or "")
        if path:
            counts[path] = counts.get(path, 0) + 1
    return counts


def _key_exports(unit_symbol_defs: List[Tuple[str, Dict[str, Any]]], cap: int = 12) -> List[str]:
    """Deterministic top exported symbol names: one entry per distinct name,
    ranked by (kind priority, defining path, line), so output is stable
    regardless of symbol_table iteration order."""
    best: Dict[str, Tuple[int, str, int]] = {}
    for name, definition in unit_symbol_defs:
        key = (_KIND_PRIORITY.get(str(definition.get("kind")), 9), str(definition.get("path") or ""), int(definition.get("lineStart", 0) or 0))
        if name not in best or key < best[name]:
            best[name] = key
    ordered = sorted(best.items(), key=lambda item: (item[1][0], item[1][1], item[1][2], item[0]))
    return [name for name, _key in ordered[:cap]]


def _select_roster(unit_files: List[SourceRecord], symbol_counts: Dict[str, int], cap: int = UNIT_ROSTER_CAP) -> List[SourceRecord]:
    ranked = sorted(unit_files, key=lambda record: (-symbol_counts.get(record.path, 0), record.path))
    return ranked[:cap]


def _file_head(record: SourceRecord, *, max_lines: int = FILE_HEAD_LINES, max_chars: int = FILE_HEAD_MAX_CHARS) -> str:
    content = record.content or ""
    head = "\n".join(content.splitlines()[:max_lines])
    return head[:max_chars]


def _build_file_heads(roster: List[SourceRecord], *, char_budget: int = PROMPT_CHAR_BUDGET) -> List[Tuple[str, str]]:
    heads: List[Tuple[str, str]] = []
    used = 0
    for record in roster:
        head = _file_head(record)
        if not head.strip():
            continue
        if heads and used + len(head) > char_budget:
            break
        heads.append((record.path, head))
        used += len(head)
    return heads


def _unit_dependency_names(unit_id: str, id_to_name: Dict[str, str], unit_depends_on_edges: List[Dict[str, Any]]) -> Tuple[List[str], List[str]]:
    depends_on = sorted({id_to_name.get(str(edge.get("toUnitId")), str(edge.get("toUnitId"))) for edge in unit_depends_on_edges if edge.get("fromUnitId") == unit_id})
    depended_by = sorted({id_to_name.get(str(edge.get("fromUnitId")), str(edge.get("fromUnitId"))) for edge in unit_depends_on_edges if edge.get("toUnitId") == unit_id})
    return depends_on, depended_by


def _unit_dependency_slugs(unit_id: str, units_by_id: Dict[str, Dict[str, Any]], unit_depends_on_edges: List[Dict[str, Any]]) -> Tuple[List[str], List[str]]:
    """Directed unit_depends_on neighbors as PAGE SLUGS -- sibling of
    :func:`_unit_dependency_names` (which renders human-readable NAMES into
    the body's "Structure" section): same edges, slug-shaped instead of
    name-shaped, for the structured ``skeleton``/``links`` fields spec S4.4
    promises the server ("the [[slug]] graph + unit_depends_on rollup so
    navigation needs no markdown parsing"). A neighbor id absent from
    ``units_by_id`` is skipped rather than guessed at (should not happen --
    ``units_by_id`` covers every unit the graph knows about, included or
    capped-out).
    """
    depends_on = sorted({
        unit_slug(units_by_id[str(edge.get("toUnitId"))])
        for edge in unit_depends_on_edges
        if edge.get("fromUnitId") == unit_id and str(edge.get("toUnitId")) in units_by_id
    })
    depended_by = sorted({
        unit_slug(units_by_id[str(edge.get("fromUnitId"))])
        for edge in unit_depends_on_edges
        if edge.get("toUnitId") == unit_id and str(edge.get("fromUnitId")) in units_by_id
    })
    return depends_on, depended_by


def _unit_related_slugs(unit_id: str, units_by_id: Dict[str, Dict[str, Any]], unit_depends_on_edges: List[Dict[str, Any]]) -> List[str]:
    neighbor_ids: set = set()
    for edge in unit_depends_on_edges:
        if edge.get("fromUnitId") == unit_id:
            neighbor_ids.add(str(edge.get("toUnitId")))
        elif edge.get("toUnitId") == unit_id:
            neighbor_ids.add(str(edge.get("fromUnitId")))
    slugs = sorted(unit_slug(units_by_id[uid]) for uid in neighbor_ids if uid in units_by_id)
    slugs.append(OVERVIEW_SLUG)
    return slugs


def _pluralize(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def _unit_structure_lines(node: Dict[str, Any], exports: List[str], depends_on: List[str], depended_by: List[str]) -> List[str]:
    file_count = int(node.get("fileCount", 0) or 0)
    symbol_count = int(node.get("symbolCount", 0) or 0)
    test_count = int(node.get("testCount", 0) or 0)
    exports_text = ", ".join(exports) if exports else "(none detected)"
    lines = [f"- {_pluralize(file_count, 'file')}, {_pluralize(symbol_count, 'symbol')}; key exports: {exports_text}"]
    dep_parts = []
    if depends_on:
        dep_parts.append("Depends on: " + ", ".join(depends_on) + ".")
    if depended_by:
        dep_parts.append("Depended on by: " + ", ".join(depended_by) + ".")
    lines.append("- " + " ".join(dep_parts) if dep_parts else "- No cross-unit dependencies detected.")
    lines.append(f"- Tests: {_pluralize(test_count, 'test file')} in this unit.")
    return lines


def _overview_structure_lines(included: List[Dict[str, Any]], nodes_by_unit_id: Dict[str, Dict[str, Any]], dropped_count: int) -> List[str]:
    lines = []
    for unit in included:
        node = nodes_by_unit_id.get(unit["id"], {})
        name = unit.get("name") or unit["path"]
        lines.append(
            f"- {name} (`{unit['path']}`): {int(node.get('fileCount', 0) or 0)} files, "
            f"{int(node.get('symbolCount', 0) or 0)} symbols, {int(node.get('testCount', 0) or 0)} tests"
        )
    if dropped_count:
        lines.append(f"- … and {dropped_count} more unit(s) not shown (capped at {MAX_UNIT_PAGES}; see compile-report.json).")
    return lines


def _overview_dependency_lines(id_to_name: Dict[str, str], unit_depends_on_edges: List[Dict[str, Any]]) -> List[str]:
    lines = []
    for edge in sorted(unit_depends_on_edges, key=lambda e: (str(e.get("fromUnitId")), str(e.get("toUnitId")))):
        from_name = id_to_name.get(str(edge.get("fromUnitId")), str(edge.get("fromUnitId")))
        to_name = id_to_name.get(str(edge.get("toUnitId")), str(edge.get("toUnitId")))
        count = int(edge.get("importCount", 0) or 0)
        lines.append(f"- {from_name} -> {to_name} ({_pluralize(count, 'import')})")
    return lines


def _overview_doc_heads(records: List[SourceRecord]) -> List[Tuple[str, str]]:
    by_path = {record.path: record for record in records}
    heads: List[Tuple[str, str]] = []
    for path in _OVERVIEW_DOC_CANDIDATES:
        record = by_path.get(path)
        if record is not None and record.content:
            heads.append((path, _file_head(record)))
    return heads


# ---------------------------------------------------------------------------
# Prompts (grounded ONLY in the skeleton + bounded file heads — spec build step 3)
# ---------------------------------------------------------------------------

_UNIT_PROMPT_INSTRUCTIONS = """You are writing one page of a compiled repository wiki for AI coding agents.
You are given a DETERMINISTIC skeleton (file roster, exported symbols,
dependency edges, test counts) for one codebase unit, plus bounded excerpts
of its highest-signal files. Do not invent files, structure, or
relationships that are not shown below — describe only what the skeleton and
excerpts support. Every path you cite MUST be wrapped in backticks and MUST
be copied verbatim from the file roster below; never cite a path that is not
in the roster.

Reply with ONLY a JSON object with exactly these keys:
  "responsibility": 3-6 sentences on what this unit is responsible for.
  "fileNotes": an object mapping EVERY roster path to a single-sentence role
    description.
  "relationships": 2-5 sentences on how this unit relates to its
    dependencies/dependents and any invariants a caller must respect — every
    claim citing a roster path in backticks.
No prose outside the JSON object, no markdown fences."""

_OVERVIEW_PROMPT_INSTRUCTIONS = """You are writing the top-level overview page of a compiled repository wiki for
AI coding agents. You are given a DETERMINISTIC roster of codebase units and
their dependency edges, plus excerpts of the repository's own top-level docs
(when present). Do not invent units, files, or relationships not shown
below. Every path you cite MUST be wrapped in backticks and copied verbatim
from the unit roster below.

Reply with ONLY a JSON object with exactly these keys:
  "responsibility": 3-6 sentences on what this repository/product is.
  "fileNotes": an object mapping EVERY roster unit path to a single-sentence
    description of what it does.
  "relationships": 2-5 sentences on how the units relate to each other —
    every claim citing a roster unit path in backticks.
No prose outside the JSON object, no markdown fences."""


def build_unit_prompt(unit_name: str, unit_path: str, roster_paths: List[str], structure_lines: List[str], file_heads: List[Tuple[str, str]]) -> str:
    lines = [
        _UNIT_PROMPT_INSTRUCTIONS,
        "",
        f"Codebase unit: {unit_name} (`{unit_path}`)",
        "",
        "Deterministic structure:",
        *structure_lines,
        "",
        "File roster (cite ONLY these paths):",
        *[f"- {path}" for path in roster_paths],
        "",
        "File excerpts:",
    ]
    for path, head in file_heads:
        lines.append(f"--- {path} ---")
        lines.append(head)
    return "\n".join(lines)


def build_overview_prompt(roster_paths: List[str], structure_lines: List[str], dependency_lines: List[str], doc_heads: List[Tuple[str, str]]) -> str:
    lines = [
        _OVERVIEW_PROMPT_INSTRUCTIONS,
        "",
        "Codebase units:",
        *structure_lines,
        "",
        "Unit dependency edges:",
        *(dependency_lines or ["(none detected)"]),
        "",
        "Unit roster (cite ONLY these paths):",
        *[f"- {path}" for path in roster_paths],
    ]
    if doc_heads:
        lines.append("")
        lines.append("Repository docs:")
        for path, head in doc_heads:
            lines.append(f"--- {path} ---")
            lines.append(head)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Page assembly (frozen body layout — spec S4.1)
# ---------------------------------------------------------------------------


def _render_page_body(*, commit_sha: str, responsibility: str, structure_lines: List[str], roster_lines: List[str], relationships: str, related_slugs: List[str]) -> str:
    parts = [
        f"> Compiled from source at {commit_sha}. Verify claims against the cited files; the source is authoritative.",
        "",
        "## Responsibility",
        responsibility.strip(),
        "",
        "## Structure",
        "\n".join(structure_lines) if structure_lines else "_(no structure detected)_",
        "",
        "## Key files",
        "\n".join(roster_lines) if roster_lines else "_(no files detected)_",
        "",
        "## Relationships & invariants",
        relationships.strip(),
    ]
    if related_slugs:
        parts.append("")
        parts.append("Related: " + ", ".join(f"[[{slug}]]" for slug in related_slugs))
    return "\n".join(parts).rstrip() + "\n"


def _unit_title(unit: Dict[str, Any]) -> str:
    return f"{unit['path']} — {unit.get('name') or unit['path']}"


def render_unit_page(*, unit: Dict[str, Any], node: Dict[str, Any], commit_sha: str, generated_at: str, model: str, inputs_hash: str, roster: List[SourceRecord], structure_lines: List[str], prose: Dict[str, Any], related_slugs: List[str]) -> Tuple[str, int]:
    slug = unit_slug(unit)
    title = _unit_title(unit)
    roster_paths = {record.path for record in roster}
    responsibility = prose.get("responsibility") or _PROSE_UNAVAILABLE
    relationships_raw = prose.get("relationships") or _PROSE_UNAVAILABLE
    file_notes = prose.get("fileNotes") or {}
    relationships, removed = validate_citations(relationships_raw, roster_paths)
    roster_lines = [f"- {record.path} — {file_notes.get(record.path, '_(prose unavailable)_')}" for record in roster]
    body = _render_page_body(commit_sha=commit_sha, responsibility=responsibility, structure_lines=structure_lines, roster_lines=roster_lines, relationships=relationships, related_slugs=related_slugs)
    frontmatter = _render_frontmatter({
        "slug": slug,
        "title": title,
        "kind": "unit",
        "commitSha": commit_sha,
        "inputsHash": inputs_hash,
        "generatedAt": generated_at,
        "model": model,
        "citations": sorted(roster_paths),
    })
    return frontmatter + "\n\n" + body, removed


def render_overview_page(*, root_name: str, commit_sha: str, generated_at: str, model: str, inputs_hash: str, units: List[Dict[str, Any]], structure_lines: List[str], dependency_lines: List[str], prose: Dict[str, Any], related_slugs: List[str]) -> Tuple[str, int]:
    title = f"{root_name} — repo overview"
    roster_paths = {unit["path"] for unit in units}
    responsibility = prose.get("responsibility") or _PROSE_UNAVAILABLE
    relationships_raw = prose.get("relationships") or _PROSE_UNAVAILABLE
    unit_notes = prose.get("fileNotes") or {}
    relationships, removed = validate_citations(relationships_raw, roster_paths)
    roster_lines = [f"- {unit['path']} — {unit_notes.get(unit['path'], '_(prose unavailable)_')}" for unit in units]
    combined_structure = list(structure_lines)
    if dependency_lines:
        combined_structure.append("")
        combined_structure.append("Unit dependency edges:")
        combined_structure.extend(dependency_lines)
    body = _render_page_body(commit_sha=commit_sha, responsibility=responsibility, structure_lines=combined_structure, roster_lines=roster_lines, relationships=relationships, related_slugs=related_slugs)
    frontmatter = _render_frontmatter({
        "slug": OVERVIEW_SLUG,
        "title": title,
        "kind": "overview",
        "commitSha": commit_sha,
        "inputsHash": inputs_hash,
        "generatedAt": generated_at,
        "model": model,
        "citations": sorted(roster_paths),
    })
    return frontmatter + "\n\n" + body, removed


# ---------------------------------------------------------------------------
# Skeleton bundle (spec S4.2/S4.4: "the same data the skeleton renderer
# already computes" -- computed ONCE per unit regardless of page reuse, so
# both the prose prompt/rendered body AND manifest.json's structured
# skeleton/links fields are grounded in exactly the same numbers)
# ---------------------------------------------------------------------------


def _build_unit_skeleton(
    unit: Dict[str, Any],
    node: Dict[str, Any],
    unit_files: List[SourceRecord],
    symbol_table: Dict[str, List[Dict[str, Any]]],
    units_by_id: Dict[str, Dict[str, Any]],
    id_to_name: Dict[str, str],
    unit_depends_on_edges: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """All-deterministic per-unit inputs: file roster, exported symbols,
    unit_depends_on in/out, unit path. Independent of whether the page text
    ends up reused or regenerated this run (see :func:`compile_wiki`'s
    per-unit loop) -- a page reuse must never leave manifest.json's
    ``skeleton``/``links`` stale, so this is computed unconditionally.
    """
    symbol_defs = _unit_symbol_defs(unit, symbol_table)
    file_counts = _file_symbol_counts(symbol_defs)
    roster = _select_roster(unit_files, file_counts)
    exports = _key_exports(symbol_defs)
    depends_on_names, depended_by_names = _unit_dependency_names(unit["id"], id_to_name, unit_depends_on_edges)
    depends_on_slugs, depended_by_slugs = _unit_dependency_slugs(unit["id"], units_by_id, unit_depends_on_edges)
    structure_lines = _unit_structure_lines(node, exports, depends_on_names, depended_by_names)
    related_slugs = _unit_related_slugs(unit["id"], units_by_id, unit_depends_on_edges)
    return {
        "roster": roster,
        "exports": exports,
        "structure_lines": structure_lines,
        "related_slugs": related_slugs,
        # Serialized verbatim into manifest.json (spec: "serialized instead
        # of only rendered into markdown") -- wiki-tree.ts reads
        # skeleton.path/skeleton.files by these exact keys.
        "manifest_skeleton": {
            "path": unit["path"],
            "files": [record.path for record in roster],
            "exports": list(exports),
            "dependsOn": depends_on_slugs,
            "dependedOnBy": depended_by_slugs,
        },
        "manifest_links": {
            "related": related_slugs,
            "dependsOn": depends_on_slugs,
            "dependedOnBy": depended_by_slugs,
        },
    }


# ---------------------------------------------------------------------------
# Per-page compile (skeleton + prose, ALWAYS regenerates — caller decides reuse)
# ---------------------------------------------------------------------------


def _compile_unit_page_text(
    root: Path,
    cfg: ContextConfig,
    mode: str,
    model: str,
    unit: Dict[str, Any],
    node: Dict[str, Any],
    skeleton: Dict[str, Any],
    commit_sha: str,
    inputs_hash: str,
    tracker: _CostTracker,
) -> Tuple[str, int]:
    generated_at = now_iso()
    roster = skeleton["roster"]
    structure_lines = skeleton["structure_lines"]
    related = skeleton["related_slugs"]

    provider_available = mode in {"claude-cli", "custom-command"}
    prose: Dict[str, Any] = {}
    used_model = "skeleton-only"
    if roster and provider_available:
        heads = _build_file_heads(roster)
        prompt = build_unit_prompt(str(unit.get("name") or unit["path"]), str(unit["path"]), [record.path for record in roster], structure_lines, heads)
        parsed, status = _generate_prose(root, cfg.summary, mode, model, prompt, tracker)
        if status == "ok" and parsed is not None:
            responsibility, file_notes, relationships = _truncate_prose(parsed["responsibility"], parsed["fileNotes"], parsed["relationships"])
            prose = {"responsibility": responsibility, "fileNotes": file_notes, "relationships": relationships}
            used_model = model

    return render_unit_page(
        unit=unit,
        node=node,
        commit_sha=commit_sha,
        generated_at=generated_at,
        model=used_model,
        inputs_hash=inputs_hash,
        roster=roster,
        structure_lines=structure_lines,
        prose=prose,
        related_slugs=related,
    )


def _compile_overview_page_text(
    root: Path,
    cfg: ContextConfig,
    mode: str,
    model: str,
    included: List[Dict[str, Any]],
    dropped_count: int,
    nodes_by_unit_id: Dict[str, Dict[str, Any]],
    id_to_name: Dict[str, str],
    unit_depends_on_edges: List[Dict[str, Any]],
    records: List[SourceRecord],
    commit_sha: str,
    inputs_hash: str,
    tracker: _CostTracker,
) -> Tuple[str, int]:
    generated_at = now_iso()
    structure_lines = _overview_structure_lines(included, nodes_by_unit_id, dropped_count)
    dependency_lines = _overview_dependency_lines(id_to_name, unit_depends_on_edges)
    related = sorted(unit_slug(unit) for unit in included)

    provider_available = mode in {"claude-cli", "custom-command"}
    prose: Dict[str, Any] = {}
    used_model = "skeleton-only"
    if included and provider_available:
        doc_heads = _overview_doc_heads(records)
        prompt = build_overview_prompt([unit["path"] for unit in included], structure_lines, dependency_lines, doc_heads)
        parsed, status = _generate_prose(root, cfg.summary, mode, model, prompt, tracker)
        if status == "ok" and parsed is not None:
            responsibility, unit_notes, relationships = _truncate_prose(parsed["responsibility"], parsed["fileNotes"], parsed["relationships"])
            prose = {"responsibility": responsibility, "fileNotes": unit_notes, "relationships": relationships}
            used_model = model

    return render_overview_page(
        root_name=root.name or "repository",
        commit_sha=commit_sha,
        generated_at=generated_at,
        model=used_model,
        inputs_hash=inputs_hash,
        units=included,
        structure_lines=structure_lines,
        dependency_lines=dependency_lines,
        prose=prose,
        related_slugs=related,
    )


# ---------------------------------------------------------------------------
# wiki_doc SourceRecord minting (spec: "ingested as SourceRecords ... chunked
# and posted like any source" — reuses index.chunks_for_source verbatim so
# wiki pages get the same heading-aware markdown chunking every other doc gets)
# ---------------------------------------------------------------------------


def _mint_wiki_source(root: Path, page_path: Path, full_text: str) -> Tuple[SourceRecord, List[ChunkRecord]]:
    relative_path = to_posix(page_path.relative_to(root))
    fields, _ = parse_page(full_text)
    generated_at = fields.get("generatedAt") if isinstance(fields.get("generatedAt"), str) else now_iso()
    redacted = redact_text(full_text)
    content = redacted.text
    content_hash = sha256_text(content)
    refs = linked_refs_from_text(content)
    record = SourceRecord(
        id=f"source:{relative_path}",
        sourceType=SOURCE_TYPE,
        path=relative_path,
        contentHash=content_hash,
        modifiedAt=generated_at,
        freshness=Freshness("current", generated_at, None),
        authority=AUTHORITY,
        visibility="redacted" if redacted.findings else "local",
        linkedIssues=refs["linkedIssues"],
        linkedPullRequests=refs["linkedPullRequests"],
        chunkIds=[],
        auditRef=audit_ref_for(relative_path),
        redactions=list(redacted.findings),
        content=content,
    )
    chunks = chunks_for_source(record, relative_path, content)
    record.chunkIds = [chunk.id for chunk in chunks]
    return record, chunks


# ---------------------------------------------------------------------------
# Compile orchestration
# ---------------------------------------------------------------------------


def compile_wiki(
    root: Path,
    cfg: ContextConfig,
    *,
    records: List[SourceRecord],
    graph: Dict[str, Any],
    symbol_table: Dict[str, List[Dict[str, Any]]],
    commit_sha: str,
    built_at: str,
    force: bool = False,
) -> Dict[str, Any]:
    """Compile the repo wiki: skeleton + bounded prose, local-only (spec S4.2).

    Writes ``.agentrail/context/wiki/*.md`` + ``manifest.json`` +
    ``compile-report.json`` and returns ``{"records": [...new wiki_doc
    SourceRecords...], "chunks": [...their ChunkRecords...], "report":
    {...compile-report dict...}}`` for the caller (index.build_index) to merge
    into the in-memory index before it is serialized.

    Incremental at PAGE grain: a page whose recomputed ``inputsHash`` matches
    its existing on-disk frontmatter is read back byte-identical, never
    rewritten and never re-prompted (zero cost). ``force`` (or the
    ``AGENTRAIL_CONTEXT_WIKI_FORCE=1`` env escape hatch used by ``agentrail
    context wiki build --force``) bypasses that reuse for one call.

    Fail-open per page: a prose-provider error, missing ``claude`` binary, or
    a breached cost ceiling (:func:`wiki_max_cost_usd`) ships that page
    skeleton-only — this function itself never raises for provider reasons.
    """
    start = time.monotonic()
    force = force or _env_force_enabled()
    mode = cfg.summary.mode
    model = cfg.summary.model or DEFAULT_PROSE_MODEL
    wiki_dir = wiki_dir_for(root)

    unit_nodes = [node for node in graph.get("nodes", []) if node.get("kind") == "codebase_unit"]
    units_all = [{"id": str(node["unitId"]), "name": node.get("name"), "path": node.get("path")} for node in unit_nodes]
    nodes_by_unit_id = {str(node["unitId"]): node for node in unit_nodes}
    units_by_id = {unit["id"]: unit for unit in units_all}
    id_to_name = {unit["id"]: str(unit.get("name") or unit.get("path")) for unit in units_all}
    unit_depends_on_edges = [edge for edge in graph.get("edges", []) if edge.get("kind") == "unit_depends_on"]

    ranked_units = sorted(units_all, key=lambda unit: (-int(nodes_by_unit_id.get(unit["id"], {}).get("fileCount", 0) or 0), unit["id"]))
    included = ranked_units[:MAX_UNIT_PAGES]
    dropped = ranked_units[MAX_UNIT_PAGES:]
    if dropped:
        append_audit(root, {
            "event": "wiki_compile",
            "action": "unit_pages_capped",
            "cap": MAX_UNIT_PAGES,
            "totalUnits": len(units_all),
            "dropped": [unit["id"] for unit in dropped],
        })

    tracker = _CostTracker(ceiling=wiki_max_cost_usd())
    citations_removed = 0
    pages_written = 0
    pages_reused = 0
    manifest_pages: List[Dict[str, Any]] = []
    new_records: List[SourceRecord] = []
    new_chunks: List[ChunkRecord] = []
    unit_hashes: List[str] = []

    non_wiki_records = [record for record in records if record.sourceType != SOURCE_TYPE]

    for unit in included:
        node = nodes_by_unit_id.get(unit["id"], {})
        unit_files = sorted((record for record in non_wiki_records if unit_contains_path(str(unit["path"]), record.path)), key=lambda record: record.path)
        inputs_hash = unit_inputs_hash(unit_files)
        unit_hashes.append(inputs_hash)
        slug = unit_slug(unit)
        page_path = wiki_dir / slug_to_filename(slug)
        # Deterministic skeleton bundle -- computed regardless of reuse (see
        # _build_unit_skeleton's docstring) so manifest.json's skeleton/links
        # are never stale even when the page .md itself is reused untouched.
        skeleton = _build_unit_skeleton(unit, node, unit_files, symbol_table, units_by_id, id_to_name, unit_depends_on_edges)

        existing_hash = None if force else _existing_page_hash(page_path)
        if existing_hash == inputs_hash and page_path.is_file():
            full_text = page_path.read_text(encoding="utf-8")
            pages_reused += 1
        else:
            full_text, removed = _compile_unit_page_text(
                root, cfg, mode, model, unit, node, skeleton, commit_sha, inputs_hash, tracker,
            )
            citations_removed += removed
            page_path.parent.mkdir(parents=True, exist_ok=True)
            page_path.write_text(full_text, encoding="utf-8")
            pages_written += 1

        record, chunks = _mint_wiki_source(root, page_path, full_text)
        new_records.append(record)
        new_chunks.extend(chunks)
        manifest_pages.append({
            "slug": slug,
            "title": _unit_title(unit),
            "file": to_posix(page_path.relative_to(root)),
            "inputsHash": inputs_hash,
            "stale": False,
            "skeleton": skeleton["manifest_skeleton"],
            "links": skeleton["manifest_links"],
        })

    overview_hash = overview_inputs_hash(unit_hashes)
    overview_path = wiki_dir / "overview.md"
    # Overview has no single unit "path" of its own -- its skeleton/links
    # shape is the unit roster + the neighbor slugs, not the per-unit
    # {path, files, dependsOn/dependedOnBy edges} shape (it isn't a node in
    # the unit_depends_on graph).
    overview_related = sorted(unit_slug(unit) for unit in included)
    overview_skeleton = {
        "units": [unit["path"] for unit in included],
        "unitCount": len(included),
        "droppedCount": len(dropped),
        "dependsOn": [],
        "dependedOnBy": [],
    }
    overview_links = {"related": overview_related, "dependsOn": [], "dependedOnBy": []}
    existing_overview_hash = None if force else _existing_page_hash(overview_path)
    if existing_overview_hash == overview_hash and overview_path.is_file():
        overview_text = overview_path.read_text(encoding="utf-8")
        pages_reused += 1
    else:
        overview_text, removed = _compile_overview_page_text(
            root, cfg, mode, model, included, len(dropped), nodes_by_unit_id, id_to_name,
            unit_depends_on_edges, non_wiki_records, commit_sha, overview_hash, tracker,
        )
        citations_removed += removed
        overview_path.parent.mkdir(parents=True, exist_ok=True)
        overview_path.write_text(overview_text, encoding="utf-8")
        pages_written += 1

    record, chunks = _mint_wiki_source(root, overview_path, overview_text)
    new_records.append(record)
    new_chunks.extend(chunks)
    manifest_pages.insert(0, {
        "slug": OVERVIEW_SLUG,
        "title": f"{root.name or 'repository'} — repo overview",
        "file": to_posix(overview_path.relative_to(root)),
        "inputsHash": overview_hash,
        "stale": False,
        "skeleton": overview_skeleton,
        "links": overview_links,
    })

    manifest = {"compiledAt": built_at, "commitSha": commit_sha, "pages": manifest_pages}
    write_json(wiki_dir / "manifest.json", manifest)

    duration_ms = int((time.monotonic() - start) * 1000)
    report: Dict[str, Any] = {
        "commitSha": commit_sha,
        "pagesWritten": pages_written,
        "pagesReused": pages_reused,
        "costUsd": round(tracker.total_usd, 6),
        "model": model,
        "durationMs": duration_ms,
        "generatedAt": now_iso(),
        "unitsTotal": len(units_all),
        "unitsIncluded": len(included),
        "unitsDropped": [unit["id"] for unit in dropped],
        "citationsRemoved": citations_removed,
        "providerErrors": tracker.provider_errors,
        "llmCalls": tracker.calls,
        "costCeilingUsd": tracker.ceiling,
        "costCeilingExceeded": tracker.exceeded,
    }
    write_json(wiki_dir / "compile-report.json", report)
    append_audit(root, {
        "event": "wiki_compile",
        "action": "compiled",
        "pagesWritten": pages_written,
        "pagesReused": pages_reused,
        "costUsd": report["costUsd"],
        "model": model,
    })

    return {"records": new_records, "chunks": new_chunks, "report": report}


# ---------------------------------------------------------------------------
# Push assembly (spec S4.4 contract 1: POST /api/v1/ingest/wiki-pages,
# apps/console/app/api/v1/ingest/wiki-pages/route.ts) -- read-only; never
# triggers a compile, never touches the network itself.
# ---------------------------------------------------------------------------

# The `writtenBy` tag pushed pages carry -- mirrors onboard.py's memory items
# tagging `written_by="onboarder"`; forwarded through unchanged by the ingest
# route (route.test.ts: "forwards optional fields ... through unchanged").
WIKI_WRITTEN_BY = "wiki-compiler"


def assemble_wiki_pages(root: Path) -> Tuple[List[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Read manifest.json + page files + compile-report.json under
    ``.agentrail/context/wiki/`` and shape them into the EXACT
    ``POST /api/v1/ingest/wiki-pages`` wire contract: ``pages``, each
    ``{slug, title, kind, bodyMd, skeleton, links, citations, commitSha,
    inputsHash, model, writtenBy, generatedAt}``, plus an optional
    ``compile_event`` (``{commitSha, pagesWritten, pagesReused, costUsd,
    model, durationMs}``) read straight off ``compile-report.json``.

    Pure and read-only: this function itself never compiles anything and
    never touches the network -- it is the thin translation layer the push
    wiring (onboard.py / ``agentrail context index``) calls AFTER a compile,
    to build :func:`agentrail.context.wiki_push.push_wiki_pages`'s ``pages``
    / ``compile_event`` arguments. Returns ``([], None)`` when nothing has
    been compiled yet (no manifest.json, or it is unreadable) -- the caller
    can pass that straight to ``push_wiki_pages``, which already treats an
    empty ``pages`` + ``None`` ``compile_event`` as "nothing to send".
    """
    root = Path(root).resolve()
    wiki_dir = wiki_dir_for(root)

    try:
        manifest = json.loads((wiki_dir / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return [], None
    manifest_pages = manifest.get("pages") if isinstance(manifest, dict) else None
    manifest_commit_sha = str(manifest.get("commitSha") or "") if isinstance(manifest, dict) else ""

    pages: List[Dict[str, Any]] = []
    for entry in manifest_pages if isinstance(manifest_pages, list) else []:
        if not isinstance(entry, dict):
            continue
        slug = entry.get("slug")
        file_rel = entry.get("file")
        if not isinstance(slug, str) or not slug or not isinstance(file_rel, str) or not file_rel:
            continue
        try:
            text = (root / file_rel).read_text(encoding="utf-8")
        except OSError:
            continue
        fields, body = parse_page(text)

        kind = fields.get("kind")
        if kind not in ("overview", "unit"):
            kind = "overview" if slug == OVERVIEW_SLUG else "unit"
        title = fields.get("title")
        if not isinstance(title, str) or not title:
            title = entry.get("title") if isinstance(entry.get("title"), str) else ""
        citations = fields.get("citations")
        citations = [str(c) for c in citations] if isinstance(citations, list) else []
        commit_sha = fields.get("commitSha")
        commit_sha = commit_sha if isinstance(commit_sha, str) and commit_sha else manifest_commit_sha
        inputs_hash = entry.get("inputsHash")
        if not isinstance(inputs_hash, str) or not inputs_hash:
            raw_hash = fields.get("inputsHash")
            inputs_hash = raw_hash if isinstance(raw_hash, str) else ""
        model = fields.get("model")
        model = model if isinstance(model, str) and model else None
        generated_at = fields.get("generatedAt")
        generated_at = generated_at if isinstance(generated_at, str) else ""
        skeleton = entry.get("skeleton")
        skeleton = skeleton if isinstance(skeleton, dict) else {}
        links = entry.get("links")
        if not isinstance(links, dict):
            links = {"related": [], "dependsOn": [], "dependedOnBy": []}

        pages.append({
            "slug": slug,
            "title": title,
            "kind": kind,
            "bodyMd": body,
            "skeleton": skeleton,
            "links": links,
            "citations": citations,
            "commitSha": commit_sha,
            "inputsHash": inputs_hash,
            "model": model,
            "writtenBy": WIKI_WRITTEN_BY,
            "generatedAt": generated_at,
        })

    compile_event: Optional[Dict[str, Any]] = None
    try:
        report = json.loads((wiki_dir / "compile-report.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        report = None
    if isinstance(report, dict):
        try:
            compile_event = {
                "commitSha": str(report.get("commitSha") or ""),
                "pagesWritten": int(report.get("pagesWritten") or 0),
                "pagesReused": int(report.get("pagesReused") or 0),
                "costUsd": float(report.get("costUsd") or 0.0),
                "model": str(report.get("model") or ""),
                "durationMs": int(report.get("durationMs") or 0),
            }
        except (TypeError, ValueError):
            compile_event = None

    return pages, compile_event


# ---------------------------------------------------------------------------
# Read-only status / show (CLI-facing; never compile, never call a provider)
# ---------------------------------------------------------------------------


class WikiPageNotFoundError(Exception):
    pass


def wiki_status(root: Path) -> Dict[str, Any]:
    """Per-page slug/hash/stale/age table from the manifest vs the current
    (already-built) index — READ-ONLY, never triggers a compile."""
    root = root.resolve()
    manifest_path = wiki_dir_for(root) / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"compiled": False, "compiledAt": None, "commitSha": None, "pages": []}

    current_hashes = _current_unit_hashes(root)

    pages = []
    now = datetime.now(timezone.utc)
    for entry in manifest.get("pages", []) if isinstance(manifest.get("pages"), list) else []:
        slug = entry.get("slug")
        page_path = root / str(entry.get("file") or "")
        fields: Dict[str, Any] = {}
        if page_path.is_file():
            try:
                fields, _ = parse_page(page_path.read_text(encoding="utf-8"))
            except OSError:
                fields = {}
        generated_at = fields.get("generatedAt")
        age_seconds = _age_seconds(generated_at, now)
        current_hash = current_hashes.get(slug)
        pages.append({
            "slug": slug,
            "file": entry.get("file"),
            "inputsHash": entry.get("inputsHash"),
            "currentInputsHash": current_hash,
            "stale": current_hash is not None and current_hash != entry.get("inputsHash"),
            "generatedAt": generated_at if isinstance(generated_at, str) else None,
            "ageSeconds": age_seconds,
            "model": fields.get("model"),
        })
    return {"compiled": True, "compiledAt": manifest.get("compiledAt"), "commitSha": manifest.get("commitSha"), "pages": pages}


def _age_seconds(generated_at: Any, now: datetime) -> Optional[float]:
    if not isinstance(generated_at, str):
        return None
    iso = generated_at[:-1] + "+00:00" if generated_at.endswith("Z") else generated_at
    try:
        parsed = datetime.fromisoformat(iso)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return (now - parsed).total_seconds()


def _current_unit_hashes(root: Path) -> Dict[str, str]:
    """Recompute every unit's CURRENT inputsHash from the on-disk index (the
    same index ``agentrail context index`` last wrote — this does not rebuild
    it), for ``wiki_status``'s live staleness comparison."""
    from agentrail.context.index import _source_record_from_json, load_index  # deferred: read-only path

    try:
        index_data = load_index(root)
    except OSError:
        return {}
    graph = index_data.get("graph") or {}
    records = [
        _source_record_from_json(raw)
        for raw in index_data.get("records") or []
        if isinstance(raw, dict) and raw.get("sourceType") != SOURCE_TYPE
    ]
    unit_nodes = [node for node in graph.get("nodes", []) if node.get("kind") == "codebase_unit"]
    hashes: Dict[str, str] = {}
    for node in unit_nodes:
        unit = {"id": str(node["unitId"]), "name": node.get("name"), "path": node.get("path")}
        unit_files = [record for record in records if unit_contains_path(str(unit["path"]), record.path)]
        hashes[unit_slug(unit)] = unit_inputs_hash(unit_files)
    if hashes:
        hashes[OVERVIEW_SLUG] = overview_inputs_hash(sorted(hashes.values()))
    return hashes


def wiki_show(root: Path, slug: str) -> Dict[str, Any]:
    """Read one compiled page — READ-ONLY, never triggers a compile."""
    root = root.resolve()
    filename = slug_to_filename(slug)
    page_path = wiki_dir_for(root) / filename
    try:
        text = page_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise WikiPageNotFoundError(f"no wiki page for slug {slug!r} (looked for {to_posix(page_path.relative_to(root))})") from exc
    fields, body = parse_page(text)
    return {"slug": slug, "file": to_posix(page_path.relative_to(root)), "frontmatter": fields, "body": body, "text": text}
