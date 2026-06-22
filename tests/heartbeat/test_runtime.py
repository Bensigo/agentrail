"""Live Heartbeat runtime — the dispatcher that turns merged modules into a loop.

Hermetic: every I/O edge (connector, store, sandbox runner, notifier, gate) is
injected as a fake, so one ``poll_and_dispatch`` cycle is fully reproducible with
no network, no Docker, no DB. These cover the MVP-loop ACs:

- AC1: one cycle does poll → enqueue(dedupe) → dispatch → sandbox run →
  transition + register_run → post_result + notify, and returns correct counts.
- AC2: empty / no-grabbable queue → idle, no sandbox run, no notify spam.
- AC3: gate disabled (a capability missing) → runtime refuses to dispatch.
- AC4: green vs red/error map to the right queue Event + TaskResult state.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, FrozenSet, List, Optional

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
from agentrail.heartbeat.runtime import HeartbeatRuntime, RuntimeConfig
from agentrail.sandbox.docker_runner import RunResult


# --------------------------------------------------------------------------- #
# Fakes for every injected edge
# --------------------------------------------------------------------------- #
class FakeConnector:
    """Stands in for GitHubOAuthClient: poll + post_result, capturing calls."""

    def __init__(self, issues: List[IssueRef]):
        self._issues = issues
        self.posted: List[tuple] = []

    def poll(self, workspace_id: str) -> List[IssueRef]:
        return list(self._issues)

    def post_result(self, issue_ref: IssueRef, result: OutcomeReport) -> None:
        self.posted.append((issue_ref, result))


class FakeStore:
    """Minimal in-memory stand-in for QueueStore's dispatcher surface.

    Models a queue of grabbable entries and records every transition /
    register_run so tests can assert the exact sequence.
    """

    def __init__(self):
        self.enqueued: List[dict] = []
        self.transitions: List[tuple] = []
        self.runs: List[dict] = []
        # FIFO of entries handed out by next_grabbable.
        self._grabbable: List[QueueEntry] = []
        self._known: set = set()

    def enqueue(self, *, workspace_id, source, external_id, title, body,
                blocked_by=frozenset()):
        self.enqueued.append(
            {
                "workspace_id": workspace_id,
                "source": source,
                "external_id": external_id,
                "title": title,
                "body": body,
            }
        )
        number = len(self._grabbable) + 1
        entry = QueueEntry(number=number)
        self._grabbable.append(entry)
        self._known.add(external_id)
        return entry

    def next_grabbable(self, workspace_id):
        if not self._grabbable:
            return None
        return self._grabbable.pop(0)

    def transition(self, entry, event):
        from agentrail.afk import queue_state

        nxt = queue_state.transition(entry, event)
        self.transitions.append((entry.number, event, nxt.state))
        return nxt

    def register_run(self, *, entry, run_id, phase, status, cost_usd=0.0,
                     model_used=None):
        self.runs.append(
            {
                "number": entry.number,
                "run_id": run_id,
                "phase": phase,
                "status": status,
                "cost_usd": cost_usd,
                "model_used": model_used,
            }
        )

    def list_queue(self, workspace_id):
        return []


class FakeNotifier:
    """Captures per-task and digest notifications."""

    def __init__(self):
        self.tasks: List[TaskResult] = []
        self.digests: List[List[TaskResult]] = []

    def task_done(self, result: TaskResult) -> None:
        self.tasks.append(result)

    def daily_digest(self, finished: List[TaskResult]) -> None:
        self.digests.append(list(finished))


def _config(**overrides) -> RuntimeConfig:
    base = dict(
        workspace_id="ws-1",
        repo_url="https://github.com/acme/widgets.git",
        ref="main",
        env={"AGENT_API_KEY": "k"},
        cheap_model="claude-haiku-4-5",
        strong_model="claude-opus-4-8",
    )
    base.update(overrides)
    return RuntimeConfig(**base)


_VALID_BODY = "## Acceptance criteria\n- [ ] AC1: it works\n"


def _runtime(
    *,
    connector,
    store,
    notifier,
    sandbox_results: Optional[Dict[str, RunResult]] = None,
    default_result: Optional[RunResult] = None,
    result_sequence: Optional[List[RunResult]] = None,
    capabilities: FrozenSet[Capability] = REQUIRED_CAPABILITIES,
    config: Optional[RuntimeConfig] = None,
):
    sandbox_results = sandbox_results or {}
    default_result = default_result or RunResult(status="green", cost_usd=0.5,
                                                 branch="afk/1")
    seq = list(result_sequence) if result_sequence is not None else None
    calls: List[dict] = []

    def sandbox_runner(*, repo_url, ref, issue_ref, workspace_id, env,
                       model=None, failure_handoff=None):
        calls.append(
            {
                "repo_url": repo_url,
                "ref": ref,
                "issue_ref": issue_ref,
                "workspace_id": workspace_id,
                "env": env,
                "model": model,
                "failure_handoff": failure_handoff,
            }
        )
        if seq is not None:
            return seq.pop(0)
        return sandbox_results.get(str(issue_ref), default_result)

    rt = HeartbeatRuntime(
        connector=connector,
        store=store,
        sandbox_runner=sandbox_runner,
        notifier=notifier,
        config=config or _config(),
        detect_capabilities=lambda: capabilities,
    )
    rt._sandbox_calls = calls  # type: ignore[attr-defined]  (test convenience)
    return rt


# --------------------------------------------------------------------------- #
# AC1 — a full cycle
# --------------------------------------------------------------------------- #
def test_ac1_full_cycle_polls_enqueues_dispatches_and_records():
    connector = FakeConnector(
        [
            IssueRef(repo="acme/widgets", number=7, title="Add widget",
                     body=_VALID_BODY, url="https://gh/7"),
        ]
    )
    store = FakeStore()
    notifier = FakeNotifier()
    rt = _runtime(connector=connector, store=store, notifier=notifier)

    report = rt.poll_and_dispatch("ws-1")

    # poll → enqueue (one issue)
    assert report.polled == 1
    assert report.enqueued == 1
    assert store.enqueued[0]["source"] == "github"
    assert store.enqueued[0]["external_id"] == "acme/widgets#7"

    # dispatch → sandbox run happened once
    assert report.dispatched == 1
    assert len(rt._sandbox_calls) == 1
    assert rt._sandbox_calls[0]["issue_ref"] == "7"
    assert rt._sandbox_calls[0]["repo_url"] == "https://github.com/acme/widgets.git"

    # transition sequence: START then GATE_GREEN
    events = [t[1] for t in store.transitions]
    assert events == [Event.START, Event.GATE_GREEN]

    # register_run twice: running, then green
    assert [r["status"] for r in store.runs] == ["running", "green"]
    assert store.runs[1]["cost_usd"] == 0.5

    # post_result + notify
    assert len(connector.posted) == 1
    assert connector.posted[0][1].state == "green"
    assert len(notifier.tasks) == 1
    assert notifier.tasks[0].state == "green"
    assert notifier.tasks[0].number == 7

    # counts
    assert report.green == 1
    assert report.red == 0


# --------------------------------------------------------------------------- #
# AC2 — idle on empty
# --------------------------------------------------------------------------- #
def test_ac2_empty_queue_is_idle_no_run_no_notify():
    connector = FakeConnector([])  # nothing to poll
    store = FakeStore()
    notifier = FakeNotifier()
    rt = _runtime(connector=connector, store=store, notifier=notifier)

    report = rt.poll_and_dispatch("ws-1")

    assert report.polled == 0
    assert report.enqueued == 0
    assert report.dispatched == 0
    assert rt._sandbox_calls == []
    assert notifier.tasks == []
    assert connector.posted == []


# --------------------------------------------------------------------------- #
# AC1 dedupe — same external_id is not enqueued twice
# --------------------------------------------------------------------------- #
def test_dedupe_skips_already_enqueued_external_id():
    issue = IssueRef(repo="acme/widgets", number=7, title="Add widget",
                     body=_VALID_BODY, url="https://gh/7")
    connector = FakeConnector([issue, issue])  # polled twice in one cycle
    store = FakeStore()
    notifier = FakeNotifier()
    rt = _runtime(connector=connector, store=store, notifier=notifier)

    report = rt.poll_and_dispatch("ws-1")

    assert report.polled == 2
    assert report.enqueued == 1  # deduped
    assert len(store.enqueued) == 1


# --------------------------------------------------------------------------- #
# AC3 — gate disabled refuses to dispatch
# --------------------------------------------------------------------------- #
def test_ac3_gate_disabled_refuses_to_dispatch():
    connector = FakeConnector(
        [IssueRef(repo="acme/widgets", number=7, body=_VALID_BODY)]
    )
    store = FakeStore()
    notifier = FakeNotifier()
    missing_budget = frozenset(
        {Capability.OBJECTIVE_GATE, Capability.SECURITY_GUARDRAIL}
    )
    rt = _runtime(connector=connector, store=store, notifier=notifier,
                  capabilities=missing_budget)

    report = rt.poll_and_dispatch("ws-1")

    assert report.enabled is False
    assert report.polled == 0
    assert report.dispatched == 0
    assert store.enqueued == []
    assert rt._sandbox_calls == []
    assert notifier.tasks == []


# --------------------------------------------------------------------------- #
# AC4 — status → Event + TaskResult state mapping
# --------------------------------------------------------------------------- #
def test_ac4_green_maps_to_gate_green_and_green_state():
    connector = FakeConnector(
        [IssueRef(repo="acme/widgets", number=7, body=_VALID_BODY)]
    )
    store = FakeStore()
    notifier = FakeNotifier()
    rt = _runtime(connector=connector, store=store, notifier=notifier,
                  default_result=RunResult(status="green", cost_usd=0.2,
                                           branch="afk/7"))

    rt.poll_and_dispatch("ws-1")

    dispatch_events = [t[1] for t in store.transitions if t[1] != Event.START]
    assert dispatch_events == [Event.GATE_GREEN]
    assert notifier.tasks[0].state == "green"
    assert connector.posted[0][1].state == "green"


@pytest.mark.parametrize("status", ["red", "error"])
def test_ac4_persistently_failing_status_ends_escalated_to_human(status):
    """A status the loop can never bring green (red/error on every attempt) drives
    a GATE_RED per attempt and ends in the ESCALATED_TO_HUMAN terminal (AC4/AC3)."""
    connector = FakeConnector(
        [IssueRef(repo="acme/widgets", number=7, body=_VALID_BODY)]
    )
    store = FakeStore()
    notifier = FakeNotifier()
    result = RunResult(status=status, cost_usd=0.2, branch="afk/7",
                       gate_reason="boom")
    rt = _runtime(connector=connector, store=store, notifier=notifier,
                  default_result=result)

    rt.poll_and_dispatch("ws-1")

    dispatch_events = [t[1] for t in store.transitions if t[1] != Event.START]
    # every attempt is a GATE_RED, and the loop is bounded (attempt_limit=2)
    assert dispatch_events and all(e == Event.GATE_RED for e in dispatch_events)
    assert notifier.tasks[0].state == "escalated-to-human"
    assert connector.posted[0][1].state == "escalated-to-human"


def test_ac4_red_then_green_is_reported_green():
    """A red cheap attempt that the strong attempt turns green ends green."""
    connector = FakeConnector(
        [IssueRef(repo="acme/widgets", number=9, body=_VALID_BODY)]
    )
    store = FakeStore()
    notifier = FakeNotifier()
    rt = _runtime(
        connector=connector, store=store, notifier=notifier,
        result_sequence=[
            RunResult(status="red", cost_usd=0.1, branch="afk/9", gate_reason="nope"),
            RunResult(status="green", cost_usd=0.3, branch="afk/9-strong"),
        ],
    )
    report = rt.poll_and_dispatch("ws-1")
    assert report.green == 1
    assert report.red == 0
    assert notifier.tasks[0].state == "green"


# --------------------------------------------------------------------------- #
# Escalation loop (cheap→strong with compacted failure-handoff) — M036 live loop
# --------------------------------------------------------------------------- #
def test_red_first_attempt_escalates_to_strong_model_with_handoff():
    """AC1+AC2: a red cheap attempt with budget left re-runs on the STRONG model
    carrying a non-empty compacted handoff (goal + prior diff/branch + gate error)."""
    connector = FakeConnector(
        [IssueRef(repo="acme/widgets", number=7, title="Add widget",
                  body=_VALID_BODY, url="https://gh/7")]
    )
    store = FakeStore()
    notifier = FakeNotifier()
    rt = _runtime(
        connector=connector, store=store, notifier=notifier,
        result_sequence=[
            RunResult(status="red", cost_usd=0.1, branch="afk/7-cheap",
                      gate_reason="AC2 unverified"),
            RunResult(status="green", cost_usd=0.4, branch="afk/7-strong"),
        ],
    )

    report = rt.poll_and_dispatch("ws-1")

    # two sandbox attempts for the one issue
    calls = rt._sandbox_calls
    assert len(calls) == 2
    # 1st attempt: cheap model, NO handoff
    assert calls[0]["model"] == "claude-haiku-4-5"
    assert not calls[0]["failure_handoff"]
    # 2nd attempt: STRONG model, non-empty handoff
    assert calls[1]["model"] == "claude-opus-4-8"
    handoff = calls[1]["failure_handoff"]
    assert handoff  # AC1: non-empty
    # AC2: handoff carries goal + prior attempt diff/branch + gate error
    assert "Add widget" in handoff or "widget" in handoff.lower()
    assert "afk/7-cheap" in handoff
    assert "AC2 unverified" in handoff

    # ended green on the strong attempt
    assert report.green == 1
    assert report.red == 0
    assert notifier.tasks[0].state == "green"


def test_handoff_matches_compaction_build_output():
    """AC2: the handoff text is exactly compaction.build(goal, diff, gate_error)."""
    from agentrail.run import compaction

    connector = FakeConnector(
        [IssueRef(repo="acme/widgets", number=7, title="Ship the thing",
                  body=_VALID_BODY)]
    )
    store = FakeStore()
    notifier = FakeNotifier()
    rt = _runtime(
        connector=connector, store=store, notifier=notifier,
        result_sequence=[
            RunResult(status="red", cost_usd=0.1, branch="afk/7-cheap",
                      gate_reason="gate said no"),
            RunResult(status="green", cost_usd=0.4, branch="afk/7-strong"),
        ],
    )
    rt.poll_and_dispatch("ws-1")

    handoff = rt._sandbox_calls[1]["failure_handoff"]
    expected = compaction.build(
        goal="Ship the thing",
        attempt_diff="afk/7-cheap",
        gate_error="gate said no",
    ).text
    assert handoff == expected


def test_green_on_first_attempt_does_not_escalate():
    """AC3: green on the first (cheap) attempt → GATE_GREEN, no second run."""
    connector = FakeConnector(
        [IssueRef(repo="acme/widgets", number=7, body=_VALID_BODY)]
    )
    store = FakeStore()
    notifier = FakeNotifier()
    rt = _runtime(
        connector=connector, store=store, notifier=notifier,
        default_result=RunResult(status="green", cost_usd=0.3, branch="afk/7"),
    )
    report = rt.poll_and_dispatch("ws-1")

    assert len(rt._sandbox_calls) == 1
    assert rt._sandbox_calls[0]["model"] == "claude-haiku-4-5"
    events = [t[1] for t in store.transitions]
    assert Event.GATE_GREEN in events
    assert report.green == 1


def test_red_then_red_exhausts_attempts_and_stops_to_human():
    """AC3: red on cheap then red on strong (attempt_limit=2) → ESCALATED_TO_HUMAN
    terminal; the loop terminates (exactly two attempts, never more)."""
    connector = FakeConnector(
        [IssueRef(repo="acme/widgets", number=7, body=_VALID_BODY)]
    )
    store = FakeStore()
    notifier = FakeNotifier()
    rt = _runtime(
        connector=connector, store=store, notifier=notifier,
        result_sequence=[
            RunResult(status="red", cost_usd=0.1, branch="afk/7-cheap",
                      gate_reason="still red"),
            RunResult(status="red", cost_usd=0.2, branch="afk/7-strong",
                      gate_reason="strong red too"),
        ],
    )
    report = rt.poll_and_dispatch("ws-1")

    # bounded: exactly two attempts (cheap then strong), never a third
    assert len(rt._sandbox_calls) == 2
    assert report.red == 1
    assert report.green == 0
    assert notifier.tasks[0].state == "escalated-to-human"
    assert connector.posted[0][1].state == "escalated-to-human"


def test_budget_ceiling_exhaustion_stops_before_escalation():
    """AC3: a red attempt that already spent past the per-issue ceiling stops to
    human without a second run (budget_leash STOP_TO_HUMAN dominates)."""
    connector = FakeConnector(
        [IssueRef(repo="acme/widgets", number=7, body=_VALID_BODY)]
    )
    store = FakeStore()
    notifier = FakeNotifier()
    rt = _runtime(
        connector=connector, store=store, notifier=notifier,
        config=_config(ceiling=0.05, attempt_limit=5),  # ceiling below the cheap cost
        result_sequence=[
            RunResult(status="red", cost_usd=0.10, branch="afk/7-cheap",
                      gate_reason="red and over budget"),
        ],
    )
    report = rt.poll_and_dispatch("ws-1")

    assert len(rt._sandbox_calls) == 1  # no escalation: budget exhausted
    assert report.red == 1
    assert notifier.tasks[0].state == "escalated-to-human"


def test_register_run_records_each_attempt():
    """AC3 bookkeeping: register_run fires per attempt with phase/status/cost."""
    connector = FakeConnector(
        [IssueRef(repo="acme/widgets", number=7, body=_VALID_BODY)]
    )
    store = FakeStore()
    notifier = FakeNotifier()
    rt = _runtime(
        connector=connector, store=store, notifier=notifier,
        result_sequence=[
            RunResult(status="red", cost_usd=0.1, branch="afk/7-cheap",
                      gate_reason="nope"),
            RunResult(status="green", cost_usd=0.4, branch="afk/7-strong"),
        ],
    )
    rt.poll_and_dispatch("ws-1")

    statuses = [r["status"] for r in store.runs]
    # running (start) + red (attempt 1) + running? + green (attempt 2) — at least
    # one terminal status per attempt and a green at the end.
    assert "red" in statuses
    assert statuses[-1] == "green"
    costs = [r["cost_usd"] for r in store.runs if r["status"] in ("red", "green")]
    assert 0.1 in costs and 0.4 in costs


# --------------------------------------------------------------------------- #
# daily_digest
# --------------------------------------------------------------------------- #
def test_daily_digest_forwards_finished_terminals_to_notifier():
    store = FakeStore()
    notifier = FakeNotifier()
    rt = _runtime(connector=FakeConnector([]), store=store, notifier=notifier)

    # list_queue returns terminal entries for the day.
    terminals = [
        QueueEntry(number=1, state=Terminal.GREEN),
        QueueEntry(number=2, state=Terminal.ESCALATED_TO_HUMAN),
        QueueEntry(number=3, state=QueueState.QUEUED),  # not finished → excluded
    ]
    store.list_queue = lambda ws: terminals  # type: ignore[assignment]

    rt.daily_digest("ws-1")

    assert len(notifier.digests) == 1
    finished = notifier.digests[0]
    assert sorted(t.number for t in finished) == [1, 2]
    states = {t.number: t.state for t in finished}
    assert states[1] == "green"
    assert states[2] == "escalated-to-human"


# --------------------------------------------------------------------------- #
# AC4 — dispatch_pending drains the queue WITHOUT polling (webhook path)
# --------------------------------------------------------------------------- #
def test_dispatch_pending_drains_queue_without_polling():
    # The connector would raise if poll() were called: dispatch_pending must not.
    class BoomConnector(FakeConnector):
        def poll(self, workspace_id):  # pragma: no cover - asserted via no-call
            raise AssertionError("dispatch_pending must not poll")

    store = FakeStore()
    notifier = FakeNotifier()
    rt = _runtime(connector=BoomConnector([]), store=store, notifier=notifier)

    # Seed two grabbable entries directly (as if a prior enqueue had run).
    store._grabbable = [QueueEntry(number=1), QueueEntry(number=2)]

    report = rt.dispatch_pending("ws-1")

    assert report.polled == 0
    assert report.enqueued == 0
    assert report.dispatched == 2
    # ran the escalation dispatch (sandbox) for each entry.
    assert len(rt._sandbox_calls) == 2


def test_dispatch_pending_uses_refs_by_number_for_postback():
    store = FakeStore()
    connector = FakeConnector([])
    notifier = FakeNotifier()
    rt = _runtime(connector=connector, store=store, notifier=notifier)

    store._grabbable = [QueueEntry(number=5)]
    ref = IssueRef(repo="acme/widgets", number=5, title="Hi", url="https://gh/5")

    rt.dispatch_pending("ws-1", {5: ref})

    # post_result addressed the exact ref the webhook handed in (not a by-number stub).
    assert connector.posted
    posted_ref, _outcome = connector.posted[0]
    assert posted_ref.repo == "acme/widgets" and posted_ref.number == 5


def test_dispatch_pending_respects_disabled_gate():
    store = FakeStore()
    notifier = FakeNotifier()
    rt = _runtime(
        connector=FakeConnector([]),
        store=store,
        notifier=notifier,
        capabilities=frozenset(),  # gate OFF
    )
    store._grabbable = [QueueEntry(number=1)]

    report = rt.dispatch_pending("ws-1")

    assert report.enabled is False
    assert report.dispatched == 0
    assert len(rt._sandbox_calls) == 0


def test_dispatch_pending_idles_on_empty_queue():
    store = FakeStore()
    notifier = FakeNotifier()
    rt = _runtime(connector=FakeConnector([]), store=store, notifier=notifier)

    report = rt.dispatch_pending("ws-1")

    assert report.dispatched == 0
    assert notifier.tasks == []


# --------------------------------------------------------------------------- #
# Issue #879 — Acceptance test: escalation genuinely changes models
#
# RED before implementation; GREEN after.
#
# Encodes AC1, AC2, and AC4:
#   AC1: RuntimeConfig() with no explicit cheap/strong model must default to
#        cheap=claude-sonnet-4-6 and strong=claude-opus-4-8.
#   AC2: A gate-red cheap attempt causes the NEXT attempt to run on the strong
#        model — asserted on the model actually passed to the sandbox, NOT just
#        the computed tier.
#   AC4: Each attempt records the model it ran on (model_used) in the run
#        record, visible for inspection.
# --------------------------------------------------------------------------- #
def test_ac879_escalation_changes_models_with_default_mapping_and_model_used():
    """Acceptance test for issue #879.

    When RuntimeConfig is constructed with no explicit cheap_model / strong_model
    (i.e. the out-of-the-box defaults), a gate-red cheap attempt must escalate
    to a genuinely different, stronger model.  Each attempt must also record the
    model it ran on in the run store so escalation is observable.

    This test MUST FAIL before the issue is implemented:
    - cheap_model and strong_model currently default to None, so both attempts
      run the same (unset) model and escalation changes nothing.
    - register_run does not yet accept or forward model_used.
    """
    # AC1 — assert defaults BEFORE constructing the runtime, so the failure is
    # immediately obvious and not buried in a sandbox-call assertion.
    default_config = RuntimeConfig(
        workspace_id="ws-879",
        repo_url="https://github.com/acme/widgets.git",
    )
    assert default_config.cheap_model == "claude-sonnet-4-6", (
        "AC1 FAIL: cheap_model default must be 'claude-sonnet-4-6', "
        f"got {default_config.cheap_model!r}"
    )
    assert default_config.strong_model == "claude-opus-4-8", (
        "AC1 FAIL: strong_model default must be 'claude-opus-4-8', "
        f"got {default_config.strong_model!r}"
    )

    # AC2 — run with defaults; cheap fails, strong succeeds.
    connector = FakeConnector(
        [IssueRef(repo="acme/widgets", number=879, title="Make escalation real",
                  body=_VALID_BODY, url="https://gh/879")]
    )
    store = FakeStore()
    notifier = FakeNotifier()
    rt = _runtime(
        connector=connector,
        store=store,
        notifier=notifier,
        config=default_config,
        result_sequence=[
            RunResult(status="red", cost_usd=0.1, branch="afk/879-cheap",
                      gate_reason="tests did not pass"),
            RunResult(status="green", cost_usd=0.4, branch="afk/879-strong"),
        ],
    )

    report = rt.poll_and_dispatch("ws-879")

    calls = rt._sandbox_calls
    assert len(calls) == 2, f"expected 2 sandbox calls (cheap + strong), got {len(calls)}"

    # AC2 — first attempt ran on cheap (Sonnet 4.6), not None.
    assert calls[0]["model"] == "claude-sonnet-4-6", (
        "AC2 FAIL: first (cheap) attempt must use claude-sonnet-4-6, "
        f"got {calls[0]['model']!r}"
    )
    # AC2 — second attempt ran on strong (Opus 4.8), not the same model.
    assert calls[1]["model"] == "claude-opus-4-8", (
        "AC2 FAIL: second (strong) attempt must use claude-opus-4-8, "
        f"got {calls[1]['model']!r}"
    )

    # AC4 — each attempt's run record carries model_used.
    attempt_runs = [r for r in store.runs if r.get("status") in ("red", "green")]
    assert len(attempt_runs) >= 2, (
        f"expected at least 2 attempt run records, got {attempt_runs}"
    )
    assert attempt_runs[0].get("model_used") == "claude-sonnet-4-6", (
        "AC4 FAIL: first attempt run record must carry "
        f"model_used='claude-sonnet-4-6', got {attempt_runs[0].get('model_used')!r}"
    )
    assert attempt_runs[1].get("model_used") == "claude-opus-4-8", (
        "AC4 FAIL: second attempt run record must carry "
        f"model_used='claude-opus-4-8', got {attempt_runs[1].get('model_used')!r}"
    )

    # Sanity: escalation ended green.
    assert report.green == 1
