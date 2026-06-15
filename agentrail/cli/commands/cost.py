"""
``agentrail cost`` — per-run/issue real-dollar cost attribution from the AFK journal.

Reads the local AFK flight-recorder journal (.agentrail/afk/events.jsonl) to
enumerate sessions and per-issue claim timestamps, uses those timestamps as
``since_ts`` anchors for ``capture_usage`` to collect token counts, then prices
each issue via ``agentrail.run.pricing.cost_usd``.

Known approximation: ``capture_usage`` sums all transcript activity after the
claim anchor with no upper-bound window; concurrent issues within one session
may overlap. The issue prescribes this anchor approach; tests monkeypatch
``capture_usage`` to keep dollar math deterministic.
"""
from __future__ import annotations

import datetime as _dt
import json
import sys
from pathlib import Path
from typing import List, Optional

from agentrail.afk import journal as _journal
from agentrail.run.pricing import cost_usd
from agentrail.run.usage_capture import capture_usage
from agentrail.run.cost_recommend import recommend, ESTIMATE_UNAVAILABLE
from agentrail.cli.commands.run import _read_config, resolve_agent_name, resolve_default_budget


def _rows_have_usage(rows: List[dict]) -> bool:
    return any(
        r["input_tokens"] or r["output_tokens"] or r["cache_tokens"] for r in rows
    )


def _candidate_agents(target: Path, primary: str) -> List[str]:
    """Agents to probe for usage: primary first, then configured runners, then known."""
    ordered: List[str] = []
    for a in [primary, *(_read_config(str(target)) or {}).get("runners", {}), "claude", "codex", "cursor"]:
        if a and a not in ordered:
            ordered.append(a)
    return ordered


def _usage_text() -> str:
    return """Usage:
  agentrail cost [--target DIR] [--run ID] [--since REF] [--json]
  agentrail cost [RUN_ID] --recommend [--json]

Reads the AFK flight-recorder journal (.agentrail/afk/events.jsonl) and
prints real-dollar cost attribution per issue, priced through the model
rate table.

Options:
  --target DIR   Project root (default: .)
  --run ID       Scope to a single session; error if not found
  --since REF    ISO timestamp or YYYY-MM-DD; exclude earlier sessions
  --recommend    Emit prioritised cost-saving recommendations for a run
  --json         Emit machine-readable JSON
"""


def _parse(args: List[str]) -> dict:
    opts: dict = {
        "target": Path("."),
        "run": None,
        "since": None,
        "json": False,
        "recommend": False,
    }
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--target":
            opts["target"] = Path(args[i + 1]); i += 2
        elif a == "--run":
            opts["run"] = args[i + 1]; i += 2
        elif a == "--since":
            opts["since"] = args[i + 1]; i += 2
        elif a == "--json":
            opts["json"] = True; i += 1
        elif a == "--recommend":
            opts["recommend"] = True; i += 1
        elif a in ("-h", "--help"):
            print(_usage_text()); raise SystemExit(0)
        elif not a.startswith("-"):
            # Positional: treat as run_id (forward-compat with `agentrail cost <run_id> --recommend`)
            if opts["run"] is None:
                opts["run"] = a
            else:
                raise SystemExit(f"unexpected positional argument: {a!r}")
            i += 1
        else:
            raise SystemExit(f"unknown option: {a}")
    return opts


def _epoch(ts_iso: str) -> float:
    """Convert an ISO timestamp string to epoch seconds (UTC if naive)."""
    dt = _dt.datetime.fromisoformat(ts_iso)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_dt.timezone.utc)
    return dt.timestamp()


def _parse_since(ref: str) -> float:
    """Parse --since REF (ISO timestamp or YYYY-MM-DD) to epoch seconds."""
    try:
        dt = _dt.datetime.fromisoformat(ref)
    except ValueError:
        raise SystemExit(f"--since: cannot parse {ref!r} as ISO timestamp or YYYY-MM-DD")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_dt.timezone.utc)
    return dt.timestamp()


def _session_init_ts(events: List[dict]) -> Optional[float]:
    """Return the init event's ts as epoch seconds, or None."""
    for ev in events:
        if ev.get("kind") == "init":
            ts = ev.get("ts")
            if ts:
                try:
                    return _epoch(ts)
                except (ValueError, AttributeError):
                    pass
    return None


def _session_claims(events: List[dict]) -> List[tuple]:
    """Return (issue_number, claim_epoch) pairs from a session's action events."""
    claims = []
    for ev in events:
        if ev.get("kind") != "action":
            continue
        action = ev.get("action") or {}
        if action.get("type") == "ClaimIssue":
            number = action.get("number")
            if number is None:
                continue  # malformed claim event — skip rather than crash
            try:
                number = int(number)
            except (TypeError, ValueError):
                continue
            ts_iso = ev.get("ts", "")
            try:
                epoch = _epoch(ts_iso)
            except (ValueError, AttributeError):
                epoch = 0.0
            claims.append((number, epoch))
    return claims


def _savings_for_issue(all_events: List[dict], session: str, issue: int) -> dict:
    """Extract outputTokensSaved/outputDollarsSaved from cost_optimizer events."""
    for ev in all_events:
        if (
            ev.get("kind") == "cost_optimizer"
            and ev.get("session") == session
            and ev.get("issue") == issue
        ):
            payload = ev.get("payload") or {}
            if "outputTokensSaved" in payload:
                return {
                    "output_tokens_saved": payload.get("outputTokensSaved", 0),
                    "output_dollars_saved": payload.get("outputDollarsSaved", 0.0),
                    "savings_estimate": payload.get("estimate", False),
                }
    return {"output_tokens_saved": 0, "output_dollars_saved": 0.0, "savings_estimate": False}


def _collect_rows(
    all_events: List[dict],
    sessions: List[str],
    agent: str,
    target: Path,
) -> List[dict]:
    rows = []
    for sid in sessions:
        evs = _journal.session_events(all_events, sid)
        for issue_num, claim_ts in _session_claims(evs):
            savings = _savings_for_issue(all_events, sid, issue_num)
            usage = capture_usage(agent, target, claim_ts)
            if usage is None:
                rows.append({
                    "session": sid,
                    "issue": issue_num,
                    "model": "",
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_tokens": 0,
                    "cost_usd": 0.0,
                    **savings,
                })
            else:
                rows.append({
                    "session": sid,
                    "issue": issue_num,
                    "model": usage.model,
                    "input_tokens": usage.input_tokens,
                    "output_tokens": usage.output_tokens,
                    "cache_tokens": usage.cache_tokens,
                    "cost_usd": cost_usd(usage),
                    **savings,
                })
    return rows


def _emit_budget_warnings(rows: List[dict], threshold: float, target: Path) -> List[dict]:
    """Print stderr warnings and append journal events for over-threshold issues.

    Returns a list of violation dicts (one per exceeding row). Does nothing
    when threshold <= 0 or no rows exceed it.
    """
    if threshold <= 0:
        return []
    violations: List[dict] = []
    for row in rows:
        if row["cost_usd"] > threshold:
            print(
                f"WARNING budget exceeded: session {row['session']} "
                f"issue #{row['issue']} cost ${row['cost_usd']:.6f} "
                f"(threshold ${threshold:.6f})",
                file=sys.stderr,
            )
            record = {
                "v": 1,
                "kind": "budget_warning",
                "session": row["session"],
                "issue": row["issue"],
                "cost_usd": row["cost_usd"],
                "threshold_usd": threshold,
                "ts": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            }
            _journal._append(_journal.events_path(target), record)
            violations.append(record)
    return violations


def _render_human(rows: List[dict], total: float) -> None:
    if not rows:
        print("No issues found in journal.")
        return
    col_session = 20
    col_issue = 6
    col_model = 24
    col_tokens = 10
    col_cost = 12
    col_saved = 12
    header = (
        f"{'SESSION':<{col_session}}  {'ISSUE':>{col_issue}}  "
        f"{'MODEL':<{col_model}}  {'IN':>{col_tokens}}  {'OUT':>{col_tokens}}  "
        f"{'CACHE':>{col_tokens}}  {'COST USD':>{col_cost}}  {'SAVED $':>{col_saved}}"
    )
    sep = "-" * len(header)
    print(header)
    print(sep)
    for r in rows:
        cost_str = f"${r['cost_usd']:.6f}"
        saved_str = f"${r.get('output_dollars_saved', 0.0):.6f}"
        print(
            f"{r['session']:<{col_session}}  {r['issue']:>{col_issue}}  "
            f"{r['model']:<{col_model}}  {r['input_tokens']:>{col_tokens}}  "
            f"{r['output_tokens']:>{col_tokens}}  {r['cache_tokens']:>{col_tokens}}  "
            f"{cost_str:>{col_cost}}  {saved_str:>{col_saved}}"
        )
    print(sep)
    total_str = f"${total:.6f}"
    total_saved = sum(r.get("output_dollars_saved", 0.0) for r in rows)
    total_saved_str = f"${total_saved:.6f}"
    print(
        f"{'TOTAL':<{col_session}}  {'':>{col_issue}}  "
        f"{'':>{col_model}}  {'':>{col_tokens}}  {'':>{col_tokens}}  "
        f"{'':>{col_tokens}}  {total_str:>{col_cost}}  {total_saved_str:>{col_saved}}"
    )


def _build_run_record(
    rows: List[dict],
    session: str,
    all_events: List[dict],
) -> dict:
    """Assemble a per-run cost record for the recommend engine.

    The base fields come from journal rows for *session*. Optimizer-signal
    fields (cache_hit_rate, model_routing, pack_cost_usd, …) are read from
    any ``cost_optimizer`` events in the journal; they are absent today until
    M026 feeder slices (#704, #706, #707) land.
    """
    session_rows = [r for r in rows if r["session"] == session]
    # Aggregate tokens and cost across all issues claimed in this session.
    total_input = sum(r["input_tokens"] for r in session_rows)
    total_output = sum(r["output_tokens"] for r in session_rows)
    total_cache = sum(r["cache_tokens"] for r in session_rows)
    total_cost = sum(r["cost_usd"] for r in session_rows)
    model = session_rows[0]["model"] if session_rows else ""

    record: dict = {
        "session": session,
        "model": model,
        "input_tokens": total_input,
        "output_tokens": total_output,
        "cache_tokens": total_cache,
        "cost_usd": total_cost,
    }

    # Pull optimizer signals from journal events if present (future feeder slices).
    evs = _journal.session_events(all_events, session)
    total_output_tokens_saved = 0
    total_output_dollars_saved = 0.0
    for ev in evs:
        if ev.get("kind") == "cost_optimizer":
            payload = ev.get("payload") or {}
            # Cache signal (M026 slice 1 / #704)
            if "cache_hit_rate" in payload:
                record["cache_hit_rate"] = payload["cache_hit_rate"]
            if "cache_eligible_tokens" in payload:
                record["cache_eligible_tokens"] = payload["cache_eligible_tokens"]
            # Routing signal (M026 slice 4 / #707)
            if "model_routing" in payload:
                record["model_routing"] = payload["model_routing"]
            # Pack signal (M026 slice 3 / #706)
            if "pack_cost_usd" in payload:
                record["pack_cost_usd"] = payload["pack_cost_usd"]
            if "budget_usd" in payload:
                record["budget_usd"] = payload["budget_usd"]
            if "items_dropped" in payload:
                record["items_dropped"] = payload["items_dropped"]
            if "pack_threshold_usd" in payload:
                record["pack_threshold_usd"] = payload["pack_threshold_usd"]
            # Diff-savings signal (M026 slice 7 / #709)
            if "outputTokensSaved" in payload:
                total_output_tokens_saved += payload.get("outputTokensSaved", 0)
                total_output_dollars_saved += payload.get("outputDollarsSaved", 0.0)

    if total_output_tokens_saved:
        record["output_tokens_saved"] = total_output_tokens_saved
        record["output_dollars_saved"] = total_output_dollars_saved

    return record


def _render_recommend(recs: list, as_json: bool, session: str) -> None:
    """Print recommendations in human or JSON format."""
    if as_json:
        print(json.dumps(recs, indent=2))
        return

    if not recs:
        print(f"No cost-saving recommendations for this run.")
        return

    print(f"Cost-saving recommendations for run {session}:")
    print()
    for i, rec in enumerate(recs, 1):
        saving = rec["estimated_saving_usd"]
        if isinstance(saving, (int, float)):
            saving_str = f"~${saving:.4f}"
        else:
            saving_str = saving
        print(f"  {i}. [{rec['technique']}] estimated saving {saving_str}")
        print(f"     {rec['action']}")
        print()


def run_cost(args: List[str]) -> int:
    opts = _parse(args)
    target = opts["target"].resolve()

    all_events = _journal.read_events(target)
    if not all_events:
        print(f"No AFK flight recorder found at {_journal.events_path(target)}.")
        print("Run `agentrail afk` first — it records every run automatically.")
        return 0

    sessions = _journal.list_sessions(all_events)

    # --run scoping
    if opts["run"] is not None:
        if opts["run"] not in sessions:
            print(
                f"error: session {opts['run']!r} not found in journal. "
                f"Known sessions: {', '.join(sessions) or '(none)'}",
                file=sys.stderr,
            )
            return 1
        sessions = [opts["run"]]

    # --since filtering
    if opts["since"] is not None:
        since_epoch = _parse_since(opts["since"])
        included = []
        for sid in sessions:
            evs = _journal.session_events(all_events, sid)
            init_ts = _session_init_ts(evs)
            if init_ts is None or init_ts >= since_epoch:
                included.append(sid)
        sessions = included

    agent = resolve_agent_name(str(target), "__config__")
    rows = _collect_rows(all_events, sessions, agent, target)
    # The configured agent may not be the one that actually ran (e.g. config uses
    # a `runners` map with no top-level `runner.name`, so resolution defaults to
    # codex while Claude really ran). If the primary agent yields no usage, probe
    # the other candidates so Claude users don't silently see $0.00.
    if rows and not _rows_have_usage(rows):
        for alt in _candidate_agents(target, agent):
            if alt == agent:
                continue
            alt_rows = _collect_rows(all_events, sessions, alt, target)
            if _rows_have_usage(alt_rows):
                agent, rows = alt, alt_rows
                break
        else:
            print(
                f"warning: no token usage found for agent '{agent}' or any configured "
                "runner; costs shown as $0.00 — check that transcripts exist for the "
                "agent that actually ran.",
                file=sys.stderr,
            )
    total = sum(r["cost_usd"] for r in rows)

    threshold = resolve_default_budget(str(target))
    violations = _emit_budget_warnings(rows, threshold, target)

    # --recommend: build a per-run record and emit recommendations.
    if opts["recommend"]:
        run_id = opts["run"]
        if run_id is None:
            # No session specified — use the first (or only) session found.
            run_id = sessions[0] if sessions else ""
        record = _build_run_record(rows, run_id, all_events)
        recs = recommend(record)
        _render_recommend(recs, opts["json"], run_id)
        return 0

    if opts["json"]:
        out: dict = {"runs": rows, "total_usd": total}
        if violations:
            out["warnings"] = violations
        print(json.dumps(out, indent=2))
        return 0

    _render_human(rows, total)
    return 0
