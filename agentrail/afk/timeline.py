"""
Deterministic replay + observability over the flight-recorder journal.

Because the AFK reducers are pure, replaying the recorded action stream from the
recorded initial state reproduces every intermediate state exactly. That gives
three things no free-text agent log can:

  * **Time travel** — reconstruct the precise fleet state at any step.
  * **Verification** — each replayed state's digest must match what was recorded
    (a mismatch proves the log was edited or the reducer changed).
  * **Real metrics** — time-in-status, where a run stalled, slot utilization,
    retry/round counts — derived from the *actual* state stream, not guessed.

This module is pure analysis over a list of journal events; it does no I/O.
"""
from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from agentrail.afk.journal import action_from_dict, state_digest
from agentrail.afk.state import AfkState, IssueStatus, reduce
from agentrail.afk.store import from_dict


@dataclass
class Step:
    seq: int
    ts: Optional[_dt.datetime]
    kind: str          # "init" | "action"
    label: str         # human-readable description of what happened
    state: AfkState    # state AFTER this step
    digest_ok: bool    # did the replayed digest match the recorded one


def _parse_ts(raw: Optional[str]) -> Optional[_dt.datetime]:
    if not raw:
        return None
    try:
        return _dt.datetime.fromisoformat(raw)
    except ValueError:
        return None


def _describe(action: dict) -> str:
    t = action.get("type", "?")
    n = action.get("number")
    if t == "EnqueueIssue":
        return f"enqueue #{n} — {action.get('title', '')[:48]}"
    if t == "ClaimIssue":
        return f"claim #{n} → slot {action.get('slot')}"
    if t == "ReleaseIssue":
        return f"release #{n} back to queue"
    if t == "SetStatus":
        return f"#{n} → {action.get('status')}"
    if t == "SetPr":
        return f"#{n} opened PR #{action.get('pr')}"
    if t == "RecordFailure":
        err = (action.get("error") or "").strip().splitlines()
        tail = f" — {err[0][:48]}" if err else ""
        return f"#{n} failure recorded{tail}"
    if t == "IncrementReviewRound":
        return f"#{n} review round +1"
    if t == "FreeSlot":
        return f"free slot {action.get('slot')}"
    if t == "RequeueIssue":
        return f"requeue #{n} for a fresh attempt"
    return f"{t} #{n}"


def replay(events: List[dict]) -> List[Step]:
    """
    Rebuild every intermediate state by re-running the recorded actions through
    the pure reducer, starting from the recorded ``init`` state. Each step's
    digest is checked against the recorded one.
    """
    steps: List[Step] = []
    if not events:
        return steps

    init = events[0]
    if init.get("kind") != "init" or "state" not in init:
        raise ValueError("journal does not start with an init event")
    state = from_dict(init["state"])
    steps.append(Step(
        seq=init.get("seq", 0),
        ts=_parse_ts(init.get("ts")),
        kind="init",
        label="session start",
        state=state,
        digest_ok=(state_digest(state) == init.get("digest")),
    ))

    for ev in events[1:]:
        if ev.get("kind") != "action":
            continue
        action = action_from_dict(ev["action"])
        state = reduce(state, action)
        steps.append(Step(
            seq=ev.get("seq", -1),
            ts=_parse_ts(ev.get("ts")),
            kind="action",
            label=_describe(ev["action"]),
            state=state,
            digest_ok=(state_digest(state) == ev.get("digest")),
        ))
    return steps


@dataclass
class IssueMetrics:
    number: int
    title: str = ""
    final_status: str = ""
    pr: Optional[int] = None
    retries: int = 0
    review_rounds: int = 0
    # status -> total seconds spent in it
    time_in_status: Dict[str, float] = field(default_factory=dict)
    total_seconds: float = 0.0


@dataclass
class RunMetrics:
    session: str = ""
    wall_seconds: float = 0.0
    started: Optional[str] = None
    ended: Optional[str] = None
    issue_count: int = 0
    completed: int = 0
    failed: int = 0
    # fraction of available slot-time that was busy, in [0, 1]
    slot_utilization: float = 0.0
    # (issue number, status, seconds) — the single longest dwell in any status
    longest_dwell: Optional[Tuple[int, str, float]] = None
    digest_mismatches: int = 0
    issues: Dict[int, IssueMetrics] = field(default_factory=dict)


def compute_metrics(events: List[dict], session: str = "") -> RunMetrics:
    """
    Derive observability metrics from the replayed state stream. Durations come
    from the wall-clock timestamps between state transitions, so they reflect
    what actually happened — including stalls waiting on an agent or review.
    """
    steps = replay(events)
    m = RunMetrics(session=session)
    if not steps:
        return m

    timed = [s for s in steps if s.ts is not None]
    if timed:
        m.started = timed[0].ts.isoformat()
        m.ended = timed[-1].ts.isoformat()
        m.wall_seconds = max(0.0, (timed[-1].ts - timed[0].ts).total_seconds())
    m.digest_mismatches = sum(1 for s in steps if not s.digest_ok)

    # Per-issue status dwell + slot-busy integration across the timeline.
    # Each wall-clock interval [prev.ts, step.ts] was spent in the state that
    # *resulted* from the previous event, so both metrics attribute it to
    # ``prev.state`` — keeping dwell time and slot utilization consistent.
    busy_slot_seconds = 0.0
    concurrency = steps[-1].state.concurrency or 1
    prev: Optional[Step] = None

    for step in steps:
        if prev is not None and step.ts is not None and prev.ts is not None:
            dt = max(0.0, (step.ts - prev.ts).total_seconds())
            for num, issue in prev.state.issues.items():
                im = m.issues.setdefault(num, IssueMetrics(number=num))
                st = issue.status.value
                im.time_in_status[st] = im.time_in_status.get(st, 0.0) + dt
                im.total_seconds += dt
            active = sum(1 for v in prev.state.slots.values() if v is not None)
            busy_slot_seconds += active * dt
        prev = step

    final = steps[-1].state
    m.issue_count = len(final.issues)
    m.completed = final.completed
    m.failed = final.failed
    for num, issue in final.issues.items():
        im = m.issues.setdefault(num, IssueMetrics(number=num))
        im.title = issue.title
        im.final_status = issue.status.value
        im.pr = issue.pr
        im.retries = issue.retries
        im.review_rounds = issue.review_rounds

    if m.wall_seconds > 0:
        m.slot_utilization = min(1.0, busy_slot_seconds / (concurrency * m.wall_seconds))

    # longest single dwell in any status, ignoring terminal resting states
    resting = {IssueStatus.MERGED.value, IssueStatus.COMMENTED.value,
               IssueStatus.HUMAN_REVIEW.value, IssueStatus.FAILED.value}
    best: Optional[Tuple[int, str, float]] = None
    for num, im in m.issues.items():
        for st, secs in im.time_in_status.items():
            if st in resting:
                continue
            if best is None or secs > best[2]:
                best = (num, st, secs)
    m.longest_dwell = best
    return m


def _fmt_dur(seconds: float) -> str:
    seconds = int(round(seconds))
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m{seconds % 60:02d}s"
    return f"{seconds // 3600}h{(seconds % 3600) // 60:02d}m"


_STATUS_ICON = {
    "queued": "·",
    "claimed": "○",
    "running": "▶",
    "pr_open": "◆",
    "reviewing": "🔍",
    "autofixing": "🔧",
    "merged": "✅",
    "commented": "💬",
    "human_review": "🙋",
    "failed": "✖",
}


def render_timeline(events: List[dict], metrics: RunMetrics) -> str:
    """Human-readable flight-recorder readout for the terminal."""
    steps = replay(events)
    lines: List[str] = []
    sid = metrics.session or (events[0].get("session", "") if events else "")
    lines.append(f"AFK flight recorder — session {sid}")
    lines.append("=" * 64)

    start_ts = next((s.ts for s in steps if s.ts), None)
    for step in steps:
        when = ""
        if step.ts and start_ts:
            when = f"+{_fmt_dur((step.ts - start_ts).total_seconds()):>7}"
        flag = "" if step.digest_ok else "  ⚠ digest mismatch"
        lines.append(f"  {when}  {step.label}{flag}")

    lines.append("")
    lines.append("Summary")
    lines.append("-" * 64)
    lines.append(f"  wall clock        : {_fmt_dur(metrics.wall_seconds)}")
    lines.append(f"  issues            : {metrics.issue_count}  "
                 f"(merged {metrics.completed}, need-human {metrics.failed})")
    lines.append(f"  slot utilization  : {metrics.slot_utilization * 100:.0f}%")
    if metrics.longest_dwell:
        num, st, secs = metrics.longest_dwell
        lines.append(f"  longest stall     : #{num} in '{st}' for {_fmt_dur(secs)}")
    if metrics.digest_mismatches:
        lines.append(f"  ⚠ digest mismatches: {metrics.digest_mismatches} "
                     f"(journal edited or reducer changed)")

    lines.append("")
    lines.append("Per issue")
    lines.append("-" * 64)
    for num in sorted(metrics.issues):
        im = metrics.issues[num]
        icon = _STATUS_ICON.get(im.final_status, "?")
        pr = f"PR #{im.pr}" if im.pr else "no PR"
        breakdown = "  ".join(
            f"{st}:{_fmt_dur(secs)}"
            for st, secs in sorted(im.time_in_status.items(),
                                   key=lambda kv: kv[1], reverse=True)
            if secs >= 1
        )
        lines.append(f"  {icon} #{num} {im.final_status:<13} {pr:<10} "
                     f"retries={im.retries} rounds={im.review_rounds}")
        if breakdown:
            lines.append(f"        {breakdown}")
        if im.title:
            lines.append(f"        {im.title[:58]}")
    return "\n".join(lines)
