"""
``agentrail timeline`` — read the AFK flight recorder.

Replays a recorded AFK run from its event journal and prints a deterministic
timeline plus observability metrics (time-in-status, slot utilization, where the
run stalled). Pure read side: it never touches GitHub or git, so it is safe to
run at any time, including while a run is in progress.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import List

from agentrail.afk import journal, timeline


def _usage() -> str:
    return """Usage:
  agentrail timeline [--target DIR] [--session ID] [--list] [--json]

Replays the AFK flight recorder (.agentrail/afk/events.jsonl) and prints a
deterministic timeline + metrics for a run.

Options:
  --target DIR   Project root (default: .)
  --session ID   Which recorded session to show (default: the latest)
  --list         List recorded sessions and exit
  --json         Emit machine-readable JSON (events + metrics) instead of text
"""


def _parse(args: List[str]) -> dict:
    opts = {"target": Path("."), "session": None, "list": False, "json": False}
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--target":
            opts["target"] = Path(args[i + 1]); i += 2
        elif a == "--session":
            opts["session"] = args[i + 1]; i += 2
        elif a == "--list":
            opts["list"] = True; i += 1
        elif a == "--json":
            opts["json"] = True; i += 1
        elif a in ("-h", "--help"):
            print(_usage()); raise SystemExit(0)
        else:
            raise SystemExit(f"unknown option: {a}")
    return opts


def _metrics_to_dict(m: timeline.RunMetrics) -> dict:
    return {
        "session": m.session,
        "wall_seconds": m.wall_seconds,
        "started": m.started,
        "ended": m.ended,
        "issue_count": m.issue_count,
        "completed": m.completed,
        "failed": m.failed,
        "slot_utilization": m.slot_utilization,
        "longest_dwell": (
            {"issue": m.longest_dwell[0], "status": m.longest_dwell[1],
             "seconds": m.longest_dwell[2]}
            if m.longest_dwell else None
        ),
        "digest_mismatches": m.digest_mismatches,
        "issues": {
            str(num): {
                "title": im.title,
                "final_status": im.final_status,
                "pr": im.pr,
                "retries": im.retries,
                "review_rounds": im.review_rounds,
                "time_in_status": im.time_in_status,
                "total_seconds": im.total_seconds,
            }
            for num, im in m.issues.items()
        },
    }


def run_timeline(args: List[str]) -> int:
    opts = _parse(args)
    target = opts["target"].resolve()

    all_events = journal.read_events(target)
    if not all_events:
        print(f"No AFK flight recorder found at {journal.events_path(target)}.")
        print("Run `agentrail afk` first — it records every run automatically.")
        return 0

    sessions = journal.list_sessions(all_events)
    if opts["list"]:
        print(f"Recorded AFK sessions ({len(sessions)}):")
        for sid in sessions:
            count = sum(1 for e in all_events if e.get("session") == sid)
            marker = "  (latest)" if sid == sessions[-1] else ""
            print(f"  {sid}  —  {count} events{marker}")
        return 0

    events = journal.session_events(all_events, opts["session"])
    if not events:
        print(f"No events for session {opts['session']!r}. "
              f"Known sessions: {', '.join(sessions) or '(none)'}")
        return 1

    sid = events[0].get("session", "")
    metrics = timeline.compute_metrics(events, session=sid)

    if opts["json"]:
        print(json.dumps({
            "session": sid,
            "events": events,
            "metrics": _metrics_to_dict(metrics),
        }, indent=2))
        return 0

    print(timeline.render_timeline(events, metrics))
    return 0
