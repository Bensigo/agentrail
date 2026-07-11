"""Assemble one judgeable JSON record per production run from on-disk artifacts.

Read-only over ``<target>/.agentrail/runs/<run-id>/`` and the cost ledger at
``<target>/.agentrail/run/cost-events.jsonl``. No network calls, no new runner
instrumentation — this module only reads what ``agentrail/run/artifacts.py``
and ``agentrail/run/pipeline.py`` already write.

This is the PRODUCTION-run twin of ``agentrail/evals/run_record.py`` (the
eval-side dataclass model). Deliberately separate: different schema, different
inputs, different purpose — do not merge them.

CI/PR outcomes, review outcomes, branch, and diff path are reserved fields for
a later enrichment slice; this module always leaves them null.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from agentrail.shared.json import write_json

RECORD_VERSION = 1

# A subdirectory of a run dir counts as a "phase dir" if it contains at least
# one of these files.
_PHASE_MARKERS = ("status.json", "metadata.json", "output.md")

# run.json keys that only exist on runs produced after 2026-07-03. Their
# absence on an otherwise-readable run.json is reported in ``missing`` so a
# judge can tell "legacy run" apart from "assembler bug".
_NEWER_RUN_JSON_KEYS = ("readsCoverage", "objectiveGate")


def _now_iso() -> str:
    """UTC now, ISO-8601 with milliseconds and a Z suffix. Mirrors cost_push._now_iso."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _read_json_safe(path: Path) -> Tuple[Optional[dict], Optional[str]]:
    """Read a JSON object file. Returns (data, None) or (None, reason). Never raises."""
    if not path.exists():
        return None, "absent"
    try:
        with path.open("r", encoding="utf-8") as fh:
            value = json.load(fh)
    except Exception as exc:  # noqa: BLE001 — assembler must never raise
        return None, f"unreadable: {exc}"
    if not isinstance(value, dict):
        return None, "unreadable: not a JSON object"
    return value, None


def _iter_phase_dirs(run_dir: Path) -> List[Path]:
    """Immediate subdirs of run_dir containing at least one phase marker file."""
    if not run_dir.is_dir():
        return []
    phase_dirs = []
    try:
        children = sorted(run_dir.iterdir())
    except OSError:
        return []
    for child in children:
        if not child.is_dir():
            continue
        if any((child / marker).exists() for marker in _PHASE_MARKERS):
            phase_dirs.append(child)
    return phase_dirs


def _read_phase(phase_dir: Path, missing: List[str]) -> Dict[str, Any]:
    """Read one phase dir's status.json + output.md presence into a phase record.

    tokens/cost_usd/model start null — the caller fills them in from matching
    ledger events (a phase dir does not know about the ledger).
    """
    name = phase_dir.name
    status, reason = _read_json_safe(phase_dir / "status.json")
    if status is None:
        missing.append(f"{name}/status.json ({reason})")
        status = {}

    output_file = f"{name}/output.md" if (phase_dir / "output.md").exists() else None

    return {
        "name": name,
        "status": status.get("status"),
        "exit_status": status.get("exitStatus"),
        "started_at": status.get("startedAt"),
        "finished_at": status.get("finishedAt"),
        "output_file": output_file,
        "tokens": None,
        "cost_usd": None,
        "model": None,
    }


def _read_ledger_events(ledger_path: Optional[Path], run_id: str) -> Tuple[List[dict], List[str]]:
    """Read cost-events.jsonl and filter to this run_id. Never raises.

    Malformed individual lines are skipped (best-effort); a wholly unreadable
    or absent ledger is reported in the returned missing-reasons list.
    """
    missing: List[str] = []
    if ledger_path is None or not Path(ledger_path).exists():
        missing.append("cost-events.jsonl (absent)")
        return [], missing

    events: List[dict] = []
    try:
        with Path(ledger_path).open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                if isinstance(row, dict) and row.get("run_id") == run_id:
                    events.append(row)
    except OSError as exc:
        missing.append(f"cost-events.jsonl (unreadable: {exc})")
        return [], missing
    return events, missing


def _apply_ledger(phases: List[Dict[str, Any]], events: List[dict]) -> dict:
    """Fill per-phase tokens/cost_usd/model from matching events (in place);
    return the run-level cost summary dict."""
    phase_names = {p["name"] for p in phases}
    by_phase: Dict[str, List[dict]] = {}
    unmatched_phases: set = set()
    total_usd = 0.0
    have_events = bool(events)

    for ev in events:
        cost_val = ev.get("cost_usd")
        if isinstance(cost_val, (int, float)):
            total_usd += cost_val
        phase_name = ev.get("phase")
        if not phase_name:
            continue
        by_phase.setdefault(phase_name, []).append(ev)
        if phase_name not in phase_names:
            unmatched_phases.add(phase_name)

    for phase in phases:
        matched = by_phase.get(phase["name"], [])
        if not matched:
            continue
        phase["tokens"] = {
            "input": sum(int(e.get("input_tokens") or 0) for e in matched),
            "output": sum(int(e.get("output_tokens") or 0) for e in matched),
            "cache": sum(int(e.get("cache_tokens") or 0) for e in matched),
            "cache_creation": sum(int(e.get("cache_creation_tokens") or 0) for e in matched),
        }
        phase["cost_usd"] = sum(float(e.get("cost_usd") or 0) for e in matched)
        models = list(dict.fromkeys(e.get("model") for e in matched if e.get("model")))
        phase["model"] = ",".join(models) if models else None

    return {
        "total_usd": total_usd if have_events else None,
        "events": len(events),
        "unmatched_phases": sorted(unmatched_phases),
    }


def assemble_run_record(run_dir: Path, ledger_path: Optional[Path]) -> dict:
    """Assemble one judgeable record from a run directory's on-disk artifacts.

    Pure and non-raising: every artifact is best-effort. Anything missing or
    unreadable is captured in the record's "missing" list instead of raising.
    """
    run_dir = Path(run_dir)
    run_id = run_dir.name
    missing: List[str] = []

    run_json, run_json_reason = _read_json_safe(run_dir / "run.json")
    if run_json is None:
        missing.append(f"run.json ({run_json_reason})")
        run_json = {}
    else:
        for key in _NEWER_RUN_JSON_KEYS:
            if key not in run_json:
                missing.append(f"{key} (absent in run.json)")

    # -- phase discovery --------------------------------------------------
    phases: List[Dict[str, Any]] = [
        _read_phase(phase_dir, missing) for phase_dir in _iter_phase_dirs(run_dir)
    ]
    phases.sort(key=lambda p: (p["started_at"] or "", p["name"]))

    finished_candidates = [p["finished_at"] for p in phases if p["finished_at"]]
    finished_at = max(finished_candidates) if finished_candidates else None
    verify_phase_ran = any(p["name"] == "verify" for p in phases)

    # -- cost ledger --------------------------------------------------------
    events, ledger_missing = _read_ledger_events(
        Path(ledger_path) if ledger_path is not None else None, run_id
    )
    missing.extend(ledger_missing)
    cost = _apply_ledger(phases, events)

    return {
        "record_version": RECORD_VERSION,
        "source": "production",
        "run_id": run_id,
        "run_dir": str(run_dir.resolve()),
        "target_type": run_json.get("targetType"),
        "issue": run_json.get("targetIssue"),
        "agent": run_json.get("agent"),
        "command": run_json.get("command"),
        "started_at": run_json.get("startedAt"),
        "finished_at": finished_at,
        "attempts": {
            "execution_attempt": run_json.get("executionAttempt"),
            "max_execution_attempts": run_json.get("maxExecutionAttempts"),
            "failed_verification_attempts": run_json.get("failedVerificationAttempts"),
        },
        "resolved_skills": run_json.get("resolvedSkills"),
        "context_pack_file": run_json.get("contextPackFile"),
        "context_retrieval": run_json.get("contextRetrieval"),
        "reads_coverage": run_json.get("readsCoverage"),
        "phases": phases,
        "cost": cost,
        "objective_gate": run_json.get("objectiveGate"),
        "review": run_json.get("review"),
        "verify_phase_ran": verify_phase_ran,
        "blocked_reason": run_json.get("blockedReason"),
        "verifier_findings_file": run_json.get("verifierFindingsFile"),
        # Reserved for the enrichment slice (resolving CI/PR/review outcomes
        # via gh) — explicitly out of scope for this slice.
        "ci_outcome": None,
        "review_outcome": None,
        "branch": None,
        "diff_path": None,
        "missing": missing,
        "assembled_at": _now_iso(),
    }


def write_run_record(record: dict, records_dir: Path) -> Path:
    """Write record to <records_dir>/<run_id>.json (creating records_dir if needed)."""
    records_dir = Path(records_dir)
    out_path = records_dir / f"{record['run_id']}.json"
    write_json(out_path, record)
    return out_path


def _normalize_since(since: Optional[str]) -> Optional[str]:
    """Normalize 'YYYY-MM-DD' to 'YYYYMMDD'. Returns None if since is None/malformed
    (malformed since is treated as "no filter" rather than raising)."""
    if not since:
        return None
    try:
        return datetime.strptime(since, "%Y-%m-%d").strftime("%Y%m%d")
    except ValueError:
        return None


def _run_id_date(run_id: str) -> Optional[str]:
    """The run-id's leading YYYYMMDD prefix, if it parses as a real date; else None."""
    prefix = run_id[:8]
    if len(prefix) == 8 and prefix.isdigit():
        try:
            datetime.strptime(prefix, "%Y%m%d")
        except ValueError:
            return None
        return prefix
    return None


def list_candidate_run_ids(target: Path, since: Optional[str] = None) -> List[str]:
    """Run-ids under <target>/.agentrail/runs/ that pass the ``since`` filter.

    Sorted by directory name (== chronological, given the run-id timestamp
    prefix). Run-ids without a parseable YYYYMMDD prefix are always kept.
    Shared by assemble_all and the CLI so both apply the identical filter.
    """
    runs_dir = Path(target) / ".agentrail" / "runs"
    if not runs_dir.is_dir():
        return []
    since_norm = _normalize_since(since)
    ids: List[str] = []
    for run_dir in sorted(runs_dir.iterdir()):
        if not run_dir.is_dir():
            continue
        run_id = run_dir.name
        if since_norm is not None:
            run_date = _run_id_date(run_id)
            if run_date is not None and run_date < since_norm:
                continue
        ids.append(run_id)
    return ids


def assemble_all(target: Path, since: Optional[str] = None, force: bool = False) -> List[Path]:
    """Assemble + write records for every run under <target>/.agentrail/runs/.

    Records are written to <target>/.agentrail/run-records/<run_id>.json.
    Skips runs whose record file already exists unless force=True. Returns
    the paths actually written (assembled), in run-id order.
    """
    target = Path(target)
    records_dir = target / ".agentrail" / "run-records"
    runs_dir = target / ".agentrail" / "runs"
    ledger_path = target / ".agentrail" / "run" / "cost-events.jsonl"
    ledger = ledger_path if ledger_path.exists() else None

    written: List[Path] = []
    for run_id in list_candidate_run_ids(target, since):
        record_path = records_dir / f"{run_id}.json"
        if record_path.exists() and not force:
            continue
        record = assemble_run_record(runs_dir / run_id, ledger)
        written.append(write_run_record(record, records_dir))
    return written
