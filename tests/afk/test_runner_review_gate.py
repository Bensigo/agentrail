import asyncio
import tempfile
from pathlib import Path

import pytest
from agentrail.afk.objective_gate import ObjectiveGateResult


# Re-implements the loop decision logic to lock the contract. The runner's
# _review_and_gate must follow this exact control flow.
async def _drive_loop(gate, fix, merge, escalate, max_fix=2):
    attempts = 0
    while True:
        result = await gate(0)
        if result.passed:
            await merge(0)
            return
        if attempts >= max_fix:
            escalate()
            return
        attempts += 1
        ok = await fix(0, 0, 0, result)
        if not ok:
            escalate()
            return


def test_bounded_fix_escalates_after_two_attempts():
    attempts = {"gate": 0, "fix": 0, "merge": 0, "human": 0}

    async def gate(_pr):
        attempts["gate"] += 1
        return ObjectiveGateResult("fail", ["CI check 'test' failed"])

    async def fix(_slot, _issue, _pr, _gate):
        attempts["fix"] += 1
        return True

    async def merge(_pr):
        attempts["merge"] += 1
        return True

    def escalate():
        attempts["human"] += 1

    asyncio.run(_drive_loop(gate, fix, merge, escalate))
    assert attempts["merge"] == 0
    assert attempts["human"] == 1
    assert attempts["fix"] == 2


def test_pass_path_merges():
    attempts = {"merge": 0, "human": 0, "fix": 0}

    async def gate(_pr):
        return ObjectiveGateResult("pass", [])

    async def fix(_s, _i, _p, _g):
        attempts["fix"] += 1
        return True

    async def merge(_pr):
        attempts["merge"] += 1
        return True

    asyncio.run(_drive_loop(gate, fix, merge,
                            lambda: attempts.__setitem__("human", attempts["human"] + 1)))
    assert attempts["merge"] == 1 and attempts["human"] == 0 and attempts["fix"] == 0


def test_fix_failure_escalates_immediately():
    attempts = {"fix": 0, "merge": 0, "human": 0}

    async def gate(_pr):
        return ObjectiveGateResult("fail", ["CI check 'test' failed"])

    async def fix(_s, _i, _p, _g):
        attempts["fix"] += 1
        return False  # fix failed

    async def merge(_pr):
        attempts["merge"] += 1
        return True

    asyncio.run(_drive_loop(gate, fix, merge,
                            lambda: attempts.__setitem__("human", attempts["human"] + 1)))
    assert attempts["fix"] == 1 and attempts["merge"] == 0 and attempts["human"] == 1


# ---------------------------------------------------------------------------
# Integration tests that drive the REAL Runner._review_and_gate method.
#
# These exist to keep the real method from drifting away from the contract
# the _drive_loop tests above lock down. We build a Runner via __new__ (no real
# __init__ — that would touch git/filesystem in ways we don't want), set only
# the attributes the method path reads, and monkeypatch every async helper so
# nothing external (git/gh/network/agent) runs.
# ---------------------------------------------------------------------------
from agentrail.afk.runner import Runner  # noqa: E402
from agentrail.afk.state import IssueStatus, SetStatus  # noqa: E402
from agentrail.afk import review as review_policy  # noqa: E402


class _Spy:
    """Fake Store: records every dispatched action so we can assert on the
    status transitions the real method drives. SetStatus carries the new state
    on its ``.status`` attribute (see agentrail.afk.state.SetStatus)."""

    def __init__(self):
        self.actions = []

    def dispatch(self, action):
        self.actions.append(action)
        return None

    def statuses(self):
        """The IssueStatus of every SetStatus action dispatched, in order."""
        return [a.status for a in self.actions if isinstance(a, SetStatus)]


def _make_real_runner(monkeypatch, tmpdir, *,
                      review_outcome=None,
                      gate_results=None,
                      fix_result=True,
                      merge_result=True):
    """Build a Runner via __new__ with the minimal attributes _review_and_gate
    touches, and monkeypatch every async/IO helper to a spy. Returns
    (runner, calls) where calls counts/records helper invocations.

    ``gate_results`` is either a single ObjectiveGateResult (returned every
    poll) or a list consumed one per call.
    """
    r = Runner.__new__(Runner)
    r.store = _Spy()
    r.logs = Path(tmpdir)
    r.target = Path(tmpdir)
    # session_id None: push_memory_items short-circuits inside the real method.
    # _push_gate is spied separately below so we still observe round_no values.
    r.session_id = None

    # Pre-create the review file so review_text = read_text() succeeds
    # deterministically (rather than relying on the OSError fallback).
    (Path(tmpdir) / "pr-7-review.md").write_text("review body")

    if review_outcome is None:
        review_outcome = review_policy.ReviewOutcome(findings=[], memory_suggestions=[])

    calls = {
        "review": 0, "gate": 0, "fix": 0, "merge": 0,
        "escalate": 0, "fail": 0, "cleanup": 0, "comment": 0,
        "fail_reasons": [], "gate_rounds": [],
    }

    async def _review(pr):
        calls["review"] += 1
        return review_outcome

    _gate_iter = list(gate_results) if isinstance(gate_results, list) else None

    async def _objective_gate(pr):
        calls["gate"] += 1
        if _gate_iter is not None:
            return _gate_iter[min(calls["gate"] - 1, len(_gate_iter) - 1)]
        return gate_results

    async def _objective_fix(slot, issue, pr, gate):
        calls["fix"] += 1
        return fix_result

    async def _merge(pr):
        calls["merge"] += 1
        return merge_result

    def _escalate_human(issue, pr, reasons):
        calls["escalate"] += 1

    def _fail(issue, reason):
        calls["fail"] += 1
        calls["fail_reasons"].append(reason)

    def _cleanup_issue_labels(issue):
        calls["cleanup"] += 1

    def _push_gate(issue, pr, gate, review_text, round_no):
        calls["gate_rounds"].append(round_no)

    monkeypatch.setattr(r, "_review", _review)
    monkeypatch.setattr(r, "_objective_gate", _objective_gate)
    monkeypatch.setattr(r, "_objective_fix", _objective_fix)
    monkeypatch.setattr(r, "_merge", _merge)
    monkeypatch.setattr(r, "_escalate_human", _escalate_human)
    monkeypatch.setattr(r, "_fail", _fail)
    monkeypatch.setattr(r, "_cleanup_issue_labels", _cleanup_issue_labels)
    monkeypatch.setattr(r, "_push_gate", _push_gate)

    def _comment(pr, body):
        calls["comment"] += 1

    monkeypatch.setattr("agentrail.afk.runner.gh.comment_on_pr", _comment)

    return r, calls


def test_real_review_none_fails_before_gate(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        r, calls = _make_real_runner(
            monkeypatch, td,
            gate_results=ObjectiveGateResult("pass", []),
        )

        async def _review_none(pr):
            calls["review"] += 1
            return None

        monkeypatch.setattr(r, "_review", _review_none)

        asyncio.run(r._review_and_gate(slot=0, issue=1, pr=7))

    assert calls["fail"] == 1
    assert calls["gate"] == 0
    assert calls["merge"] == 0


def test_real_gate_fails_twice_then_escalates(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        r, calls = _make_real_runner(
            monkeypatch, td,
            gate_results=ObjectiveGateResult("fail", ["CI check 'test' failed"]),
            fix_result=True,
        )
        asyncio.run(r._review_and_gate(slot=0, issue=1, pr=7))

    assert calls["escalate"] == 1
    assert calls["merge"] == 0
    assert calls["fix"] == 2
    assert calls["gate_rounds"] == [1, 2, 3]


def test_real_gate_pass_merges_and_marks_merged(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        r, calls = _make_real_runner(
            monkeypatch, td,
            gate_results=ObjectiveGateResult("pass", []),
            merge_result=True,
        )
        asyncio.run(r._review_and_gate(slot=0, issue=1, pr=7))

    assert calls["merge"] == 1
    assert IssueStatus.MERGED in r.store.statuses()
    assert calls["escalate"] == 0


def test_real_merge_failure_calls_fail(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        r, calls = _make_real_runner(
            monkeypatch, td,
            gate_results=ObjectiveGateResult("pass", []),
            merge_result=False,
        )
        asyncio.run(r._review_and_gate(slot=0, issue=1, pr=7))

    assert calls["fail"] == 1
    assert "merge failed" in calls["fail_reasons"][0]
    assert IssueStatus.MERGED not in r.store.statuses()


def test_real_fix_failure_escalates_immediately(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        r, calls = _make_real_runner(
            monkeypatch, td,
            gate_results=ObjectiveGateResult("fail", ["CI check 'test' failed"]),
            fix_result=False,
        )
        asyncio.run(r._review_and_gate(slot=0, issue=1, pr=7))

    assert calls["fix"] == 1
    assert calls["escalate"] == 1
    assert calls["merge"] == 0
