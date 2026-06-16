"""Tests for the Postgres-backed Issue Queue store (agentrail/afk/queue_store.py).

The store is the *persistence edge* of the queue: it wraps the pure
``input_contract`` gate and the pure ``queue_state`` machine with durable storage
in a ``queue_entries`` table plus resumable ``runs`` registration. The queue
*decisions* stay pure (we never re-implement admit/transition here); these tests
exercise only the persistence behaviour through an injectable, in-memory fake
executor so they are hermetic (no real Postgres required).
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

from agentrail.afk.input_contract import Rejected
from agentrail.afk.queue_state import (
    Event,
    QueueEntry,
    QueueState,
    Terminal,
    Tier,
    transition,
)
from agentrail.afk.queue_store import QueueStore, _normalize_run_status


# --- A tiny in-memory fake executor modelling the two tables ------------------


class FakeExecutor:
    """Hermetic stand-in for a DB-API connection's ``execute`` seam.

    It understands only the handful of operations ``QueueStore`` issues, keyed by
    a stable marker the store passes as the operation name. This keeps the test
    from depending on a real SQL engine while still proving the store persists
    and reads back the right columns.
    """

    def __init__(self) -> None:
        # queue_entries rows keyed by id
        self.entries: Dict[str, Dict[str, Any]] = {}
        # runs rows keyed by id (resumable run registration)
        self.runs: Dict[str, Dict[str, Any]] = {}

    # The store calls this for writes (no return needed).
    def execute(self, op: str, params: Dict[str, Any]) -> None:
        if op == "insert_entry":
            self.entries[params["id"]] = dict(params)
        elif op == "update_entry":
            self.entries[params["id"]].update(params)
        elif op == "upsert_run":
            existing = self.runs.get(params["id"], {})
            existing.update(params)
            self.runs[params["id"]] = existing
        else:  # pragma: no cover - defensive
            raise AssertionError(f"unexpected op {op!r}")

    # The store calls this for reads.
    def query(self, op: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        if op == "list_queue":
            rows = [
                r
                for r in self.entries.values()
                if r["workspace_id"] == params["workspace_id"]
            ]
            return sorted(rows, key=lambda r: r["created_at"])
        if op == "next_grabbable":
            rows = [
                r
                for r in self.entries.values()
                if r["workspace_id"] == params["workspace_id"]
                and r["state"] == QueueState.QUEUED.value
            ]
            rows.sort(key=lambda r: r["created_at"])
            return rows[:1]
        raise AssertionError(f"unexpected query {op!r}")  # pragma: no cover


def _store() -> Tuple[QueueStore, FakeExecutor]:
    fake = FakeExecutor()
    return QueueStore(executor=fake), fake


_GOOD_BODY = (
    "## Acceptance criteria\n"
    "- [ ] the endpoint returns 200 for a valid request\n"
)
_NO_AC_BODY = "## Summary\nMake it nice.\n"


# --- AC1: enqueue gate + persistence -----------------------------------------


def test_enqueue_rejects_issue_without_machine_checkable_ac():
    store, fake = _store()
    result = store.enqueue(
        workspace_id="ws1",
        source="github",
        external_id="42",
        title="No AC",
        body=_NO_AC_BODY,
    )
    assert isinstance(result, Rejected)
    # Nothing persisted for a rejected issue.
    assert fake.entries == {}


def test_enqueue_admits_good_ac_and_persists_row_with_tier_budget_state():
    store, fake = _store()
    entry = store.enqueue(
        workspace_id="ws1",
        source="github",
        external_id="42",
        title="Good AC",
        body=_GOOD_BODY,
    )
    assert isinstance(entry, QueueEntry)
    # The pure machine minted the entry with defaults.
    assert entry.tier == Tier.CHEAP
    assert entry.remaining_budget == 2
    assert entry.state == QueueState.QUEUED

    # Exactly one row persisted, carrying tier/budget/state + the issue fields.
    assert len(fake.entries) == 1
    row = next(iter(fake.entries.values()))
    assert row["workspace_id"] == "ws1"
    assert row["source"] == "github"
    assert row["external_id"] == "42"
    assert row["title"] == "Good AC"
    assert row["tier"] == int(Tier.CHEAP)
    assert row["remaining_budget"] == 2
    assert row["state"] == QueueState.QUEUED.value


def test_enqueue_parks_entry_with_unmet_blocked_by():
    store, fake = _store()
    entry = store.enqueue(
        workspace_id="ws1",
        source="cli",
        external_id="7",
        title="Blocked",
        body=_GOOD_BODY,
        blocked_by=frozenset({99}),
    )
    assert isinstance(entry, QueueEntry)
    assert entry.state == QueueState.PARKED
    row = next(iter(fake.entries.values()))
    assert row["state"] == QueueState.PARKED.value
    assert row["blocked_by"] == [99]


# --- AC2: next_grabbable ordering, skips parked/terminal ----------------------


def test_next_grabbable_returns_oldest_queued_and_skips_parked_and_terminal():
    store, fake = _store()
    store.enqueue(
        workspace_id="ws1", source="cli", external_id="1",
        title="parked", body=_GOOD_BODY, blocked_by=frozenset({5}),
    )
    second = store.enqueue(
        workspace_id="ws1", source="cli", external_id="2",
        title="first queued", body=_GOOD_BODY,
    )
    store.enqueue(
        workspace_id="ws1", source="cli", external_id="3",
        title="later queued", body=_GOOD_BODY,
    )
    # Different workspace must be ignored.
    store.enqueue(
        workspace_id="ws2", source="cli", external_id="4",
        title="other ws", body=_GOOD_BODY,
    )

    grabbed = store.next_grabbable("ws1")
    assert isinstance(grabbed, QueueEntry)
    assert grabbed.number == second.number  # oldest QUEUED, not the parked one


def test_next_grabbable_returns_none_when_only_parked_or_terminal():
    store, fake = _store()
    entry = store.enqueue(
        workspace_id="ws1", source="cli", external_id="1",
        title="will go green", body=_GOOD_BODY,
    )
    # Drive it to a terminal via the pure machine + persist.
    started = store.transition(entry, Event.START)
    store.transition(started, Event.GATE_GREEN)
    # Only a parked entry remains otherwise.
    store.enqueue(
        workspace_id="ws1", source="cli", external_id="2",
        title="parked", body=_GOOD_BODY, blocked_by=frozenset({9}),
    )
    assert store.next_grabbable("ws1") is None


# --- transition persists ------------------------------------------------------


def test_transition_persists_new_state():
    store, fake = _store()
    entry = store.enqueue(
        workspace_id="ws1", source="cli", external_id="1",
        title="t", body=_GOOD_BODY,
    )
    running = store.transition(entry, Event.START)
    assert running.state == QueueState.RUNNING
    row = next(iter(fake.entries.values()))
    assert row["state"] == QueueState.RUNNING.value

    green = store.transition(running, Event.GATE_GREEN)
    assert green.state == Terminal.GREEN
    row = next(iter(fake.entries.values()))
    assert row["state"] == Terminal.GREEN.value


def test_transition_matches_pure_state_machine():
    store, _ = _store()
    entry = store.enqueue(
        workspace_id="ws1", source="cli", external_id="1",
        title="t", body=_GOOD_BODY,
    )
    running = store.transition(entry, Event.START)
    # The store must not invent its own decision: it equals the pure transition.
    assert running == transition(entry, Event.START)


# --- AC3: register_run persists resumable run state, upserts ------------------


def test_register_run_persists_resumable_state():
    store, fake = _store()
    entry = store.enqueue(
        workspace_id="ws1", source="github", external_id="42",
        title="t", body=_GOOD_BODY,
    )
    store.register_run(
        entry=entry,
        run_id="run-1",
        phase="plan",
        status="running",
        cost_usd=0.0,
    )
    assert "run-1" in fake.runs
    row = fake.runs["run-1"]
    assert row["workspace_id"] == "ws1"
    assert row["phase"] == "plan"
    assert row["status"] == "running"
    assert row["cost_usd"] == 0.0
    # The run is tied back to its queue entry so a killed run can be resumed.
    assert row["queue_entry_id"] == store.entry_id(entry)


def test_register_run_upserts_same_run_id():
    store, fake = _store()
    entry = store.enqueue(
        workspace_id="ws1", source="github", external_id="42",
        title="t", body=_GOOD_BODY,
    )
    store.register_run(entry=entry, run_id="run-1", phase="plan", status="running")
    store.register_run(
        entry=entry, run_id="run-1", phase="execute", status="success",
        cost_usd=1.25,
    )
    assert len(fake.runs) == 1  # upsert, not a second row
    row = fake.runs["run-1"]
    assert row["phase"] == "execute"
    assert row["status"] == "success"
    assert row["cost_usd"] == 1.25


# --- list_queue read model ----------------------------------------------------


def test_list_queue_returns_all_workspace_entries_in_order():
    store, _ = _store()
    a = store.enqueue(
        workspace_id="ws1", source="cli", external_id="1",
        title="a", body=_GOOD_BODY,
    )
    b = store.enqueue(
        workspace_id="ws1", source="cli", external_id="2",
        title="b", body=_GOOD_BODY,
    )
    store.enqueue(
        workspace_id="ws2", source="cli", external_id="3",
        title="other", body=_GOOD_BODY,
    )
    listed = store.list_queue("ws1")
    assert [e.number for e in listed] == [a.number, b.number]
    assert all(isinstance(e, QueueEntry) for e in listed)


# --- run-status normalization (runs.status enum is {queued,running,success,failed}) ---


def test_normalize_run_status_maps_outcome_vocabulary_to_enum():
    assert _normalize_run_status("green") == "success"
    assert _normalize_run_status("red") == "failed"
    assert _normalize_run_status("error") == "failed"
    assert _normalize_run_status("running") == "running"
    assert _normalize_run_status("queued") == "queued"
    assert _normalize_run_status("WeIrD") == "failed"  # unknown -> failed (enum-safe)


def test_register_run_writes_enum_safe_status():
    store, ex = _store()
    e = store.enqueue(
        workspace_id="ws1", source="cli", external_id="1",
        title="a", body=_GOOD_BODY,
    )
    rid = "11111111-1111-1111-1111-111111111111"
    store.register_run(entry=e, run_id=rid, phase="execute", status="green", cost_usd=0.5)
    assert ex.runs[rid]["status"] == "success"  # dispatcher 'green' -> runs.status 'success'
