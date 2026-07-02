"""Token-usage extraction from Claude and Codex transcript files.

Reads local transcript directories written by the agent during a run phase and
returns a summed Usage record.  Only agents whose transcript format is known
are handled; unknown agents return None (non-fatal).

This module ALSO harvests the executor's mid-run *file reads* from the same
on-disk transcripts (:func:`capture_reads`), recording per-file path + size +
token estimate into ``run.json`` before the workdir is torn down. See that
function's docstring for the provenance hygiene contract (n/a vs. 0).
"""
from __future__ import annotations

import json
import os
import re
import shlex
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional


@dataclass
class Usage:
    model: str
    input_tokens: int
    output_tokens: int
    cache_tokens: int  # cache-READ tokens (priced at cached_read rate)
    cache_creation_tokens: int = 0  # cache-WRITE tokens (priced at cached_write rate)


def capture_usage(agent: str, target: Path, since_ts: float) -> Optional[Usage]:
    """Return summed token Usage for *agent* since *since_ts* (epoch seconds).

    *target* is the repository root used to locate the matching transcript.
    Returns None for unknown agents or when no matching transcript is found.
    """
    if agent == "claude":
        return _extract_claude(target, since_ts)
    if agent == "codex":
        return _extract_codex(target, since_ts)
    # hermes / cursor / custom — future agents; non-fatal
    return None


# ---------------------------------------------------------------------------
# Claude extractor
# ---------------------------------------------------------------------------

def _claude_projects_dir(target: Path) -> Path:
    """Resolve ~/.claude/projects/<encoded-cwd> for *target*.

    Claude encodes the cwd by replacing every non-alphanumeric character with
    '-' (not just '/'): '/repo/.afk/wt' becomes '-repo--afk-wt'. Dots matter —
    afk worktrees live under '.afk/', so a '/'-only encoding never matches.
    """
    encoded = re.sub(r"[^A-Za-z0-9-]", "-", str(target.resolve()))
    return Path.home() / ".claude" / "projects" / encoded


def _extract_claude(target: Path, since_ts: float) -> Optional[Usage]:
    projects_dir = _claude_projects_dir(target)
    if not projects_dir.exists():
        return None

    input_tokens = 0
    output_tokens = 0
    cache_tokens = 0
    cache_creation_tokens = 0
    model: Optional[str] = None

    found_any = False

    for jsonl_file in sorted(projects_dir.glob("*.jsonl")):
        # Files not modified since since_ts are skipped.
        # Use >= so a file written exactly at since_ts is included.
        if os.path.getmtime(jsonl_file) < since_ts:
            continue

        try:
            text = jsonl_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue

            try:
                message = record.get("message") or {}
                usage = message.get("usage")
                if not isinstance(usage, dict):
                    continue

                input_tokens += int(usage.get("input_tokens", 0))
                output_tokens += int(usage.get("output_tokens", 0))
                cache_tokens += int(usage.get("cache_read_input_tokens", 0))
                cache_creation_tokens += int(usage.get("cache_creation_input_tokens", 0))

                msg_model = message.get("model")
                if msg_model:
                    model = msg_model  # keep the last seen model

                found_any = True
            except (TypeError, ValueError):
                continue

    if not found_any:
        return None

    return Usage(
        model=model or "",
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_tokens=cache_tokens,
        cache_creation_tokens=cache_creation_tokens,
    )


# ---------------------------------------------------------------------------
# Codex extractor
# ---------------------------------------------------------------------------

def _codex_session_records(target: Path, since_ts: float) -> Iterator[List[dict]]:
    """Yield parsed record lists for codex rollout files matching *target*.

    Scans ~/.codex/sessions/**/rollout-*.jsonl, skips files modified before
    *since_ts*, and yields the parsed JSON records of each file whose
    session_meta.cwd equals the resolved target path. Shared by the usage
    extractor below and the agent-activity extractor (activity_push.py).
    """
    sessions_dir = Path.home() / ".codex" / "sessions"
    if not sessions_dir.exists():
        return

    target_str = str(target.resolve())

    # Process each candidate file that was modified >= since_ts and whose
    # session_meta.cwd matches the target repo.
    for jsonl_file in sorted(sessions_dir.glob("**/rollout-*.jsonl")):
        if os.path.getmtime(jsonl_file) < since_ts:
            continue

        try:
            text = jsonl_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        session_cwd: Optional[str] = None
        records: List[dict] = []

        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(record, dict):
                continue
            records.append(record)
            if record.get("type") == "session_meta":
                session_cwd = record.get("cwd")

        if session_cwd == target_str:
            yield records


def _extract_codex(target: Path, since_ts: float) -> Optional[Usage]:
    for records in _codex_session_records(target, since_ts):
        session_model: Optional[str] = None
        last_token_usage: Optional[dict] = None

        for record in records:
            try:
                record_type = record.get("type")

                if record_type == "turn_context":
                    m = record.get("model")
                    if m:
                        session_model = m

                elif record_type == "token_count":
                    info = record.get("info") or {}
                    total = info.get("total_token_usage")
                    if isinstance(total, dict):
                        last_token_usage = total
            except (TypeError, AttributeError):
                continue

        if last_token_usage is None:
            continue

        try:
            input_tokens = int(last_token_usage.get("input_tokens", 0))
            output_tokens = int(last_token_usage.get("output_tokens", 0))
            cache_tokens = int(last_token_usage.get("cached_input_tokens", 0))
        except (TypeError, ValueError):
            continue

        return Usage(
            model=session_model or "",
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_tokens=cache_tokens,
        )

    return None


# ---------------------------------------------------------------------------
# Read harvest (PRD2 Phase 0): mid-run file reads → run.json
# ---------------------------------------------------------------------------
#
# A *sibling* of ``capture_usage`` above. It scans the SAME on-disk transcripts
# and reports which files the executor read during the phase, with a per-file
# size and token estimate. The output is written into ``run.json`` before the
# workdir is torn down.
#
# PROVENANCE HYGIENE (n/a vs 0) — the single most important contract here:
#
#   * An engine we CANNOT read reads from (cursor, hermes, unknown, or an engine
#     whose transcript is missing) reports ``status="n/a"``. It NEVER reports a
#     measured zero. "n/a" means "we didn't look / couldn't look"; "0 files with
#     status=ok" means "we looked and the executor genuinely read nothing".
#     These are different facts and must never be conflated.
#   * An engine we CAN read from but whose transcript is unparseable / an unknown
#     shape reports ``status="n/a"`` PLUS a ``format`` tag naming what we saw
#     (tolerate-and-tag). We never crash the run over a bad transcript.
#
# Token estimate: for claude we approximate tokens as bytes // 4 when the
# transcript carries the read content; for codex we prefer the exact
# "Original token count: N" the tool reports, falling back to bytes // 4.

# Read tools we recognise in a claude transcript. "Read" is the file-read tool;
# the others also surface file paths but are not plain reads and are ignored so
# the coverage number stays a faithful "files the executor read" count.
_CLAUDE_READ_TOOLS = {"Read"}

# Shell verbs that count as a file read in a codex rollout. These are the
# commands codex actually emits to inspect files (observed live).
_CODEX_READ_VERBS = {"cat", "sed", "head", "tail", "less", "more", "bat", "nl"}

# Rough bytes-per-token divisor for size→token estimates when no exact count is
# available. Matches the heuristic used across the codebase.
_BYTES_PER_TOKEN = 4


@dataclass
class FileRead:
    """One file the executor read during a phase."""

    path: str
    bytes: int  # size in bytes (best-effort: from transcript, else on-disk stat)
    tokens_est: int  # estimated tokens (exact when the engine reports it)
    engine: str  # "claude" | "codex"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "path": self.path,
            "bytes": self.bytes,
            "tokensEst": self.tokens_est,
            "engine": self.engine,
        }


@dataclass
class ReadsCoverage:
    """Coverage record for the executor's file reads in a phase.

    ``status`` is either ``"ok"`` (we read the transcript; ``files`` is a
    faithful — possibly empty — list of reads) or ``"n/a"`` (no transcript
    vehicle for this engine, or the transcript was unparseable). ``format`` is a
    tag describing what was seen when ``status == "n/a"`` for a tolerate-and-tag
    case; it is ``None`` for the plain "engine has no transcript" case.
    """

    engine: str
    status: str  # "ok" | "n/a"
    format: Optional[str] = None
    files: List[FileRead] = field(default_factory=list)
    note: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "engine": self.engine,
            "status": self.status,
        }
        if self.format is not None:
            out["format"] = self.format
        if self.note is not None:
            out["note"] = self.note
        # Only surface a files array (and a count) when we actually looked. When
        # status is n/a there is deliberately NO count so it can never be read
        # as a zero.
        if self.status == "ok":
            out["fileCount"] = len(self.files)
            out["files"] = [f.to_dict() for f in self.files]
        return out


def capture_reads(agent: str, target: Path, since_ts: float) -> ReadsCoverage:
    """Harvest the executor's mid-run file reads for *agent* since *since_ts*.

    Sibling of :func:`capture_usage`. Returns a :class:`ReadsCoverage` that is
    ALWAYS safe to record into run.json:

      * ``claude`` / ``codex`` → parse the on-disk transcript; ``status="ok"``
        with a (possibly empty) ``files`` list. If the transcript directory is
        missing entirely, or the parse yields an unknown shape, ``status="n/a"``
        with a ``format`` tag (tolerate-and-tag).
      * anything else (cursor, hermes, custom, empty) → ``status="n/a"`` with no
        count. These engines have no transcript vehicle; recording a zero would
        be a provenance lie.

    This function NEVER raises: any unexpected error is caught and downgraded to
    an ``n/a`` coverage with a ``format`` tag, so it can never crash a run.
    """
    engine = _normalise_reads_engine(agent)
    try:
        if engine == "claude":
            return _harvest_claude_reads(target, since_ts)
        if engine == "codex":
            return _harvest_codex_reads(target, since_ts)
        # cursor / hermes / unknown → no transcript vehicle. n/a, never zero.
        return ReadsCoverage(
            engine=engine or (agent or "").strip().lower() or "unknown",
            status="n/a",
            note="engine has no transcript to harvest reads from",
        )
    except Exception as exc:  # never crash the run over a read harvest
        return ReadsCoverage(
            engine=engine or (agent or "").strip().lower() or "unknown",
            status="n/a",
            format="harvest-error",
            note=f"{type(exc).__name__}: {exc}"[:200],
        )


def _normalise_reads_engine(agent: str) -> str:
    """Map an agent string to a read-harvest engine token, or "" if unknown.

    Accepts a bare name ("claude") or a command string that starts with a known
    token. Mirrors ``context_inject._normalise_engine`` but is local so this
    module has no cross-import for a two-line helper.
    """
    name = (agent or "").strip().lower()
    for known in ("claude", "codex", "cursor", "hermes"):
        if name == known or name.startswith(known):
            return known
    return ""


def _harvest_claude_reads(target: Path, since_ts: float) -> ReadsCoverage:
    """Parse claude transcripts for Read tool-uses since *since_ts*.

    Read tool-use records live in ``message.content[]`` as
    ``{"type":"tool_use","name":"Read","input":{"file_path":...}}``. The size is
    enriched from the matching tool_result's top-level ``toolUseResult.file``
    (``content`` gives bytes), falling back to an on-disk stat, then to 0.
    """
    projects_dir = _claude_projects_dir(target)
    if not projects_dir.exists():
        # No transcript directory for this cwd → n/a, not an empty "ok".
        return ReadsCoverage(
            engine="claude",
            status="n/a",
            format="claude-transcript-missing",
            note=f"no transcript dir at {projects_dir}",
        )

    # path → (bytes, tokens_est). Last read of a path wins on size; dedup keeps
    # the coverage a set of distinct files the executor touched.
    reads: Dict[str, List[int]] = {}
    # tool_use id → file_path, so a later tool_result can enrich the size.
    pending: Dict[str, str] = {}
    saw_any_record = False
    # Did any in-window transcript file actually contain non-empty content?
    # Used to separate "no eligible transcript" (fine, ok/empty) from
    # "a transcript exists but nothing in it parsed" (unparseable → n/a).
    saw_nonempty_transcript = False

    for jsonl_file in sorted(projects_dir.glob("*.jsonl")):
        if os.path.getmtime(jsonl_file) < since_ts:
            continue
        try:
            text = jsonl_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if text.strip():
            saw_nonempty_transcript = True

        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(record, dict):
                continue
            saw_any_record = True

            # 1) tool_use Read records → register the path (size TBD).
            message = record.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        if block.get("type") != "tool_use":
                            continue
                        if block.get("name") not in _CLAUDE_READ_TOOLS:
                            continue
                        inp = block.get("input") or {}
                        fp = inp.get("file_path") if isinstance(inp, dict) else None
                        if not fp:
                            continue
                        reads.setdefault(fp, [0, 0])
                        tu_id = block.get("id")
                        if isinstance(tu_id, str):
                            pending[tu_id] = fp

            # 2) tool_result enrichment → fill in real bytes for a pending read.
            tur = record.get("toolUseResult")
            if isinstance(tur, dict):
                file_info = tur.get("file")
                if isinstance(file_info, dict):
                    fp = file_info.get("filePath")
                    body = file_info.get("content")
                    if fp and isinstance(body, str):
                        nbytes = len(body.encode("utf-8", errors="ignore"))
                        reads.setdefault(fp, [0, 0])
                        reads[fp][0] = nbytes
                        reads[fp][1] = max(1, nbytes // _BYTES_PER_TOKEN)

    if saw_nonempty_transcript and not saw_any_record:
        # A transcript exists and had content, but not a single JSON-object
        # record parsed out of it → unknown/corrupt shape. Tolerate-and-tag as
        # n/a rather than silently reporting a (false) zero reads.
        return ReadsCoverage(
            engine="claude",
            status="n/a",
            format="claude-unparseable",
            note="transcript content present but no JSON-object records parsed",
        )

    files: List[FileRead] = []
    for fp, (nbytes, tok) in sorted(reads.items()):
        if nbytes == 0:
            # No transcript-carried content; best-effort on-disk stat.
            nbytes = _stat_bytes(fp)
            tok = max(1, nbytes // _BYTES_PER_TOKEN) if nbytes else 0
        files.append(FileRead(path=fp, bytes=nbytes, tokens_est=tok, engine="claude"))

    return ReadsCoverage(engine="claude", status="ok", files=files)


def _harvest_codex_reads(target: Path, since_ts: float) -> ReadsCoverage:
    """Parse codex rollout files for file-read shell commands since *since_ts*.

    File reads are ``exec_command`` function_calls whose parsed ``cmd`` starts
    with a known read verb (cat/sed/head/...). The token estimate is taken from
    the matching ``function_call_output`` line "Original token count: N" (keyed
    by ``call_id``), falling back to an on-disk stat.
    """
    sessions_dir = Path.home() / ".codex" / "sessions"
    if not sessions_dir.exists():
        return ReadsCoverage(
            engine="codex",
            status="n/a",
            format="codex-transcript-missing",
            note=f"no sessions dir at {sessions_dir}",
        )

    matched_session = False
    # call_id → (path, bytes). Filled from function_call, token/size enriched
    # from the matching function_call_output.
    calls: Dict[str, List[Any]] = {}
    # path → [bytes, tokens_est] final, deduped across the session.
    reads: Dict[str, List[int]] = {}

    for records in _codex_session_records(target, since_ts):
        matched_session = True
        for record in records:
            if not isinstance(record, dict):
                continue
            payload = record.get("payload")
            if not isinstance(payload, dict):
                continue
            ptype = payload.get("type")

            if ptype == "function_call" and payload.get("name") == "exec_command":
                call_id = payload.get("call_id")
                fp = _codex_read_path(payload.get("arguments"))
                if call_id and fp:
                    calls[call_id] = [fp, 0]

            elif ptype == "function_call_output":
                call_id = payload.get("call_id")
                if call_id and call_id in calls:
                    fp = calls[call_id][0]
                    tokens = _codex_output_tokens(payload.get("output"))
                    reads.setdefault(fp, [0, 0])
                    if tokens:
                        reads[fp][1] = max(reads[fp][1], tokens)

    if not matched_session:
        return ReadsCoverage(
            engine="codex",
            status="n/a",
            format="codex-transcript-missing",
            note="no rollout matched the target cwd",
        )

    # Any read command that never got an output (or no token count) still counts
    # as a read — register it with a best-effort on-disk size.
    for _cid, (fp, _b) in calls.items():
        reads.setdefault(fp, [0, 0])

    files: List[FileRead] = []
    for fp, (nbytes, tok) in sorted(reads.items()):
        if nbytes == 0:
            nbytes = _stat_bytes(fp)
        if tok == 0 and nbytes:
            tok = max(1, nbytes // _BYTES_PER_TOKEN)
        files.append(FileRead(path=fp, bytes=nbytes, tokens_est=tok, engine="codex"))

    return ReadsCoverage(engine="codex", status="ok", files=files)


def _codex_read_path(arguments: Any) -> Optional[str]:
    """Extract the read file path from an exec_command ``arguments`` JSON string.

    ``arguments`` is a JSON string like ``{"cmd":"sed -n '1,240p' /path", ...}``.
    Returns the last shell token that looks like a path when the command's verb
    is a known read verb; otherwise None (not a file read).
    """
    if not isinstance(arguments, str):
        return None
    try:
        args = json.loads(arguments)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(args, dict):
        return None
    cmd = args.get("cmd")
    if not isinstance(cmd, str) or not cmd.strip():
        return None
    try:
        tokens = shlex.split(cmd)
    except ValueError:
        return None
    if not tokens:
        return None
    verb = os.path.basename(tokens[0])
    if verb not in _CODEX_READ_VERBS:
        return None
    # The path is the last token that is not a flag / not the verb. Read verbs
    # put the file last (e.g. `sed -n '1,240p' /path`, `cat /path`).
    for tok in reversed(tokens[1:]):
        if tok.startswith("-"):
            continue
        # skip sed's line-range script like '1,240p'
        if verb == "sed" and ("," in tok or tok.endswith("p")) and "/" not in tok:
            continue
        return tok
    return None


def _codex_output_tokens(output: Any) -> int:
    """Parse "Original token count: N" out of a function_call_output string."""
    if not isinstance(output, str):
        return 0
    m = re.search(r"Original token count:\s*(\d+)", output)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            return 0
    return 0


def _stat_bytes(path: str) -> int:
    """Best-effort on-disk size of *path*; 0 if it cannot be stat'd."""
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def record_reads_into_run_json(metadata_file: Path, coverage: ReadsCoverage) -> None:
    """Merge *coverage* into ``run.json`` at *metadata_file* (read-modify-write).

    Mirrors ``pipeline.finalize_objective_gate``'s persistence model. Reads only
    when the file exists; writes the coverage under the ``readsCoverage`` key.
    Never raises — a persistence failure must not crash the run.
    """
    # Local import to avoid a module-load cycle with agentrail.shared.json.
    from agentrail.shared.json import read_json, write_json

    try:
        data = read_json(metadata_file) if metadata_file.exists() else {}
        if not isinstance(data, dict):
            data = {}
        data["readsCoverage"] = coverage.to_dict()
        write_json(metadata_file, data)
    except Exception:
        # Non-fatal: a run must complete even if this bookkeeping write fails.
        return
