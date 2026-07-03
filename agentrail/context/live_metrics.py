"""Read-grounded live context metrics (issue #1037).

Replaces the always-zero, gameable ``precision_at_budget`` label-share proxy as
the *reported* live metric with two metrics grounded in what the executor
actually did during the run:

* **precision** = tokens of pack files the executor actually read / actual pack
  tokens (the actual-selected denominator, NOT the fixed
  ``RETRIEVAL_MAX_TOKENS`` budget). A tiny relevant pack scores high; a pack
  padded with never-read filler scores low.
* **recall** = fraction of *pre-existing* files modified in the final accepted
  diff that were in the pack. Created (new) files are excluded from the
  denominator — a file the agent invented was never something the pack could
  have retrieved. A run that produced **no diff at all** (15/21 recent eval
  failures did) has no recall denominator: recall is ``None`` and the run is
  counted as a *coverage* observation instead, NEVER recall=0.

Two free implicit labels fall out of the same comparison and feed the retrieval
feedback loop:

* **waste** — pack files the executor never read (precision waste).
* **miss** — files the executor read/edited that were NOT in the pack, i.e. the
  executor fetched them itself (recall misses).

n/a-vs-0 hygiene (mirrors ``usage_capture.ReadsCoverage`` and the eval
reporter): engines with no transcript vehicle (cursor / hermes / unknown) yield
``status="n/a"`` and NO measured numbers — a zero would be a provenance lie.

This module is PURE: it takes already-collected inputs (pack item paths + token
estimates, a ``readsCoverage`` dict as written to run.json, and the classified
changed-file lists) and returns a plain dict. It performs no I/O and never
raises, so it is trivially unit-testable and safe to call at run finalization.
"""
from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

__all__ = ["compute_live_context_metrics", "LiveContextMetrics"]

# Type alias for the structured result (a plain dict, JSON-serialisable).
LiveContextMetrics = Dict[str, Any]


def _norm(path: str) -> str:
    """Normalise a repo-relative path for set membership (strip ``./`` + slashes)."""
    p = (path or "").strip()
    while p.startswith("./"):
        p = p[2:]
    return p.replace("\\", "/").lstrip("/")


def _pack_file_tokens(
    included: Sequence[Mapping[str, Any]],
) -> Tuple[Dict[str, int], int]:
    """Map each pack file's normalised path → its token estimate, and the total.

    A file that appears more than once in the pack is counted once (max token
    estimate wins) so precision can never exceed 1.0 through double counting.
    ``tokenEstimate`` is the field the pack build attaches to every included
    item (``agentrail/context/packs.py``); non-numeric / bool values are 0.
    """
    tokens: Dict[str, int] = {}
    for item in included:
        if not isinstance(item, Mapping):
            continue
        raw_path = item.get("path") or item.get("citation")
        if not isinstance(raw_path, str) or not raw_path.strip():
            continue
        path = _norm(raw_path)
        value = item.get("tokenEstimate")
        est = 0
        if isinstance(value, bool):
            est = 0
        elif isinstance(value, (int, float)):
            est = int(value)
        if est < 0:
            est = 0
        # Same file twice in a pack: keep the larger estimate, count once.
        tokens[path] = max(tokens.get(path, 0), est)
    total = sum(tokens.values())
    return tokens, total


def _read_paths(reads_coverage: Optional[Mapping[str, Any]]) -> Optional[List[str]]:
    """Normalised set of files the executor read, or None when coverage is n/a.

    Returns ``None`` (not an empty list) when there is no transcript vehicle —
    ``status != "ok"`` — so the caller can emit n/a instead of a measured zero.
    An ``"ok"`` coverage with zero reads returns ``[]`` (a real, measured zero).
    """
    if not isinstance(reads_coverage, Mapping):
        return None
    if reads_coverage.get("status") != "ok":
        return None
    files = reads_coverage.get("files")
    if not isinstance(files, list):
        return []
    out: List[str] = []
    for entry in files:
        if isinstance(entry, Mapping):
            path = entry.get("path")
            if isinstance(path, str) and path.strip():
                out.append(_norm(path))
    return out


def _engine_of(reads_coverage: Optional[Mapping[str, Any]], fallback: str) -> str:
    if isinstance(reads_coverage, Mapping):
        eng = reads_coverage.get("engine")
        if isinstance(eng, str) and eng.strip():
            return eng.strip().lower()
    return (fallback or "unknown").strip().lower() or "unknown"


def compute_live_context_metrics(
    *,
    included: Sequence[Mapping[str, Any]],
    reads_coverage: Optional[Mapping[str, Any]],
    modified_preexisting: Sequence[str],
    created_files: Sequence[str] = (),
    engine_fallback: str = "unknown",
) -> LiveContextMetrics:
    """Compute read-grounded live precision/recall + waste/miss for one run.

    Parameters
    ----------
    included:
        The pack's ``included`` items (each a dict with ``path`` and, ideally,
        ``tokenEstimate``). This is the *actual* pack the run produced.
    reads_coverage:
        The ``readsCoverage`` dict as written to run.json by
        :func:`agentrail.run.usage_capture.record_reads_into_run_json`
        (``{"engine", "status", "files": [...]}``). ``None`` or
        ``status != "ok"`` ⇒ read-derived metrics are n/a.
    modified_preexisting:
        Repo-relative paths of *pre-existing* files modified in the final
        accepted diff (``git diff --diff-filter=M``). The recall denominator.
    created_files:
        Repo-relative paths of files the change CREATED (new/untracked).
        Excluded from the recall denominator entirely.
    engine_fallback:
        Engine name to tag the record with when ``reads_coverage`` carries none
        (e.g. the run's ``agent``).

    Returns a JSON-serialisable dict. Never raises.
    """
    engine = _engine_of(reads_coverage, engine_fallback)
    file_tokens, pack_tokens = _pack_file_tokens(included or [])
    pack_files = set(file_tokens.keys())

    read_paths = _read_paths(reads_coverage)
    read_status = "ok" if read_paths is not None else "n/a"

    result: Dict[str, Any] = {
        "engine": engine,
        # readStatus governs the read-derived half (precision, waste, miss).
        # Recall is diff-derived and does not depend on the transcript, but we
        # cross-check it against reads when they exist.
        "readStatus": read_status,
        "packFileCount": len(pack_files),
        "packTokens": pack_tokens,
    }

    # ---- Read-derived: precision + waste + miss (n/a when no transcript) ----
    if read_paths is None:
        # No transcript vehicle (cursor/hermes/unknown or unparseable). Report
        # n/a for every read-derived metric — never a measured zero.
        result["precision"] = None
        result["precisionStatus"] = "n/a"
        result["readTokens"] = None
        # waste/miss are read-derived too: without reads we cannot know which
        # pack files went unread or which files were self-fetched.
        result["waste"] = None
        result["miss"] = None
    else:
        read_set = set(read_paths)
        read_pack_files = pack_files & read_set
        read_tokens = sum(file_tokens[p] for p in read_pack_files)
        # precision = read pack tokens / actual pack tokens (0..1). An empty
        # pack has no denominator → precision is n/a, not a divide-by-zero 0.
        if pack_tokens > 0:
            precision = read_tokens / pack_tokens
            precision = 0.0 if precision < 0.0 else (1.0 if precision > 1.0 else precision)
            result["precision"] = round(precision, 4)
            result["precisionStatus"] = "ok"
        else:
            result["precision"] = None
            result["precisionStatus"] = "n/a"
        result["readTokens"] = read_tokens
        # Free labels. waste = pack files never read; miss = read files not in
        # the pack (the executor fetched them itself).
        result["waste"] = sorted(pack_files - read_set)
        result["miss"] = sorted(read_set - pack_files)

    # ---- Diff-derived: recall (independent of the transcript) ----
    modified = {_norm(p) for p in (modified_preexisting or []) if isinstance(p, str) and p.strip()}
    created = {_norm(p) for p in (created_files or []) if isinstance(p, str) and p.strip()}
    # A file that shows as both modified and created is a rename/edge — treat it
    # as created (excluded), matching "created files are excluded" verbatim.
    modified -= created
    result["modifiedPreexistingCount"] = len(modified)

    if not modified:
        # No pre-existing file was modified → there is no recall denominator.
        # This is the no-diff / new-files-only case: report a coverage
        # observation, explicitly NO recall value (never 0). AC2.
        result["recall"] = None
        result["recallStatus"] = "no-diff" if not created else "created-only"
        result["recallCovered"] = None
    else:
        covered = modified & pack_files
        result["recall"] = round(len(covered) / len(modified), 4)
        result["recallStatus"] = "ok"
        result["recallCovered"] = len(covered)
        # Cross-check against transcript reads (captures read-not-edited files
        # the diff proxy misses): a modified pre-existing file that was neither
        # in the pack NOR read is a hard recall miss the executor had to find
        # some other way. Purely diagnostic; does not change recall.
        if read_paths is not None:
            read_set = set(read_paths)
            result["recallMissedUnread"] = sorted(modified - pack_files - read_set)

    return result
