"""Unit tests for the Issue Input-Contract validator (agentrail/afk/input_contract.py).

Behavior-only tests through the public ``validate`` interface. Vocabulary matches
CONTEXT.md: an issue cannot enter the **Issue Queue** without machine-checkable
acceptance criteria. The validator is the GATE on entry to ``queue_state``'s
machine — an issue lacking machine-checkable AC must never become a QueueEntry.

"Machine-checkable" mirrors the ``verify``/check model in
``agentrail/run/check_runner.py``: acceptance criteria that can be turned into
objective, runnable checks (checkbox AC items), not prose alone.
"""
from agentrail.afk.input_contract import (
    Rejected,
    Validated,
    admit_to_queue,
    validate,
)
from agentrail.afk.queue_state import QueueEntry, QueueState, Tier


# --- AC1: an issue WITHOUT machine-checkable AC is REJECTED -------------------


def test_prose_only_acceptance_criteria_is_rejected():
    body = (
        "## Acceptance criteria\n"
        "The feature should work well and feel fast.\n"
    )
    result = validate(body)
    assert isinstance(result, Rejected)


# --- AC2: an issue WITH machine-checkable AC is ADMITTED ----------------------


def test_checkbox_acceptance_criteria_is_admitted():
    body = (
        "## Acceptance criteria\n"
        "- [ ] AC1: `pytest -q` exits 0 on the new test.\n"
        "- [ ] AC2: the queue rejects issues without checkbox AC.\n"
    )
    result = validate(body)
    assert isinstance(result, Validated)
    assert result.criteria == [
        "AC1: `pytest -q` exits 0 on the new test.",
        "AC2: the queue rejects issues without checkbox AC.",
    ]


def test_checked_checkbox_still_counts_as_machine_checkable():
    # A ticked AC (`- [x]`) is still a checkable criterion, not prose.
    body = "## Acceptance criteria\n- [x] AC1: build exits 0.\n"
    result = validate(body)
    assert isinstance(result, Validated)
    assert result.criteria == ["AC1: build exits 0."]


def test_checkboxes_outside_acceptance_section_do_not_admit():
    # Only the Acceptance-criteria section counts. A task list under another
    # heading is not acceptance criteria, so the issue is rejected.
    body = (
        "## What to build\n"
        "- [ ] wire the validator\n"
        "- [ ] add the console view\n"
        "## Acceptance criteria\n"
        "It should be correct and tested.\n"
    )
    result = validate(body)
    assert isinstance(result, Rejected)


def test_missing_acceptance_section_is_rejected():
    result = validate("## What to build\nSomething nice.\n")
    assert isinstance(result, Rejected)


def test_empty_body_is_rejected():
    assert isinstance(validate(""), Rejected)


def test_house_template_body_is_admitted():
    # The real house issue template (Parent / Acceptance criteria / Verification).
    body = (
        "## Parent\n"
        "docs/milestones/035.md\n"
        "## Acceptance criteria\n"
        "- [ ] AC1: An issue without machine-checkable AC is rejected.\n"
        "- [ ] AC2: An issue with machine-checkable AC is admitted.\n"
        "- [ ] AC3: The console shows the queue.\n"
        "## Verification\n"
        "Validator unit tests; queue-view screenshots.\n"
    )
    result = validate(body)
    assert isinstance(result, Validated)
    assert len(result.criteria) == 3


# --- The GATE: validation decides whether an issue becomes a QueueEntry -------


def test_admit_to_queue_creates_entry_for_machine_checkable_issue():
    # AC2: a validated issue enters the queue as a QueueEntry carrying its
    # tier/budget/state (the queue_state machine, not a duplicate).
    body = "## Acceptance criteria\n- [ ] AC1: tests pass.\n"
    entry = admit_to_queue(number=778, issue_body=body)
    assert isinstance(entry, QueueEntry)
    assert entry.number == 778
    assert entry.tier is Tier.CHEAP
    assert entry.state is QueueState.QUEUED


def test_admit_to_queue_rejects_issue_without_machine_checkable_ac():
    # AC1: an issue lacking checkbox AC never becomes a QueueEntry — the gate
    # returns the Rejected reason instead.
    body = "## Acceptance criteria\nIt should be great.\n"
    result = admit_to_queue(number=99, issue_body=body)
    assert isinstance(result, Rejected)


def test_admit_to_queue_preserves_blocked_by_dependencies():
    # A validated issue keeps its blocked_by set so queue_state.admit can park it.
    body = "## Acceptance criteria\n- [ ] AC1: tests pass.\n"
    entry = admit_to_queue(number=1, issue_body=body, blocked_by=frozenset({42}))
    assert isinstance(entry, QueueEntry)
    assert entry.blocked_by == frozenset({42})
