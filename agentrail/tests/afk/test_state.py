from pathlib import Path

import pytest

from agentrail.afk.state import (
    AfkState,
    ClaimIssue,
    EnqueueIssue,
    IncrementReviewRound,
    IssueStatus,
    RecordCost,
    RecordFailure,
    RequeueIssue,
    SetPr,
    SetStatus,
    Store,
)
from agentrail.afk.store import from_dict, load_snapshot, to_dict, write_snapshot


def _store(concurrency=2, max_retries=2, max_review_rounds=3):
    return Store(AfkState(
        concurrency=concurrency,
        max_retries=max_retries,
        max_review_rounds=max_review_rounds,
        slots={i: None for i in range(concurrency)},
    ))


def test_enqueue_is_idempotent():
    s = _store()
    s.dispatch(EnqueueIssue(1, "a", "u"))
    s.dispatch(EnqueueIssue(1, "a", "u"))
    assert len(s.state.issues) == 1


def test_claim_next_is_atomic_no_double_claim():
    s = _store(concurrency=2)
    s.dispatch(EnqueueIssue(10, "a", "u"))
    s.dispatch(EnqueueIssue(11, "b", "u"))
    first = s.claim_next()
    second = s.claim_next()
    # two distinct issues, two distinct slots — the race fix
    assert first.number != second.number
    assert first.slot != second.slot
    # queue empty now -> no more claims even with a free... (no free slot anyway)
    assert s.claim_next() is None


def test_claim_respects_concurrency():
    s = _store(concurrency=1)
    s.dispatch(EnqueueIssue(1, "a", "u"))
    s.dispatch(EnqueueIssue(2, "b", "u"))
    assert s.claim_next().number == 1
    # only one slot — second claim blocked until slot frees
    assert s.claim_next() is None


def test_claim_lowest_number_first():
    s = _store(concurrency=3)
    for n in (30, 10, 20):
        s.dispatch(EnqueueIssue(n, "x", "u"))
    assert s.claim_next().number == 10


def test_failure_under_cap_requeues():
    s = _store(max_retries=2)
    s.dispatch(EnqueueIssue(1, "a", "u"))
    s.claim_next()
    s.dispatch(RecordFailure(1, "boom"))
    issue = s.state.issues[1]
    assert issue.status == IssueStatus.QUEUED
    assert issue.retries == 1
    assert issue.slot is None
    assert s.state.slots[0] is None  # slot freed


def test_failure_at_cap_goes_human_review():
    s = _store(max_retries=2)
    s.dispatch(EnqueueIssue(1, "a", "u"))
    s.claim_next()
    s.dispatch(RecordFailure(1, "boom"))
    s.claim_next()  # re-claim
    s.dispatch(RecordFailure(1, "boom again"))
    issue = s.state.issues[1]
    assert issue.status == IssueStatus.HUMAN_REVIEW
    assert issue.retries == 2
    assert s.state.failed == 1
    assert s.state.slots[0] is None


def test_merge_increments_completed_and_frees_slot():
    s = _store()
    s.dispatch(EnqueueIssue(1, "a", "u"))
    s.claim_next()
    s.dispatch(SetPr(1, 99))
    s.dispatch(SetStatus(1, IssueStatus.MERGED))
    assert s.state.completed == 1
    assert s.state.issues[1].slot is None
    assert s.state.slots[0] is None


def test_review_round_increment():
    s = _store()
    s.dispatch(EnqueueIssue(1, "a", "u"))
    s.dispatch(IncrementReviewRound(1))
    s.dispatch(IncrementReviewRound(1))
    assert s.state.issues[1].review_rounds == 2


def test_cannot_claim_non_queued():
    s = _store()
    s.dispatch(EnqueueIssue(1, "a", "u"))
    s.claim_next()
    with pytest.raises(ValueError):
        s.dispatch(ClaimIssue(1, 1))


def test_is_drained():
    s = _store(concurrency=1)
    assert s.state.is_drained()
    s.dispatch(EnqueueIssue(1, "a", "u"))
    assert not s.state.is_drained()
    s.claim_next()
    assert not s.state.is_drained()  # active
    s.dispatch(SetStatus(1, IssueStatus.MERGED))
    assert s.state.is_drained()


def test_requeue_resets_terminal_issue_keeping_pr():
    s = _store()
    s.dispatch(EnqueueIssue(1, "a", "u"))
    s.claim_next()
    s.dispatch(SetPr(1, 50))
    # drive to human_review
    s.dispatch(RecordFailure(1, "boom"))
    s.claim_next()
    s.dispatch(RecordFailure(1, "boom2"))
    assert s.state.issues[1].status == IssueStatus.HUMAN_REVIEW
    assert s.state.failed == 1
    # requeue for a fresh attempt
    s.dispatch(RequeueIssue(1))
    issue = s.state.issues[1]
    assert issue.status == IssueStatus.QUEUED
    assert issue.retries == 0
    assert issue.review_rounds == 0
    assert issue.error is None
    assert issue.pr == 50           # PR kept → stays idempotent
    assert s.state.failed == 0      # counter decremented
    # and it is claimable again
    assert s.claim_next().number == 1


def test_requeue_decrements_completed_for_merged():
    s = _store()
    s.dispatch(EnqueueIssue(1, "a", "u"))
    s.claim_next()
    s.dispatch(SetStatus(1, IssueStatus.MERGED))
    assert s.state.completed == 1
    s.dispatch(RequeueIssue(1))
    assert s.state.completed == 0
    assert s.state.issues[1].status == IssueStatus.QUEUED


def test_persistence_roundtrip(tmp_path: Path):
    s = _store()
    s.dispatch(EnqueueIssue(1, "a", "u"))
    s.claim_next()
    s.dispatch(SetPr(1, 42))
    write_snapshot(tmp_path, s.state)
    loaded = load_snapshot(tmp_path)
    assert loaded is not None
    assert loaded.issues[1].pr == 42
    assert loaded.issues[1].status == IssueStatus.CLAIMED


def test_to_from_dict_identity():
    s = _store()
    s.dispatch(EnqueueIssue(5, "t", "url"))
    again = from_dict(to_dict(s.state))
    assert again.issues[5].title == "t"
    assert again.concurrency == s.state.concurrency


def test_record_cost_sets_issue_cost():
    s = _store()
    s.dispatch(EnqueueIssue(1, "a", "u"))
    assert s.state.issues[1].cost_usd == 0.0
    s.dispatch(RecordCost(1, 0.42))
    assert s.state.issues[1].cost_usd == 0.42


def test_record_cost_is_set_not_accumulated():
    # The pipeline reports the run's *cumulative* cost, so a retry/re-dispatch
    # overwrites rather than adds — a second RecordCost replaces the first.
    s = _store()
    s.dispatch(EnqueueIssue(1, "a", "u"))
    s.dispatch(RecordCost(1, 0.10))
    s.dispatch(RecordCost(1, 0.25))
    assert s.state.issues[1].cost_usd == 0.25


def test_record_cost_coerces_to_float():
    s = _store()
    s.dispatch(EnqueueIssue(1, "a", "u"))
    s.dispatch(RecordCost(1, 1))  # int in, float out
    assert isinstance(s.state.issues[1].cost_usd, float)
    assert s.state.issues[1].cost_usd == 1.0


def test_record_cost_unknown_issue_raises():
    s = _store()
    with pytest.raises(KeyError):
        s.dispatch(RecordCost(999, 0.1))
