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

import logging
import uuid
from dataclasses import dataclass, field
from typing import Callable, Dict, FrozenSet, List, Optional, Protocol

_log = logging.getLogger(__name__)

from agentrail.afk.input_contract import Rejected
from agentrail.afk.queue_state import (
    Event,
    QueueEntry,
    Terminal,
    Tier,
    is_terminal,
)
from agentrail.connectors.base import IssueRef, OutcomeReport
from agentrail.connectors.discord import TaskResult
from agentrail.heartbeat.gate import Capability, detect_capabilities, heartbeat_enabled
from agentrail.run import budget_leash, compaction
from agentrail.run.budget_leash import Decision
from agentrail.run.routing import next_tier
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

    def register_run(self, *, entry, run_id, phase, status, cost_usd=0.0, model_used=None):  # pragma: no cover
        ...

    def record_event(self, *, kind: str, **payload) -> None:  # pragma: no cover
        ...

    def list_queue(self, workspace_id):  # pragma: no cover
        ...


# The sandbox seam: run one issue and return a RunResult. Keyword-only to mirror
# ``run_issue_in_sandbox`` so the CLI can pass it (partially bound) directly.
SandboxRunner = Callable[..., RunResult]

# AC2/AC3/AC4 (issue #876): injectable merge seam — ``(pr_url, subject) → (ok, mode)``
# so the runtime stays fully hermetic (no real GitHub calls in tests). The real
# adapter is ``agentrail.connectors.github.merge_pr_squash``; the CLI wires it in.
MergePr = Callable[..., "tuple[bool, str]"]


class Notifier(Protocol):
    """The channel-notification side (Discord): per-task + daily digest."""

    def task_done(self, result: TaskResult) -> None:  # pragma: no cover
        ...

    def daily_digest(self, finished: List[TaskResult]) -> None:  # pragma: no cover
        ...


# --------------------------------------------------------------------------- #
# Config — injectable now (args/env), Postgres-sourced later (3b)
# --------------------------------------------------------------------------- #

# Default per-issue dollar ceiling (Budget Leash). A real eval burned $4.65 on a
# single hard task that solved nothing because the ceiling defaulted to uncapped
# (``0.0``); this default makes the leash actually HALT a runaway run by default.
# Override per-workspace with ``AGENTRAIL_PER_ISSUE_CEILING_USD`` (``0`` =
# uncapped). The $ figure it bounds is the run's real-dollar ``RunResult.cost_usd``
# computed via ``agentrail.run.pricing.cost_usd`` (single source of model rates).
DEFAULT_PER_ISSUE_CEILING_USD: float = 3.00


@dataclass
class RuntimeConfig:
    """The per-workspace knobs the runtime needs to dispatch a run.

    Injected so the same runtime works against args/env today and a
    dashboard-managed config table later (3b). ``env`` is the secret-bearing
    environment (agent API key, git token) forwarded into the sandbox by name.

    Escalation knobs (cheap→strong loop, ADR 0011 / M036):

    - ``cheap_model`` / ``strong_model`` — the two model names the loop runs the
      sandbox on. The first attempt runs on ``cheap_model``; an escalation re-runs
      on ``strong_model``. ``None`` means "let the image pick its default model".
    - ``ceiling`` — the per-issue dollar cost ceiling (Budget Leash). Defaults to
      :data:`DEFAULT_PER_ISSUE_CEILING_USD` ($3.00) so an unattended run can never
      silently burn unbounded dollars on one issue (a real eval spent $4.65 on a
      single unsolved hard task because the ceiling defaulted to uncapped). Set
      ``0`` to opt back into *uncapped*, mirroring the run budget guardrail; the
      attempt limit still bounds the loop either way. The spend compared against
      the ceiling is the run's real-dollar ``RunResult.cost_usd``, which the
      pipeline computes via ``agentrail.run.pricing.cost_usd`` (the single source
      of per-model rates) — so the ceiling is enforced in true dollars.
    - ``attempt_limit`` — the maximum number of attempts (initial + escalations)
      before a hard stop to human. Defaults to ``2`` (cheap then strong). Must be
      >= 1.

    A two-tier model ladder (``CHEAP`` → ``STRONG``) maps to these two names; see
    :meth:`HeartbeatRuntime._model_for_tier`.
    """

    workspace_id: str
    repo_url: str
    ref: str = "main"
    env: Dict[str, str] = field(default_factory=dict)
    cheap_model: Optional[str] = "claude-sonnet-4-6"
    strong_model: Optional[str] = "claude-opus-4-8"
    ceiling: float = DEFAULT_PER_ISSUE_CEILING_USD
    attempt_limit: int = 2
    # AC1 (issue #876): Merge Policy — defaults OFF. When True, a green run
    # squash-merges the PR. The per-issue ``auto-merge`` label overrides this
    # for a single ticket (AC4). Persisted in the DB and editable from the
    # dashboard; injected here so the runtime stays hermetically testable.
    auto_merge: bool = False


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
        merge_pr: Optional[MergePr] = None,
    ) -> None:
        self._connector = connector
        self._store = store
        self._sandbox = sandbox_runner
        self._notifier = notifier
        self._config = config
        self._detect = detect_capabilities
        self._merge_pr = merge_pr

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

        # (c)/(d) drain the grabbable queue (no poll — that already happened).
        self._drain(workspace_id, refs_by_number, report)
        return report

    def dispatch_pending(
        self,
        workspace_id: str,
        refs_by_number: Optional[Dict[int, IssueRef]] = None,
    ) -> CycleReport:
        """Drain the grabbable queue through the escalation dispatch — NO poll.

        The webhook path (``agentrail/heartbeat/webhook.py``) already has the
        issue *in hand* from the delivered event and has enqueued it; the event
        IS the issue, so there is nothing to poll. This drains exactly the same
        grabbable queue through exactly the same ``_dispatch_one`` escalation loop
        that ``poll_and_dispatch`` uses — only the poll+enqueue step is skipped.

        Respects the prerequisite gate (AC3) identically: a disabled gate returns
        a disabled :class:`CycleReport` and dispatches nothing. ``refs_by_number``
        lets the caller pass the originating :class:`IssueRef`\\ s (keyed by the
        minted entry number) so post-back/notify address the right issue; entries
        not in the map fall back to a by-number ref, exactly as polling does.

        ``polled``/``enqueued`` stay 0 in the returned report — this path neither
        polls nor enqueues; it only dispatches what is already queued.
        """
        if not heartbeat_enabled(self._detect()):
            return CycleReport.disabled()
        report = CycleReport()
        self._drain(workspace_id, refs_by_number or {}, report)
        return report

    def _drain(
        self,
        workspace_id: str,
        refs_by_number: Dict[int, IssueRef],
        report: CycleReport,
    ) -> None:
        """Dispatch every grabbable entry until the queue has no grabbable work.

        The single dispatch loop shared by ``poll_and_dispatch`` (after its poll)
        and ``dispatch_pending`` (with no poll), so both paths run the identical
        cheap→strong escalation dispatch (AC4 — no duplicated loop).
        """
        entry = self._store.next_grabbable(workspace_id)
        while entry is not None:
            ref = self._ref_for(entry, refs_by_number)
            self._dispatch_one(workspace_id, entry, ref, report)
            entry = self._store.next_grabbable(workspace_id)

    def _dispatch_one(
        self,
        workspace_id: str,
        entry: QueueEntry,
        ref: IssueRef,
        report: CycleReport,
    ) -> None:
        """Run a grabbable entry through the cheap→strong escalation loop.

        The MVP single-run is now a bounded loop (ADR 0011 / M036). Each iteration:

        1. START (first attempt only) → RUNNING; register the in-flight run, then
           execute in the sandbox on the *current tier's model*, carrying the
           compacted failure handoff from the previous attempt (``None`` first).
        2. Map status → queue Event; transition the entry + re-register the run
           with its real cost.
        3. On GATE_GREEN → done (the cheap tier, or whichever tier, was enough).
        4. On GATE_RED/error → consult the **Budget Leash** (``budget_leash.check``)
           with the accrued spend + attempt count:
             - ESCALATE → step the tier up (``routing.next_tier``), build the
               compacted handoff (``compaction.build`` from goal=issue title/body,
               attempt diff = prior branch, gate error = prior gate_reason), and
               loop to re-run on the stronger model.
             - STOP_TO_HUMAN (or no stronger tier) → ESCALATED_TO_HUMAN terminal;
               stop.

        Termination: ``attempts`` strictly increases each iteration and
        ``attempt_limit`` is a fixed positive integer, so the Budget Leash returns
        STOP_TO_HUMAN in at most ``attempt_limit`` iterations regardless of cost —
        the loop can never run forever (a green result stops it sooner, and a
        capped ``ceiling`` stops it sooner still). The reused queue state machine
        also caps escalation at the max tier.
        """
        run_id = str(uuid.uuid4())

        # START → RUNNING, register the first in-flight run. The entry's tier is
        # the source of truth for which model runs (CHEAP first).
        current = self._store.transition(entry, Event.START)
        self._store.register_run(
            entry=current, run_id=run_id, phase="execute", status="running"
        )

        spent = 0.0
        attempts = 0
        handoff_text: Optional[str] = None
        final_result: Optional[RunResult] = None

        while True:
            attempted_tier = current.tier
            model = self._model_for_tier(attempted_tier)
            try:
                result = self._sandbox(
                    repo_url=self._config.repo_url,
                    ref=self._config.ref,
                    issue_ref=str(ref.number),
                    workspace_id=workspace_id,
                    env=dict(self._config.env),
                    model=model,
                    failure_handoff=handoff_text,
                )
            except Exception as exc:  # noqa: BLE001 - any sandbox crash must still record cost
                # The sandbox call raised (container crash, timeout escalating to
                # an exception, daemon error, …). Synthesize an ERROR result so the
                # single reporting path below still runs and persists whatever cost
                # is recoverable — register_run stays the one place cost is written.
                # A failing RunResult carries the spent cost (sandbox-side fault
                # tolerance); when the raise surfaces a cost we honor it, otherwise
                # it is 0.0 — we report 0.0, never crash, never wedge the loop.
                cost = float(getattr(exc, "cost_usd", 0.0) or 0.0)
                _log.warning(
                    "sandbox raised for issue %s (tier=%s): %s",
                    getattr(ref, "number", "?"),
                    attempted_tier,
                    exc,
                )
                result = RunResult(
                    status="error",
                    cost_usd=cost,
                    gate_reason=f"sandbox crashed: {exc}",
                )
            final_result = result
            spent += result.cost_usd
            attempts += 1

            # status → queue Event, transition + re-register with the run cost. The
            # GATE_RED transition itself escalates the tier (or hard-stops at max).
            event = _STATUS_TO_EVENT.get(result.status, Event.GATE_RED)
            current = self._store.transition(current, event)
            self._store.register_run(
                entry=current,
                run_id=run_id,
                phase="execute",
                status=result.status,
                cost_usd=result.cost_usd,
                model_used=model,
            )

            if result.status == "green":
                break

            # Red/error: the Budget Leash decides continue/escalate/stop (reused —
            # not re-implemented). ``gate_red=True`` because the gate did not pass.
            decision = budget_leash.check(
                spent=spent,
                attempts=attempts,
                ceiling=self._config.ceiling,
                attempt_limit=self._config.attempt_limit,
                gate_red=True,
            )
            if decision is not Decision.ESCALATE:
                # STOP_TO_HUMAN (budget/attempts exhausted) — the loop HALTS here.
                # When it is the per-issue dollar ceiling that tripped (real $
                # spend >= a positive ceiling), stamp a clear, auditable reason on
                # the final result so the run records *why* it stopped — not just a
                # silent break. ``spent`` is the sum of real-dollar
                # ``RunResult.cost_usd`` values (pricing.cost_usd-derived).
                if self._config.ceiling > 0 and spent >= self._config.ceiling:
                    final_result.gate_reason = (
                        f"budget leash: per-issue $ ceiling exceeded — "
                        f"spent ${spent:.2f} >= ceiling "
                        f"${self._config.ceiling:.2f}; halting to human"
                    )
                    _log.warning(
                        "budget leash HALT for issue %s: spent $%.2f >= ceiling $%.2f",
                        getattr(ref, "number", "?"),
                        spent,
                        self._config.ceiling,
                    )
                break

            # ``routing.next_tier`` is the pure cheap→strong step; if there is no
            # stronger tier above the one we just attempted, there is nothing to
            # escalate to (the queue transition will already have hard-stopped).
            stronger = next_tier(attempted_tier)
            if stronger is None or is_terminal(current.state):
                break

            # Build the compacted handoff (reused — goal + prior diff + gate error,
            # redundant exploration dropped) the stronger model receives next.
            handoff_text = compaction.build(
                goal=self._goal_for(ref),
                attempt_diff=result.branch or "",
                gate_error=result.gate_reason or f"run {result.status}",
            ).text

            # Re-run on the next tier up. The GATE_RED transition already advanced
            # the entry to ``stronger`` in QUEUED; the loop owns the slot, so move
            # it straight to RUNNING for the next attempt.
            current = self._with_running_tier(current, stronger)

        # AC2/AC3/AC4/AC5 (issue #876): Merge Policy — consult policy only on Green.
        assert final_result is not None
        if final_result.status == "green":
            self._maybe_merge(ref, final_result)

        # Post back to the source issue + notify the channel with the FINAL result.
        # Both are best-effort: a failed comment/notify (e.g. a token without
        # `repo` scope → HTTP 401, or an unreachable webhook) must NOT crash the
        # dispatcher — log and continue, like the cost/run-event pushes.
        outcome = self._outcome_report(ref, final_result)
        try:
            self._connector.post_result(ref, outcome)
        except Exception as exc:  # noqa: BLE001 - best-effort back-channel
            _log.warning("post_result failed for issue %s: %s", getattr(ref, "number", "?"), exc)
        try:
            self._notifier.task_done(self._task_result(ref, final_result))
        except Exception as exc:  # noqa: BLE001 - best-effort notify
            _log.warning("notify failed for issue %s: %s", getattr(ref, "number", "?"), exc)

        report.dispatched += 1
        if final_result.status == "green":
            report.green += 1
        else:
            report.red += 1

    # -- escalation helpers (pure) ----------------------------------------- #
    def _model_for_tier(self, tier: Tier) -> Optional[str]:
        """Map the entry's tier to the configured model name (CHEAP/STRONG).

        ``None`` (no model configured for that tier) lets the runner image use its
        default model, so the loop still runs when only one model is configured.
        """
        if tier >= Tier.STRONG:
            return self._config.strong_model
        return self._config.cheap_model

    @staticmethod
    def _goal_for(ref: IssueRef) -> str:
        """The handoff goal: the issue title, falling back to body or a number ref.

        ``compaction.build`` requires a non-empty goal, so we always supply one.
        """
        return ref.title or ref.body or f"issue #{ref.number}"

    @staticmethod
    def _with_running_tier(entry: QueueEntry, tier: Tier) -> QueueEntry:
        """Return ``entry`` pinned to ``tier`` and RUNNING for the next attempt.

        The GATE_RED transition re-enqueues the entry one tier up in QUEUED; the
        loop attempts it immediately, so we move it straight to RUNNING on the
        target tier (the loop owns the slot for the duration of the escalation).
        """
        from dataclasses import replace
        from agentrail.afk.queue_state import QueueState

        return replace(entry, tier=tier, state=QueueState.RUNNING)

    # -- merge policy (issue #876) ----------------------------------------- #
    def _maybe_merge(self, ref: IssueRef, result: RunResult) -> None:
        """AC2/AC3/AC4/AC5: consult Merge Policy and merge or leave for human.

        Called only when the run is Green (Objective Gate + Independent
        Verification passed). Policy resolution order:
          1. Per-issue ``auto-merge`` label → merge (overrides repo default).
          2. Repo-level ``config.auto_merge=True`` → merge.
          3. Otherwise (default OFF) → leave the PR open for a human.

        The merge decision and outcome are recorded as a ``merge_decision``
        Run Event via ``store.record_event`` (AC5). The merge itself is
        best-effort: a failure is logged and recorded but does not crash the
        dispatcher.
        """
        label_override = "auto-merge" in getattr(ref, "labels", frozenset())
        should_merge = label_override or self._config.auto_merge

        if not should_merge:
            # Policy OFF — leave the PR open; record the decision (AC5).
            self._store.record_event(
                kind="merge_decision",
                issue_number=ref.number,
                pr_url=result.pr_url,
                outcome="left-for-human",
                reason="merge policy OFF and no auto-merge label",
            )
            return

        # Policy ON (repo setting or label override) — attempt squash-merge.
        pr_url = result.pr_url or ""
        subject = f"#{ref.number} {ref.title or ''}".strip()
        reason = "auto-merge label override" if label_override else "repo merge policy ON"

        merge_fn = self._merge_pr
        if merge_fn is None:
            # No merge callable injected (e.g. CLI not yet wired up) — record
            # and leave for human rather than silently skipping.
            self._store.record_event(
                kind="merge_decision",
                issue_number=ref.number,
                pr_url=pr_url,
                outcome="left-for-human",
                reason="merge_pr not configured",
            )
            return

        try:
            ok, mode = merge_fn(pr_url, subject)
        except Exception as exc:  # noqa: BLE001 - best-effort merge
            _log.warning("merge_pr failed for issue %s: %s", ref.number, exc)
            self._store.record_event(
                kind="merge_decision",
                issue_number=ref.number,
                pr_url=pr_url,
                outcome="merge-error",
                reason=str(exc),
            )
            return

        if ok:
            self._store.record_event(
                kind="merge_decision",
                issue_number=ref.number,
                pr_url=pr_url,
                outcome="merged",
                reason=reason + (f" (mode={mode})" if mode else ""),
            )
        else:
            _log.warning("merge_pr returned failure for issue %s", ref.number)
            self._store.record_event(
                kind="merge_decision",
                issue_number=ref.number,
                pr_url=pr_url,
                outcome="merge-failed",
                reason=reason,
            )

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
