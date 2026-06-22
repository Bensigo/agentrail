"""Acceptance test for issue #876 — Configurable Merge Policy in the Heartbeat runner.

RED until the Implementer adds:
  - RuntimeConfig.merge_enabled: bool = False   (per-repo toggle, AC1)
  - IssueRef.labels: frozenset[str] = frozenset()  (per-issue label, AC4)
  - HeartbeatRuntime.__init__ merger kwarg        (injected merge callable, AC2/AC3)
  - merge-decision run event recorded in store    (AC5)

The test drives the public interface — RuntimeConfig, IssueRef, HeartbeatRuntime —
and never touches implementation internals. The runtime must NOT be modified to make
this pass until the Implementer turn; a passing test with zero production changes
would be tautological (ADR 0008 / CONTEXT.md Red-Green Proof).

Coverage map:
  AC1  test_ac1_merge_enabled_defaults_to_false
  AC2  test_ac2_policy_off_no_label_green_run_leaves_pr_open
  AC3  test_ac3_policy_on_green_run_squash_merges
       test_ac3_policy_on_red_run_does_not_merge
  AC4  test_ac4_auto_merge_label_overrides_repo_policy_off
  AC5  test_ac5_merge_decision_recorded_as_run_event
       test_ac5_left_for_human_recorded_when_merge_skipped
"""
from __future__ import annotations

from typing import FrozenSet, List, Optional, Tuple

import pytest

from agentrail.connectors.base import IssueRef, OutcomeReport
from agentrail.connectors.discord import TaskResult
from agentrail.heartbeat.gate import REQUIRED_CAPABILITIES
from agentrail.heartbeat.runtime import HeartbeatRuntime, RuntimeConfig
from agentrail.sandbox.docker_runner import RunResult
from agentrail.afk.queue_state import QueueEntry


# ---------------------------------------------------------------------------
# Shared fakes (minimal — only what the merge-policy path needs)
# ---------------------------------------------------------------------------

class _FakeConnector:
    def __init__(self, issues: List[IssueRef]):
        self._issues = issues
        self.posted: List[Tuple[IssueRef, OutcomeReport]] = []

    def poll(self, workspace_id: str) -> List[IssueRef]:
        return list(self._issues)

    def post_result(self, issue_ref: IssueRef, result: OutcomeReport) -> None:
        self.posted.append((issue_ref, result))


class _FakeStore:
    """In-memory store that records every register_run call (for AC5 audit check)."""

    def __init__(self):
        self.enqueued: List[dict] = []
        self.transitions: List[tuple] = []
        self.runs: List[dict] = []
        self._grabbable: List[QueueEntry] = []

    def enqueue(self, *, workspace_id, source, external_id, title, body,
                blocked_by=frozenset()):
        number = len(self._grabbable) + 1
        entry = QueueEntry(number=number)
        self._grabbable.append(entry)
        self.enqueued.append({"external_id": external_id})
        return entry

    def next_grabbable(self, workspace_id):
        return self._grabbable.pop(0) if self._grabbable else None

    def transition(self, entry, event):
        from agentrail.afk import queue_state
        nxt = queue_state.transition(entry, event)
        self.transitions.append((entry.number, event, nxt.state))
        return nxt

    def register_run(self, *, entry, run_id, phase, status, cost_usd=0.0):
        self.runs.append(
            {"number": entry.number, "run_id": run_id, "phase": phase,
             "status": status, "cost_usd": cost_usd}
        )

    def list_queue(self, workspace_id):
        return []


class _FakeNotifier:
    def __init__(self):
        self.tasks: List[TaskResult] = []

    def task_done(self, result: TaskResult) -> None:
        self.tasks.append(result)

    def daily_digest(self, finished):
        pass


class _FakeMerger:
    """Captures merge calls; tests assert calls == [] (not called) or calls != []."""

    def __init__(self, *, success: bool = True, mode: str = ""):
        self.calls: List[dict] = []
        self._success = success
        self._mode = mode

    def __call__(self, *, pr_url: str, subject: str) -> Tuple[bool, str]:
        self.calls.append({"pr_url": pr_url, "subject": subject})
        return self._success, self._mode


_VALID_BODY = "## Acceptance criteria\n- [ ] AC1: it works\n"
_PR_URL = "https://github.com/acme/widgets/pull/42"


def _build_runtime(
    *,
    merge_enabled: bool,
    issue_labels: FrozenSet[str] = frozenset(),
    run_status: str = "green",
    merger: Optional[_FakeMerger] = None,
):
    """Return (runtime, store, merger) wired for one-issue merge-policy tests."""
    if merger is None:
        merger = _FakeMerger()

    ref = IssueRef(
        repo="acme/widgets",
        number=42,
        title="Add widget feature",
        body=_VALID_BODY,
        url="https://gh/42",
        labels=issue_labels,          # AC4 — IssueRef must gain a `labels` field
    )
    connector = _FakeConnector([ref])
    store = _FakeStore()
    notifier = _FakeNotifier()

    result = RunResult(
        status=run_status,
        cost_usd=0.5,
        branch="afk/42",
        pr_url=_PR_URL,
    )

    # AC1 — RuntimeConfig must gain merge_enabled (default False)
    cfg = RuntimeConfig(
        workspace_id="ws-1",
        repo_url="https://github.com/acme/widgets.git",
        merge_enabled=merge_enabled,
    )

    sandbox_calls: List[dict] = []

    def _sandbox(*, repo_url, ref, issue_ref, workspace_id, env,
                 model=None, failure_handoff=None):
        sandbox_calls.append({"issue_ref": issue_ref})
        return result

    # AC2/AC3 — HeartbeatRuntime must accept a `merger` kwarg
    rt = HeartbeatRuntime(
        connector=connector,
        store=store,
        sandbox_runner=_sandbox,
        notifier=notifier,
        config=cfg,
        detect_capabilities=lambda: REQUIRED_CAPABILITIES,
        merger=merger,
    )
    return rt, store, merger


# ---------------------------------------------------------------------------
# AC1: per-repo toggle defaults to OFF
# ---------------------------------------------------------------------------

def test_ac1_merge_enabled_defaults_to_false():
    """RuntimeConfig.merge_enabled must default to False (Merge Policy is OFF by default)."""
    cfg = RuntimeConfig(workspace_id="ws", repo_url="https://gh/r.git")
    assert cfg.merge_enabled is False, (
        "Merge Policy must default OFF — auto-merge is irreversible; "
        "teams opt in explicitly (AC1)"
    )


# ---------------------------------------------------------------------------
# AC2: repo OFF + no label → green run leaves PR open, no merge attempted
# ---------------------------------------------------------------------------

def test_ac2_policy_off_no_label_green_run_leaves_pr_open():
    """merge_enabled=OFF, no auto-merge label, Green run → merger is never called."""
    merger = _FakeMerger()
    rt, store, merger = _build_runtime(
        merge_enabled=False,
        issue_labels=frozenset(),
        run_status="green",
        merger=merger,
    )

    rt.poll_and_dispatch("ws-1")

    assert merger.calls == [], (
        "merger must NOT be called when Merge Policy is OFF and issue has no "
        "auto-merge label (AC2): the PR is left open for a human"
    )


# ---------------------------------------------------------------------------
# AC3: repo ON → squash-merge on Green; NOT on Red
# ---------------------------------------------------------------------------

def test_ac3_policy_on_green_run_squash_merges():
    """merge_enabled=ON + Green run → merger is called exactly once with the PR URL."""
    merger = _FakeMerger(success=True)
    rt, store, merger = _build_runtime(
        merge_enabled=True,
        run_status="green",
        merger=merger,
    )

    rt.poll_and_dispatch("ws-1")

    assert len(merger.calls) == 1, (
        "merger must be called exactly once when Merge Policy is ON and run is Green (AC3)"
    )
    assert merger.calls[0]["pr_url"] == _PR_URL, (
        "merger must receive the PR URL from the RunResult (AC3)"
    )


def test_ac3_policy_on_red_run_does_not_merge():
    """merge_enabled=ON + Red run → merger is never called (merge only on Green)."""
    merger = _FakeMerger()
    rt, store, merger = _build_runtime(
        merge_enabled=True,
        run_status="red",
        merger=merger,
    )

    rt.poll_and_dispatch("ws-1")

    assert merger.calls == [], (
        "merger must NOT be called when the run did not reach Green (AC3): "
        "merge fires only after Objective Gate + Independent Verification pass"
    )


# ---------------------------------------------------------------------------
# AC4: per-issue auto-merge label overrides repo OFF
# ---------------------------------------------------------------------------

def test_ac4_auto_merge_label_overrides_repo_policy_off():
    """auto-merge label on the issue opts it into merge even when repo policy is OFF."""
    merger = _FakeMerger(success=True)
    rt, store, merger = _build_runtime(
        merge_enabled=False,
        issue_labels=frozenset({"auto-merge"}),
        run_status="green",
        merger=merger,
    )

    rt.poll_and_dispatch("ws-1")

    assert len(merger.calls) == 1, (
        "auto-merge label must override repo-level OFF and trigger the merge (AC4)"
    )


# ---------------------------------------------------------------------------
# AC5: merge decision recorded as a run / audit event
# ---------------------------------------------------------------------------

def test_ac5_merge_decision_recorded_as_run_event():
    """When merge fires (policy ON, Green), a run event with status='merged' is stored."""
    merger = _FakeMerger(success=True)
    rt, store, merger = _build_runtime(
        merge_enabled=True,
        run_status="green",
        merger=merger,
    )

    rt.poll_and_dispatch("ws-1")

    merge_events = [r for r in store.runs if r.get("status") == "merged"]
    assert merge_events, (
        "a run event with status='merged' must be recorded after a successful merge "
        "so the merge decision is auditable (AC5)"
    )


def test_ac5_left_for_human_recorded_when_merge_skipped():
    """When merge is skipped (policy OFF, no label, Green), a 'left-for-human' event is stored."""
    merger = _FakeMerger()
    rt, store, merger = _build_runtime(
        merge_enabled=False,
        issue_labels=frozenset(),
        run_status="green",
        merger=merger,
    )

    rt.poll_and_dispatch("ws-1")

    skip_events = [r for r in store.runs if r.get("status") == "left-for-human"]
    assert skip_events, (
        "a run event with status='left-for-human' must be recorded when merge is "
        "skipped (policy OFF, no label) so the decision not to merge is also auditable (AC5)"
    )
