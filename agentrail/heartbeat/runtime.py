"""Live Heartbeat runtime — the dispatcher that runs the loop end to end.

This is THE integration that turns the merged modules into a live autonomous
loop (CONTEXT.md's **Heartbeat**, ADR 0010):

    poll GitHub → enqueue (deduped) → dispatch grabbable → run in a Docker
    sandbox → record the outcome (transition + register_run) → post back +
    notify → idle when the queue is empty.

It owns *composition*, not new policy. Every decision already lives in a merged
deep module and is reused, never re-implemented:

- the **prerequisite gate** (``agentrail/heartbeat/gate.py``) decides whether the
  Heartbeat may run at all;
- the **Issue Queue** persistence + state machine (``agentrail/afk/queue_store``
  + ``queue_state``) owns enqueue/grabbability/transition;
- the **sandbox** (``agentrail/sandbox/docker_runner``) owns the actual run;
- the **connectors** (``connectors/github`` + ``connectors/discord``) own the
  back-channel comment and the channel notification.

Every one of those edges is INJECTED, so the runtime is fully unit-testable with
fakes — no network, no Docker, no DB. The CLI (``agentrail heartbeat run``) is the
only place the real adapters are constructed.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Callable, Dict, FrozenSet, List, Protocol

from agentrail.afk.input_contract import Rejected
from agentrail.afk.queue_state import Event, QueueEntry, Terminal, is_terminal
from agentrail.connectors.base import IssueRef, OutcomeReport
from agentrail.connectors.discord import TaskResult
from agentrail.heartbeat.gate import Capability, detect_capabilities, heartbeat_enabled
from agentrail.sandbox.docker_runner import RunResult


# --------------------------------------------------------------------------- #
# status → queue Event mapping (AC4). A trustworthy green gate passes; a red
# gate or a sandbox-level error both consume a budget unit via GATE_RED (the
# pure state machine then either escalates a tier or hard-stops to human).
# --------------------------------------------------------------------------- #
_STATUS_TO_EVENT: Dict[str, Event] = {
    "green": Event.GATE_GREEN,
    "red": Event.GATE_RED,
    "error": Event.GATE_RED,
}

# status → the Run-Outcome wording the back-channel + Discord speak. ``green``
# is the GREEN terminal; ``red``/``error`` surface as escalated-to-human (a run
# we could not bring green is a human's problem now).
_STATUS_TO_STATE: Dict[str, str] = {
    "green": Terminal.GREEN.value,
    "red": Terminal.ESCALATED_TO_HUMAN.value,
    "error": Terminal.ESCALATED_TO_HUMAN.value,
}


# --------------------------------------------------------------------------- #
# Injected edges (Protocols so any duck-typed fake/real adapter satisfies them)
# --------------------------------------------------------------------------- #
class Connector(Protocol):
    """The GitHub side: list trigger-labeled issues + post a run outcome back."""

    def poll(self, workspace_id: str) -> List[IssueRef]:  # pragma: no cover
        ...

    def post_result(self, issue_ref: IssueRef, result: OutcomeReport) -> None:  # pragma: no cover
        ...


class Store(Protocol):
    """The Issue Queue persistence surface the dispatcher consumes."""

    def enqueue(self, *, workspace_id, source, external_id, title, body,
                blocked_by=frozenset()):  # pragma: no cover
        ...

    def next_grabbable(self, workspace_id):  # pragma: no cover
        ...

    def transition(self, entry, event):  # pragma: no cover
        ...

    def register_run(self, *, entry, run_id, phase, status, cost_usd=0.0):  # pragma: no cover
        ...

    def list_queue(self, workspace_id):  # pragma: no cover
        ...


# The sandbox seam: run one issue and return a RunResult. Keyword-only to mirror
# ``run_issue_in_sandbox`` so the CLI can pass it (partially bound) directly.
SandboxRunner = Callable[..., RunResult]


class Notifier(Protocol):
    """The channel-notification side (Discord): per-task + daily digest."""

    def task_done(self, result: TaskResult) -> None:  # pragma: no cover
        ...

    def daily_digest(self, finished: List[TaskResult]) -> None:  # pragma: no cover
        ...


# --------------------------------------------------------------------------- #
# Config — injectable now (args/env), Postgres-sourced later (3b)
# --------------------------------------------------------------------------- #
@dataclass
class RuntimeConfig:
    """The per-workspace knobs the runtime needs to dispatch a run.

    Injected so the same runtime works against args/env today and a
    dashboard-managed config table later (3b). ``env`` is the secret-bearing
    environment (agent API key, git token) forwarded into the sandbox by name.
    """

    workspace_id: str
    repo_url: str
    ref: str = "main"
    env: Dict[str, str] = field(default_factory=dict)


# --------------------------------------------------------------------------- #
# CycleReport — what one poll_and_dispatch did
# --------------------------------------------------------------------------- #
@dataclass
class CycleReport:
    """The outcome of one ``poll_and_dispatch`` cycle (the CLI logs these)."""

    enabled: bool = True
    polled: int = 0
    enqueued: int = 0
    dispatched: int = 0
    green: int = 0
    red: int = 0

    @classmethod
    def disabled(cls) -> "CycleReport":
        """A cycle that did nothing because the prerequisite gate is OFF (AC3)."""
        return cls(enabled=False)


# --------------------------------------------------------------------------- #
# The runtime
# --------------------------------------------------------------------------- #
class HeartbeatRuntime:
    """Composes the injected adapters into one live poll→dispatch loop.

    Stateless across cycles beyond what the injected ``store`` persists: each
    ``poll_and_dispatch`` is a self-contained sweep. Construct it with fakes in
    tests; the CLI constructs it with the real PostgresExecutor-backed store,
    the OAuth GitHub client, the Docker sandbox runner, and the Discord notifier.
    """

    def __init__(
        self,
        *,
        connector: Connector,
        store: Store,
        sandbox_runner: SandboxRunner,
        notifier: Notifier,
        config: RuntimeConfig,
        detect_capabilities: Callable[[], FrozenSet[Capability]] = detect_capabilities,
    ) -> None:
        self._connector = connector
        self._store = store
        self._sandbox = sandbox_runner
        self._notifier = notifier
        self._config = config
        self._detect = detect_capabilities

    # -- the loop ----------------------------------------------------------- #
    def poll_and_dispatch(self, workspace_id: str) -> CycleReport:
        """Run one sweep: poll → enqueue (dedupe) → dispatch → record → notify.

        (a) Refuse and return early if the prerequisite gate is OFF (AC3) — no
            poll, no enqueue, no run, no notify.
        (b) Poll the connector and enqueue each issue, deduping on the stable
            ``external_id`` (``repo#number``) so the same issue is not enqueued
            twice within a cycle (AC1 dedupe).
        (c) Drain the grabbable queue: for each entry, START it, register the
            running run, execute it in the sandbox, map the status to a queue
            Event, transition + re-register with the cost, post the outcome back
            and notify the channel.
        (d) Stop when ``next_grabbable`` returns ``None`` — idle on empty (AC2).
        """
        if not heartbeat_enabled(self._detect()):
            return CycleReport.disabled()

        report = CycleReport()

        # (b) poll + enqueue with dedupe on external_id. We key the polled
        # IssueRef by the *minted entry's number* so the dispatch loop can
        # recover the originating ref — ``QueueEntry.number`` is a stable
        # function of the issue identity (``queue_store._entry_number``), so the
        # entry handed back by ``next_grabbable`` carries the same number.
        refs_by_number: Dict[int, IssueRef] = {}
        seen: set = set()
        for ref in self._connector.poll(workspace_id):
            report.polled += 1
            external_id = self._external_id(ref)
            if external_id in seen:
                continue  # dedupe within this cycle
            seen.add(external_id)
            admitted = self._store.enqueue(
                workspace_id=workspace_id,
                source="github",
                external_id=external_id,
                title=ref.title,
                body=ref.body,
            )
            if isinstance(admitted, Rejected):
                # The input-contract gate kept it out (no machine-checkable AC):
                # not enqueued, nothing to dispatch.
                continue
            report.enqueued += 1
            refs_by_number[admitted.number] = ref

        # (c)/(d) dispatch loop until the queue has no grabbable work.
        entry = self._store.next_grabbable(workspace_id)
        while entry is not None:
            ref = self._ref_for(entry, refs_by_number)
            self._dispatch_one(workspace_id, entry, ref, report)
            entry = self._store.next_grabbable(workspace_id)

        return report

    def _dispatch_one(
        self,
        workspace_id: str,
        entry: QueueEntry,
        ref: IssueRef,
        report: CycleReport,
    ) -> None:
        """Run a single grabbable entry through the sandbox and record it."""
        run_id = str(uuid.uuid4())

        # START → RUNNING, register the in-flight run.
        running = self._store.transition(entry, Event.START)
        self._store.register_run(
            entry=running, run_id=run_id, phase="execute", status="running"
        )

        # Execute in the sandbox. ``issue_ref`` is the bare issue number the
        # runner image passes to ``agentrail run issue <n>``.
        result = self._sandbox(
            repo_url=self._config.repo_url,
            ref=self._config.ref,
            issue_ref=str(ref.number),
            workspace_id=workspace_id,
            env=dict(self._config.env),
        )

        # status → queue Event, transition + re-register with the run cost.
        event = _STATUS_TO_EVENT.get(result.status, Event.GATE_RED)
        self._store.transition(running, event)
        self._store.register_run(
            entry=running,
            run_id=run_id,
            phase="execute",
            status=result.status,
            cost_usd=result.cost_usd,
        )

        # Post back to the source issue + notify the channel.
        outcome = self._outcome_report(ref, result)
        self._connector.post_result(ref, outcome)
        self._notifier.task_done(self._task_result(ref, result))

        report.dispatched += 1
        if result.status == "green":
            report.green += 1
        else:
            report.red += 1

    # -- daily digest ------------------------------------------------------- #
    def daily_digest(self, workspace_id: str) -> None:
        """Gather the day's finished (terminal) entries and post a digest.

        Reads the queue from the store and keeps only entries that reached a
        **Run Outcome** terminal, mapping each to a :class:`TaskResult`. The
        notifier (Discord) renders/posts it — or stays silent on an empty day
        (no spam), which the notifier's digest path already guarantees.
        """
        finished: List[TaskResult] = []
        for entry in self._store.list_queue(workspace_id):
            if is_terminal(entry.state):
                finished.append(
                    TaskResult(
                        number=entry.number,
                        title="",
                        state=entry.state.value,
                    )
                )
        self._notifier.daily_digest(finished)

    # -- mapping helpers (pure) -------------------------------------------- #
    @staticmethod
    def _external_id(ref: IssueRef) -> str:
        """The stable per-issue identity used for enqueue dedupe: ``repo#number``."""
        return f"{ref.repo}#{ref.number}"

    def _ref_for(
        self, entry: QueueEntry, refs_by_number: Dict[int, IssueRef]
    ) -> IssueRef:
        """Recover the IssueRef a grabbable entry came from, by entry number.

        The enqueue step keyed each polled ref by the minted entry's stable
        ``number`` (a deterministic function of the issue identity). A grabbable
        entry returned by ``next_grabbable`` carries the same number, so the
        lookup is exact. Falls back to a minimal ref (addressed by number) for a
        resumed entry that was not polled this cycle, so it still posts/notifies.
        """
        ref = refs_by_number.get(entry.number)
        if ref is not None:
            return ref
        # Resumed/parked entry with no ref polled this cycle: address by number.
        return IssueRef(repo="", number=entry.number)

    @staticmethod
    def _state_for(result: RunResult) -> str:
        return _STATUS_TO_STATE.get(result.status, Terminal.ESCALATED_TO_HUMAN.value)

    def _outcome_report(self, ref: IssueRef, result: RunResult) -> OutcomeReport:
        """Map a RunResult to the GitHub back-channel payload (OutcomeReport)."""
        state = self._state_for(result)
        if result.status == "green":
            summary = "Objective Gate + verification passed — PR ready."
        else:
            summary = result.gate_reason or f"Run {result.status}; escalated to a human."
        url = result.branch or ref.url or None
        return OutcomeReport(state=state, summary=summary, url=url)

    def _task_result(self, ref: IssueRef, result: RunResult) -> TaskResult:
        """Map a RunResult to the Discord per-task update (TaskResult)."""
        return TaskResult(
            number=ref.number,
            title=ref.title,
            state=self._state_for(result),
            cost_usd=result.cost_usd,
            url=result.branch or ref.url or "",
        )
