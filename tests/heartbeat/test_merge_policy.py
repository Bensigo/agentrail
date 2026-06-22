"""Acceptance test for issue #876 — Configurable Merge Policy in Heartbeat.

RED: this test MUST FAIL before implementation. It encodes the full AC contract
and drives through the public interface only. The Implementer turns it green.

Covers all five ACs:
  AC1 — RuntimeConfig.auto_merge defaults to False (OFF); the field must exist
         and be persistable (DB column) and editable (dashboard toggle).
         Here we assert the default and that it propagates into dispatch logic.
  AC2 — repo OFF + no auto-merge label → a green run leaves the PR unmerged;
         no merge_pr call is made.
  AC3 — repo ON → a green run squash-merges the PR via the injected merge_pr;
         a red run (not green) never triggers merge even when ON.
  AC4 — per-issue auto-merge label overrides a repo OFF setting for that ticket.
  AC5 — the merge decision and outcome (merged / left-for-human, with reason)
         are recorded as a Run Event via store.record_event.

The injectable ``merge_pr`` seam mirrors the existing sandbox/connector injection
pattern so the runtime stays fully hermetic (no real GitHub calls needed here).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, FrozenSet, List, Optional, Tuple

import pytest

from agentrail.afk.queue_state import (
    Event,
    QueueEntry,
    QueueState,
    Terminal,
)
from agentrail.connectors.base import IssueRef, OutcomeReport
from agentrail.connectors.discord import TaskResult
from agentrail.heartbeat.gate import Capability, REQUIRED_CAPABILITIES
# RuntimeConfig must gain an ``auto_merge: bool = False`` field (AC1).
from agentrail.heartbeat.runtime import HeartbeatRuntime, RuntimeConfig
from agentrail.sandbox.docker_runner import RunResult


# --------------------------------------------------------------------------- #
# Fakes — extend the existing patterns from test_runtime.py
# --------------------------------------------------------------------------- #

class FakeConnector:
    def __init__(self, issues: List[IssueRef]):
        self._issues = issues
        self.posted: List[tuple] = []

    def poll(self, workspace_id: str) -> List[IssueRef]:
        return list(self._issues)

    def post_result(self, issue_ref: IssueRef, result: OutcomeReport) -> None:
        self.posted.append((issue_ref, result))


class FakeStore:
    """Extends the minimal store fake with an ``events`` list for AC5."""

    def __init__(self):
        self.enqueued: List[dict] = []
        self.transitions: List[tuple] = []
        self.runs: List[dict] = []
        # AC5: all record_event calls land here.
        self.events: List[dict] = []
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
        self.runs.append({"number": entry.number, "status": status,
                          "cost_usd": cost_usd})

    def record_event(self, *, kind: str, **payload) -> None:
        """AC5: the runtime must call this to record the merge decision."""
        self.events.append({"kind": kind, **payload})

    def list_queue(self, workspace_id):
        return []


class FakeNotifier:
    def __init__(self):
        self.tasks: List[TaskResult] = []

    def task_done(self, result: TaskResult) -> None:
        self.tasks.append(result)

    def daily_digest(self, finished):
        pass


_VALID_BODY = "## Acceptance criteria\n- [ ] AC1: it works\n"


def _config(**overrides) -> RuntimeConfig:
    base = dict(
        workspace_id="ws-1",
        repo_url="https://github.com/acme/widgets.git",
        ref="main",
        env={"AGENT_API_KEY": "k"},
        cheap_model="claude-haiku-4-5",
        strong_model="claude-opus-4-6",
        # AC1: auto_merge must be a field on RuntimeConfig, defaulting to False.
        # This kwarg will raise TypeError until the Implementer adds it.
        auto_merge=False,
    )
    base.update(overrides)
    return RuntimeConfig(**base)


def _runtime(
    *,
    connector,
    store,
    notifier,
    default_result: Optional[RunResult] = None,
    result_sequence: Optional[List[RunResult]] = None,
    capabilities: FrozenSet[Capability] = REQUIRED_CAPABILITIES,
    config: Optional[RuntimeConfig] = None,
    merge_pr=None,
):
    default_result = default_result or RunResult(
        status="green", cost_usd=0.5, branch="afk/1",
        pr_url="https://github.com/acme/widgets/pull/1",
    )
    seq = list(result_sequence) if result_sequence is not None else None
    calls: List[dict] = []

    def sandbox_runner(*, repo_url, ref, issue_ref, workspace_id, env,
                       model=None, failure_handoff=None):
        calls.append({"issue_ref": issue_ref, "model": model})
        if seq is not None:
            return seq.pop(0)
        return default_result

    merge_calls: List[dict] = []

    def _default_merge(pr_url: str, subject: str) -> Tuple[bool, str]:
        merge_calls.append({"pr_url": pr_url, "subject": subject})
        return True, ""

    # AC2/AC3/AC4: merge_pr is an injectable seam on HeartbeatRuntime.
    # HeartbeatRuntime.__init__ must accept a ``merge_pr`` keyword argument.
    # This will raise TypeError until the Implementer adds it.
    rt = HeartbeatRuntime(
        connector=connector,
        store=store,
        sandbox_runner=sandbox_runner,
        notifier=notifier,
        config=config or _config(),
        detect_capabilities=lambda: capabilities,
        merge_pr=merge_pr or _default_merge,
    )
    rt._sandbox_calls = calls          # type: ignore[attr-defined]
    rt._merge_calls = merge_calls      # type: ignore[attr-defined]
    return rt


# --------------------------------------------------------------------------- #
# THE acceptance test — all five ACs in one end-to-end scenario
# --------------------------------------------------------------------------- #

def test_merge_policy_ac1_through_ac5():
    """Single acceptance test pinning the full Merge Policy contract (issue #876).

    The test is structured in four stages that exercise all ACs in sequence.
    A failure in any stage means the corresponding AC is not satisfied.

    RED indicator: on an unmodified repo this test fails at the first
    ``RuntimeConfig(auto_merge=False)`` call with TypeError (AC1 not implemented).
    """

    # ------------------------------------------------------------------ #
    # AC1: RuntimeConfig.auto_merge defaults to False                      #
    # ------------------------------------------------------------------ #
    # Constructing RuntimeConfig with the bare minimum must not require
    # auto_merge (it defaults OFF), but the field must exist so the
    # dashboard toggle can read and write it.
    bare = RuntimeConfig(
        workspace_id="ws",
        repo_url="https://github.com/acme/r.git",
    )
    assert bare.auto_merge is False, (
        "AC1: RuntimeConfig.auto_merge must default to False (Merge Policy OFF)"
    )

    # ------------------------------------------------------------------ #
    # AC2: repo OFF, no auto-merge label → green run leaves PR unmerged   #
    # ------------------------------------------------------------------ #
    # IssueRef must grow a ``labels`` field (frozenset[str]) so the runtime
    # can inspect per-issue label overrides. Default is empty (no override).
    issue_off = IssueRef(
        repo="acme/widgets",
        number=7,
        title="Add widget",
        body=_VALID_BODY,
        url="https://gh/7",
        labels=frozenset(),          # no auto-merge label — AC4 override absent
    )
    store_off = FakeStore()
    connector_off = FakeConnector([issue_off])
    rt_off = _runtime(
        connector=connector_off,
        store=store_off,
        notifier=FakeNotifier(),
        config=_config(auto_merge=False),
        default_result=RunResult(
            status="green", cost_usd=0.5, branch="afk/7",
            pr_url="https://github.com/acme/widgets/pull/7",
        ),
    )
    rt_off.poll_and_dispatch("ws-1")

    assert rt_off._merge_calls == [], (           # type: ignore[attr-defined]
        "AC2: merge_pr must NOT be called when repo policy is OFF and no label"
    )
    # AC5: a merge_decision event must still be recorded, outcome=left-for-human
    off_merge_events = [e for e in store_off.events if e["kind"] == "merge_decision"]
    assert off_merge_events, (
        "AC5: a merge_decision event must be recorded even when merge is skipped"
    )
    assert off_merge_events[0]["outcome"] == "left-for-human", (
        "AC5: outcome must be 'left-for-human' when policy is OFF"
    )

    # ------------------------------------------------------------------ #
    # AC3a: repo ON → green run squash-merges the PR                      #
    # ------------------------------------------------------------------ #
    issue_on = IssueRef(
        repo="acme/widgets",
        number=8,
        title="Ship it",
        body=_VALID_BODY,
        url="https://gh/8",
    )
    store_on = FakeStore()
    connector_on = FakeConnector([issue_on])
    rt_on = _runtime(
        connector=connector_on,
        store=store_on,
        notifier=FakeNotifier(),
        config=_config(auto_merge=True),          # repo setting ON
        default_result=RunResult(
            status="green", cost_usd=0.5, branch="afk/8",
            pr_url="https://github.com/acme/widgets/pull/8",
        ),
    )
    rt_on.poll_and_dispatch("ws-1")

    assert len(rt_on._merge_calls) == 1, (        # type: ignore[attr-defined]
        "AC3: merge_pr MUST be called once when repo policy is ON and run is green"
    )
    # AC5: outcome=merged
    on_merge_events = [e for e in store_on.events if e["kind"] == "merge_decision"]
    assert on_merge_events, "AC5: merge_decision event must be recorded on merge"
    assert on_merge_events[0]["outcome"] == "merged", (
        "AC5: outcome must be 'merged' when merge succeeds"
    )

    # ------------------------------------------------------------------ #
    # AC3b: repo ON but run is RED → merge_pr must NOT be called          #
    # ------------------------------------------------------------------ #
    issue_red = IssueRef(
        repo="acme/widgets",
        number=9,
        title="Failing run",
        body=_VALID_BODY,
        url="https://gh/9",
    )
    connector_red = FakeConnector([issue_red])
    rt_red = _runtime(
        connector=connector_red,
        store=FakeStore(),
        notifier=FakeNotifier(),
        config=_config(auto_merge=True),          # ON — but run never reaches green
        default_result=RunResult(
            status="red", cost_usd=0.5, branch="afk/9",
            gate_reason="tests failed",
        ),
    )
    rt_red.poll_and_dispatch("ws-1")

    assert rt_red._merge_calls == [], (           # type: ignore[attr-defined]
        "AC3: merge_pr must NOT be called on a red run, even when policy is ON"
    )

    # ------------------------------------------------------------------ #
    # AC4: per-issue auto-merge label overrides repo OFF                   #
    # ------------------------------------------------------------------ #
    issue_label = IssueRef(
        repo="acme/widgets",
        number=10,
        title="Label override",
        body=_VALID_BODY,
        url="https://gh/10",
        labels=frozenset({"auto-merge"}),         # per-issue opt-in
    )
    store_label = FakeStore()
    connector_label = FakeConnector([issue_label])
    rt_label = _runtime(
        connector=connector_label,
        store=store_label,
        notifier=FakeNotifier(),
        config=_config(auto_merge=False),         # repo says OFF …
        default_result=RunResult(
            status="green", cost_usd=0.5, branch="afk/10",
            pr_url="https://github.com/acme/widgets/pull/10",
        ),
    )
    rt_label.poll_and_dispatch("ws-1")

    assert len(rt_label._merge_calls) == 1, (     # type: ignore[attr-defined]
        "AC4: auto-merge label must enable merge even when repo policy is OFF"
    )
    label_merge_events = [e for e in store_label.events if e["kind"] == "merge_decision"]
    assert label_merge_events and label_merge_events[0]["outcome"] == "merged", (
        "AC5: merge_decision outcome must be 'merged' when label overrides repo OFF"
    )


# --------------------------------------------------------------------------- #
# Merge-failure paths (AC5): a merge that raises or returns failure must be
# best-effort — recorded as a merge_decision event, never crashing the cycle.
# --------------------------------------------------------------------------- #


def test_merge_pr_exception_is_best_effort_and_recorded():
    """A merger that raises records outcome='merge-error' and does NOT crash dispatch."""
    issue = IssueRef(
        repo="acme/widgets",
        number=11,
        title="Merge blows up",
        body=_VALID_BODY,
        url="https://gh/11",
    )
    store = FakeStore()

    def exploding_merge(pr_url: str, subject: str):
        raise RuntimeError("github 403: branch protection")

    rt = _runtime(
        connector=FakeConnector([issue]),
        store=store,
        notifier=FakeNotifier(),
        config=_config(auto_merge=True),
        default_result=RunResult(
            status="green", cost_usd=0.5, branch="afk/11",
            pr_url="https://github.com/acme/widgets/pull/11",
        ),
        merge_pr=exploding_merge,
    )

    # Must not propagate — a merge failure cannot abandon the rest of the cycle.
    rt.poll_and_dispatch("ws-1")

    events = [e for e in store.events if e["kind"] == "merge_decision"]
    assert events and events[0]["outcome"] == "merge-error", (
        "AC5: a raising merger must record outcome='merge-error'"
    )
    assert "github 403" in (events[0].get("reason") or ""), (
        "AC5: the merge-error event must preserve the failure reason"
    )


def test_merge_pr_returns_failure_is_recorded():
    """A merger that returns (False, ...) records outcome='merge-failed', not 'merged'."""
    issue = IssueRef(
        repo="acme/widgets",
        number=12,
        title="Merge refused",
        body=_VALID_BODY,
        url="https://gh/12",
    )
    store = FakeStore()

    def refusing_merge(pr_url: str, subject: str) -> Tuple[bool, str]:
        return False, ""

    rt = _runtime(
        connector=FakeConnector([issue]),
        store=store,
        notifier=FakeNotifier(),
        config=_config(auto_merge=True),
        default_result=RunResult(
            status="green", cost_usd=0.5, branch="afk/12",
            pr_url="https://github.com/acme/widgets/pull/12",
        ),
        merge_pr=refusing_merge,
    )

    rt.poll_and_dispatch("ws-1")

    events = [e for e in store.events if e["kind"] == "merge_decision"]
    assert events and events[0]["outcome"] == "merge-failed", (
        "AC5: a (False, ...) merge result must record outcome='merge-failed', never 'merged'"
    )
