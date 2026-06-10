from pathlib import Path

from agentrail.afk import journal, timeline
from agentrail.afk.journal import (
    action_from_dict,
    action_to_dict,
    attach_journal,
    read_events,
    session_events,
)
from agentrail.afk.state import (
    AfkState,
    EnqueueIssue,
    IssueStatus,
    RecordFailure,
    SetPr,
    SetStatus,
    Store,
)


def _store(concurrency=2):
    return Store(AfkState(
        concurrency=concurrency,
        max_retries=2,
        max_review_rounds=3,
        slots={i: None for i in range(concurrency)},
    ))


# --- action serialization ---------------------------------------------------


def test_action_roundtrip_all_types():
    actions = [
        EnqueueIssue(1, "title", "url"),
        SetStatus(1, IssueStatus.MERGED),
        SetPr(1, 42),
        RecordFailure(1, "boom"),
    ]
    for a in actions:
        again = action_from_dict(action_to_dict(a))
        assert again == a


def test_setstatus_enum_serializes_to_value():
    d = action_to_dict(SetStatus(1, IssueStatus.REVIEWING))
    assert d["status"] == "reviewing"
    assert action_from_dict(d).status == IssueStatus.REVIEWING


# --- journal write/read -----------------------------------------------------


def test_attach_journal_records_init_and_actions(tmp_path: Path):
    s = _store()
    sid = attach_journal(s, tmp_path)
    s.dispatch(EnqueueIssue(1, "a", "u"))
    s.claim_next()
    events = read_events(tmp_path)
    assert events[0]["kind"] == "init"
    assert events[0]["session"] == sid
    kinds = [e["kind"] for e in events]
    assert kinds == ["init", "action", "action"]
    # seq is monotonic
    assert [e["seq"] for e in events] == [0, 1, 2]


def test_sessions_are_segmented(tmp_path: Path):
    s1 = _store()
    sid1 = attach_journal(s1, tmp_path, session="run-1")
    s1.dispatch(EnqueueIssue(1, "a", "u"))
    s2 = _store()
    sid2 = attach_journal(s2, tmp_path, session="run-2")
    s2.dispatch(EnqueueIssue(2, "b", "u"))

    all_events = read_events(tmp_path)
    assert journal.list_sessions(all_events) == [sid1, sid2]
    # latest session by default
    latest = session_events(all_events)
    assert {e["session"] for e in latest} == {"run-2"}


def test_read_events_tolerates_torn_final_line(tmp_path: Path):
    s = _store()
    attach_journal(s, tmp_path)
    s.dispatch(EnqueueIssue(1, "a", "u"))
    path = journal.events_path(tmp_path)
    with open(path, "a") as fh:
        fh.write('{"v":1,"session":"x","seq":99,"kind":"act')  # crash mid-write
    events = read_events(tmp_path)
    # the torn line is dropped; the good prefix survives
    assert all("kind" in e for e in events)
    assert events[-1]["seq"] == 1


# --- deterministic replay ---------------------------------------------------


def test_replay_reconstructs_final_state(tmp_path: Path):
    s = _store()
    attach_journal(s, tmp_path)
    s.dispatch(EnqueueIssue(1, "a", "u"))
    s.claim_next()
    s.dispatch(SetPr(1, 42))
    s.dispatch(SetStatus(1, IssueStatus.MERGED))

    steps = timeline.replay(read_events(tmp_path))
    final = steps[-1].state
    assert final.issues[1].pr == 42
    assert final.issues[1].status == IssueStatus.MERGED
    assert final.completed == 1
    # every step's digest matched what was recorded (pure replay)
    assert all(step.digest_ok for step in steps)


def test_replay_detects_tampering(tmp_path: Path):
    s = _store()
    attach_journal(s, tmp_path)
    s.dispatch(EnqueueIssue(1, "a", "u"))
    events = read_events(tmp_path)
    # corrupt the recorded digest of the action event
    events[-1]["digest"] = "deadbeef0000"
    steps = timeline.replay(events)
    assert steps[-1].digest_ok is False


# --- metrics ----------------------------------------------------------------


def _event(seq, ts, kind, **extra):
    e = {"v": 1, "session": "t", "seq": seq, "ts": ts, "kind": kind}
    e.update(extra)
    return e


def test_metrics_time_in_status_and_utilization():
    # hand-build a timeline with explicit timestamps to assert durations
    init_state = {
        "concurrency": 1, "max_retries": 2, "max_review_rounds": 3,
        "completed": 0, "failed": 0, "slots": {"0": None}, "issues": {},
    }
    base = "2026-06-10T00:00:"
    events = [
        _event(0, base + "00+00:00", "init", state=init_state,
               digest=journal.state_digest(timeline.from_dict(init_state))),
        _event(1, base + "00+00:00", "action",
               action={"type": "EnqueueIssue", "number": 1, "title": "x", "url": "u"}),
        _event(2, base + "10+00:00", "action",
               action={"type": "ClaimIssue", "number": 1, "slot": 0}),
        _event(3, base + "40+00:00", "action",
               action={"type": "SetStatus", "number": 1, "status": "merged"}),
    ]
    m = timeline.compute_metrics(events, session="t")
    assert m.wall_seconds == 40
    im = m.issues[1]
    # 0-10s queued, 10-40s claimed (slot busy the whole 30s)
    assert round(im.time_in_status["queued"]) == 10
    assert round(im.time_in_status["claimed"]) == 30
    assert m.completed == 1
    # slot busy 30s of 40s wall on a 1-slot run
    assert abs(m.slot_utilization - 0.75) < 0.01
    assert m.longest_dwell[0] == 1


def test_metrics_empty_journal_is_safe():
    m = timeline.compute_metrics([])
    assert m.issue_count == 0
    assert m.wall_seconds == 0.0
