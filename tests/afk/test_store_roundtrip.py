"""
Round-trip tests for the AFK on-disk state snapshot (``agentrail.afk.store``).

``_issue_to_dict`` / ``_issue_from_dict`` enumerate ``IssueState`` fields
explicitly, so any new field is silently dropped on resume-from-snapshot unless
it is added to BOTH halves. These tests pin the full round-trip and the
backward-compatibility defaults for old snapshots that predate a field.
"""
from pathlib import Path

from agentrail.afk.state import AfkState, IssueState, IssueStatus
from agentrail.afk.store import (
    _issue_from_dict,
    _issue_to_dict,
    from_dict,
    load_snapshot,
    to_dict,
    write_snapshot,
)


def _issue(**overrides) -> IssueState:
    base = dict(number=7, title="dep wave", url="https://example/7")
    base.update(overrides)
    return IssueState(**base)


def test_blocked_by_survives_dict_roundtrip():
    """blocked_by must survive to_dict -> from_dict and come back as a tuple."""
    issue = _issue(blocked_by=(4, 5))
    state = AfkState(issues={issue.number: issue}, slots={0: None})

    recovered = from_dict(to_dict(state)).issues[issue.number]

    assert recovered == issue
    assert recovered.blocked_by == (4, 5)
    assert isinstance(recovered.blocked_by, tuple)


def test_blocked_by_serializes_as_json_list():
    """JSON has no tuples; the wire form must be a list, restored to a tuple."""
    issue = _issue(blocked_by=(4, 5))
    d = _issue_to_dict(issue)

    assert d["blocked_by"] == [4, 5]
    assert isinstance(d["blocked_by"], list)
    assert isinstance(_issue_from_dict(d).blocked_by, tuple)


def test_blocked_by_survives_file_snapshot(tmp_path: Path):
    """write_snapshot -> load_snapshot must preserve blocked_by end to end."""
    issue = _issue(
        status=IssueStatus.CLAIMED,
        slot=0,
        blocked_by=(4, 5),
    )
    state = AfkState(issues={issue.number: issue}, slots={0: issue.number})

    write_snapshot(tmp_path, state)
    loaded = load_snapshot(tmp_path)

    assert loaded is not None
    recovered = loaded.issues[issue.number]
    assert recovered.blocked_by == (4, 5)
    assert isinstance(recovered.blocked_by, tuple)


def test_old_snapshot_without_blocked_by_loads_with_default():
    """Backward compat: a dict missing blocked_by loads with the () default."""
    legacy = {
        "number": 1,
        "title": "old",
        "url": "u",
        "status": "queued",
        "pr": None,
        "slot": None,
        "retries": 0,
        "review_rounds": 0,
        "error": None,
        # no "blocked_by" key — predates the field
    }

    issue = _issue_from_dict(legacy)

    assert issue.blocked_by == ()
    assert isinstance(issue.blocked_by, tuple)


def test_old_state_dict_without_blocked_by_loads(tmp_path: Path):
    """A whole AfkState dict lacking blocked_by on its issues loads cleanly."""
    legacy_state = {
        "schemaVersion": 1,
        "concurrency": 2,
        "max_retries": 2,
        "max_review_rounds": 3,
        "completed": 0,
        "failed": 0,
        "slots": {"0": None, "1": None},
        "issues": {
            "1": {
                "number": 1,
                "title": "old",
                "url": "u",
                "status": "queued",
            }
        },
    }

    state = from_dict(legacy_state)

    assert state.issues[1].blocked_by == ()
