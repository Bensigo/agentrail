"""
Redux-style state machine for the AFK workflow.

Single source of truth: one ``AfkState`` object mutated only by pure reducers
in response to typed actions. No GitHub label, HTML comment, or on-disk counter
is ever read to make a decision — they are *projections* of this state, written
as side effects after a dispatch.

The store is single-owner: the asyncio orchestrator is the only thing that calls
``dispatch``. Because reducers are synchronous and the event loop runs one
coroutine at a time, ``claim_next`` is atomic — two slots can never claim the
same issue. That is the structural fix for the slot race condition (which is
unsolvable on top of GitHub's eventually-consistent label API).
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Callable, Dict, FrozenSet, List, Optional, Tuple


class IssueStatus(str, Enum):
    QUEUED = "queued"            # in the work queue, not yet claimed
    CLAIMED = "claimed"          # a slot owns it, work not started
    RUNNING = "running"          # agent implementing the issue
    PR_OPEN = "pr_open"          # PR exists, awaiting review
    REVIEWING = "reviewing"      # review in progress
    AUTOFIXING = "autofixing"    # P0/P1 finding being patched in place
    MERGED = "merged"            # PR merged, done
    COMMENTED = "commented"      # P2/P3 findings posted; engineer decides
    HUMAN_REVIEW = "human_review"  # retries/rounds exhausted; needs a human
    FAILED = "failed"            # gave up


# Terminal states: an issue in one of these is never re-queued or re-claimed.
TERMINAL_STATUSES = frozenset(
    {IssueStatus.MERGED, IssueStatus.COMMENTED, IssueStatus.HUMAN_REVIEW, IssueStatus.FAILED}
)


@dataclass(frozen=True)
class IssueState:
    number: int
    title: str
    url: str
    status: IssueStatus = IssueStatus.QUEUED
    pr: Optional[int] = None
    slot: Optional[int] = None
    retries: int = 0
    review_rounds: int = 0
    error: Optional[str] = None
    # Last-known real-dollar cost of this issue's run, as reported by the
    # pipeline. Held in state so it is reported via ingest even when the run
    # fails: the finally-block re-reads the issue from the store and the cost
    # rides along. SET — not accumulated — because the pipeline's cost ledger is
    # already the cumulative cost of one run, so SET is idempotent across retries.
    cost_usd: float = 0.0
    # Issue numbers this issue is blocked by (parsed from its "## Blocked by"
    # section). An issue is not claimable while any of these is still OPEN.
    blocked_by: Tuple[int, ...] = ()


@dataclass(frozen=True)
class AfkState:
    issues: Dict[int, IssueState] = field(default_factory=dict)
    # slot index -> issue number currently held (or None when free)
    slots: Dict[int, Optional[int]] = field(default_factory=dict)
    concurrency: int = 2
    max_retries: int = 2
    max_review_rounds: int = 3
    completed: int = 0
    failed: int = 0

    # --- read-only selectors -------------------------------------------------

    def next_queued(self) -> Optional[IssueState]:
        """Lowest-numbered issue still waiting for a slot. Pure."""
        candidates = [
            i for i in self.issues.values() if i.status == IssueStatus.QUEUED
        ]
        if not candidates:
            return None
        return sorted(candidates, key=lambda i: i.number)[0]

    def next_claimable(self, open_blockers: FrozenSet[int] = frozenset()) -> Optional[IssueState]:
        """Lowest-numbered QUEUED issue whose blockers are all resolved. Pure.

        An issue is claimable only when none of its ``blocked_by`` numbers is in
        *open_blockers* (the set of blocker issues still open). With an empty
        *open_blockers* this is identical to :meth:`next_queued`.
        """
        candidates = [
            i for i in self.issues.values()
            if i.status == IssueStatus.QUEUED
            and not (open_blockers and set(i.blocked_by) & open_blockers)
        ]
        if not candidates:
            return None
        return sorted(candidates, key=lambda i: i.number)[0]

    def has_blocked_pending(self, open_blockers: FrozenSet[int]) -> bool:
        """True when some issue is QUEUED but withheld by an open blocker."""
        return any(
            i.status == IssueStatus.QUEUED and (set(i.blocked_by) & open_blockers)
            for i in self.issues.values()
        )

    def free_slot(self) -> Optional[int]:
        for idx in range(self.concurrency):
            if self.slots.get(idx) is None:
                return idx
        return None

    def active_count(self) -> int:
        return sum(1 for v in self.slots.values() if v is not None)

    def is_drained(self) -> bool:
        """True when nothing is queued and no slot is busy."""
        return self.next_queued() is None and self.active_count() == 0


# --- Actions ----------------------------------------------------------------
#
# Actions are tiny frozen dataclasses (the Redux "action creator" equivalent).
# Each maps to exactly one branch of the reducer.


@dataclass(frozen=True)
class EnqueueIssue:
    number: int
    title: str
    url: str
    blocked_by: Tuple[int, ...] = ()


@dataclass(frozen=True)
class SetBlockedBy:
    """Refresh an existing issue's blocker list (e.g. on resume / re-seed)."""
    number: int
    blocked_by: Tuple[int, ...]


@dataclass(frozen=True)
class ClaimIssue:
    number: int
    slot: int


@dataclass(frozen=True)
class ReleaseIssue:
    """Return an issue to the queue (e.g. transient failure under the retry cap)."""
    number: int


@dataclass(frozen=True)
class SetStatus:
    number: int
    status: IssueStatus


@dataclass(frozen=True)
class SetPr:
    number: int
    pr: int


@dataclass(frozen=True)
class RecordFailure:
    number: int
    error: Optional[str] = None


@dataclass(frozen=True)
class RecordCost:
    """Record the cumulative real-dollar cost the pipeline reported for a run.

    SET (replace), not add: ``cost_usd`` is already the cumulative cost of a
    single run, so re-dispatching with the same value is idempotent and a retry
    overwrites the prior attempt's cost with the latest run's cost.
    """
    number: int
    cost_usd: float


@dataclass(frozen=True)
class IncrementReviewRound:
    number: int


@dataclass(frozen=True)
class FreeSlot:
    slot: int


@dataclass(frozen=True)
class RequeueIssue:
    """Reset an issue (typically terminal from a prior run) back to QUEUED with
    fresh counters, so a new run can re-attempt it. Used on resume when an issue
    is still open in the GitHub queue. The PR reference is kept so the pipeline
    stays idempotent (it will review the existing PR rather than re-implement)."""
    number: int


Action = object  # union of the dataclasses above


# --- Reducer ----------------------------------------------------------------


def _require(state: AfkState, number: int) -> IssueState:
    issue = state.issues.get(number)
    if issue is None:
        raise KeyError(f"unknown issue #{number}")
    return issue


def reduce(state: AfkState, action: Action) -> AfkState:
    """Pure: (state, action) -> new state. Never mutates ``state`` in place."""
    issues = dict(state.issues)
    slots = dict(state.slots)
    completed = state.completed
    failed = state.failed

    if isinstance(action, EnqueueIssue):
        if action.number in issues:
            return state  # idempotent: already known
        issues[action.number] = IssueState(
            number=action.number, title=action.title, url=action.url,
            blocked_by=tuple(action.blocked_by),
        )

    elif isinstance(action, SetBlockedBy):
        issue = issues.get(action.number)
        if issue is None or tuple(issue.blocked_by) == tuple(action.blocked_by):
            return state  # unknown issue or no change
        issues[action.number] = replace(issue, blocked_by=tuple(action.blocked_by))

    elif isinstance(action, ClaimIssue):
        issue = _require(state, action.number)
        if issue.status != IssueStatus.QUEUED:
            raise ValueError(
                f"cannot claim issue #{action.number}: status is {issue.status.value}"
            )
        if slots.get(action.slot) is not None:
            raise ValueError(f"slot {action.slot} is already occupied")
        slots[action.slot] = action.number
        issues[action.number] = replace(
            issue, status=IssueStatus.CLAIMED, slot=action.slot
        )

    elif isinstance(action, ReleaseIssue):
        issue = _require(state, action.number)
        if issue.slot is not None:
            slots[issue.slot] = None
        issues[action.number] = replace(
            issue, status=IssueStatus.QUEUED, slot=None
        )

    elif isinstance(action, SetStatus):
        issue = _require(state, action.number)
        issues[action.number] = replace(issue, status=action.status)
        if action.status == IssueStatus.MERGED:
            completed += 1
        if action.status in (IssueStatus.MERGED, IssueStatus.COMMENTED,
                             IssueStatus.HUMAN_REVIEW, IssueStatus.FAILED):
            # free the slot on any terminal transition
            if issue.slot is not None:
                slots[issue.slot] = None
                issues[action.number] = replace(
                    issues[action.number], slot=None
                )

    elif isinstance(action, SetPr):
        issue = _require(state, action.number)
        issues[action.number] = replace(issue, pr=action.pr)

    elif isinstance(action, RecordCost):
        issue = _require(state, action.number)
        # SET, not accumulate: the value is already the run's cumulative cost.
        issues[action.number] = replace(issue, cost_usd=float(action.cost_usd))

    elif isinstance(action, RecordFailure):
        issue = _require(state, action.number)
        retries = issue.retries + 1
        if retries >= state.max_retries:
            # exhausted — terminal, needs a human, free the slot
            if issue.slot is not None:
                slots[issue.slot] = None
            issues[action.number] = replace(
                issue,
                retries=retries,
                status=IssueStatus.HUMAN_REVIEW,
                slot=None,
                error=action.error,
            )
            failed += 1
        else:
            # under the cap — release back to the queue for another attempt
            if issue.slot is not None:
                slots[issue.slot] = None
            issues[action.number] = replace(
                issue,
                retries=retries,
                status=IssueStatus.QUEUED,
                slot=None,
                error=action.error,
            )

    elif isinstance(action, IncrementReviewRound):
        issue = _require(state, action.number)
        issues[action.number] = replace(issue, review_rounds=issue.review_rounds + 1)

    elif isinstance(action, FreeSlot):
        slots[action.slot] = None

    elif isinstance(action, RequeueIssue):
        issue = _require(state, action.number)
        if issue.slot is not None:
            slots[issue.slot] = None
        # adjust aggregate counters if leaving a terminal counted state
        if issue.status == IssueStatus.MERGED:
            completed = max(0, completed - 1)
        elif issue.status == IssueStatus.HUMAN_REVIEW:
            failed = max(0, failed - 1)
        issues[action.number] = replace(
            issue,
            status=IssueStatus.QUEUED,
            slot=None,
            retries=0,
            review_rounds=0,
            error=None,
        )

    else:  # pragma: no cover - guards against unhandled action types
        raise TypeError(f"unknown action: {action!r}")

    return AfkState(
        issues=issues,
        slots=slots,
        concurrency=state.concurrency,
        max_retries=state.max_retries,
        max_review_rounds=state.max_review_rounds,
        completed=completed,
        failed=failed,
    )


# --- Store ------------------------------------------------------------------


Subscriber = Callable[[AfkState, Action], None]


class Store:
    """
    Holds the current state and applies reducers. Subscribers run after each
    dispatch and are where side effects live (persist snapshot, write GitHub
    labels, log). Subscriber exceptions are swallowed so a flaky ``gh`` call
    can never corrupt in-memory state.
    """

    def __init__(self, initial: AfkState) -> None:
        self._state = initial
        self._subscribers: List[Subscriber] = []

    @property
    def state(self) -> AfkState:
        return self._state

    def subscribe(self, fn: Subscriber) -> None:
        self._subscribers.append(fn)

    def dispatch(self, action: Action) -> AfkState:
        self._state = reduce(self._state, action)
        for sub in self._subscribers:
            try:
                sub(self._state, action)
            except Exception:  # noqa: BLE001 - side effects must not corrupt state
                pass
        return self._state

    # Atomic claim: select + transition in one synchronous step. This is the
    # slot-race fix — only one coroutine runs this at a time, so the gap between
    # "pick next" and "mark claimed" cannot interleave.
    def claim_next(self, open_blockers: FrozenSet[int] = frozenset()) -> Optional[IssueState]:
        nxt = self._state.next_claimable(open_blockers)
        if nxt is None:
            return None
        slot = self._state.free_slot()
        if slot is None:
            return None
        self.dispatch(ClaimIssue(number=nxt.number, slot=slot))
        return self._state.issues[nxt.number]

    def snapshot(self) -> AfkState:
        return copy.deepcopy(self._state)
