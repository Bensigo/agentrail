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
from agentrail.run.routing import _apply_routing, classify, routing_record
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
                 [--routing [--apply]]

Reads the AFK flight-recorder journal (.agentrail/afk/events.jsonl) and
prints real-dollar cost attribution per issue, priced through the model
rate table.

Options:
  --target DIR   Project root (default: .)
  --run ID       Scope to a single session; error if not found
  --since REF    ISO timestamp or YYYY-MM-DD; exclude earlier sessions
  --json         Emit machine-readable JSON
  --routing      Show model_routing overspend report (same-family cheaper model)
  --apply        With --routing: write the cheaper model to .agentrail/config.json
                 idempotently (runners.<agent>.models.<phase>)
"""


def _parse(args: List[str]) -> dict:
    opts: dict = {
        "target": Path("."),
        "run": None,
        "since": None,
        "json": False,
        "routing": False,
        "apply": False,
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
        elif a == "--routing":
            opts["routing"] = True; i += 1
        elif a == "--apply":
            opts["apply"] = True; i += 1
        elif a in ("-h", "--help"):
            print(_usage_text()); raise SystemExit(0)
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
    header = (
        f"{'SESSION':<{col_session}}  {'ISSUE':>{col_issue}}  "
        f"{'MODEL':<{col_model}}  {'IN':>{col_tokens}}  {'OUT':>{col_tokens}}  "
        f"{'CACHE':>{col_tokens}}  {'COST USD':>{col_cost}}"
    )
    sep = "-" * len(header)
    print(header)
    print(sep)
    for r in rows:
        cost_str = f"${r['cost_usd']:.6f}"
        print(
            f"{r['session']:<{col_session}}  {r['issue']:>{col_issue}}  "
            f"{r['model']:<{col_model}}  {r['input_tokens']:>{col_tokens}}  "
            f"{r['output_tokens']:>{col_tokens}}  {r['cache_tokens']:>{col_tokens}}  "
            f"{cost_str:>{col_cost}}"
        )
    print(sep)
    total_str = f"${total:.6f}"
    print(
        f"{'TOTAL':<{col_session}}  {'':>{col_issue}}  "
        f"{'':>{col_model}}  {'':>{col_tokens}}  {'':>{col_tokens}}  "
        f"{'':>{col_tokens}}  {total_str:>{col_cost}}"
    )


def _agent_for_model(model: str) -> str:
    """Infer the agent name from a model string (claude → 'claude', gpt/o* → 'codex')."""
    result = classify(model)
    if result and result[0] == "claude":
        return "claude"
    return "codex"


def _render_routing_human(routing_records: List[dict]) -> None:
    """Print the model_routing overspend report to stdout."""
    if not routing_records:
        print("No cheaper same-family model found for any row.")
        return
    print("\nModel Routing Overspend Report")
    print("=" * 72)
    for rec in routing_records:
        print(
            f"  phase={rec['phase']}  model_used={rec['model_used']}"
            f"  cheaper_model={rec['cheaper_model']}\n"
            f"  tokens={rec['tokens']}  cost_used=${rec['cost_used_usd']:.6f}"
            f"  cost_cheaper=${rec['cost_cheaper_usd']:.6f}"
            f"  overspend=${rec['overspend_usd']:.6f}"
        )


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

    # --routing: build model_routing records for each row
    routing_records: List[dict] = []
    if opts["routing"]:
        for row in rows:
            if not row["model"]:
                continue
            # Reconstruct a usage-like object from the row dict
            class _RowUsage:
                model = row["model"]
                input_tokens = row["input_tokens"]
                output_tokens = row["output_tokens"]
                cache_tokens = row["cache_tokens"]

            rec = routing_record(_RowUsage(), phase="execute")
            if rec is not None:
                row["model_routing"] = rec
                routing_records.append(rec)

        if opts["apply"] and routing_records:
            for rec in routing_records:
                rec_agent = _agent_for_model(rec["model_used"])
                updated = _apply_routing(rec, target, rec_agent)
                if updated:
                    print(
                        f"Applied: runners.{rec_agent}.models.{rec['phase']} = "
                        f"{rec['cheaper_model']} (was: {rec.get('model_used', '')})",
                        file=sys.stderr,
                    )
                else:
                    print(
                        f"No-op: runners.{rec_agent}.models.{rec['phase']} already "
                        f"at {rec['cheaper_model']} or cheaper.",
                        file=sys.stderr,
                    )

    if opts["json"]:
        out: dict = {"runs": rows, "total_usd": total}
        if violations:
            out["warnings"] = violations
        print(json.dumps(out, indent=2))
        return 0

    _render_human(rows, total)
    if opts["routing"]:
        _render_routing_human(routing_records)
    return 0
