"""Postgres-backed Issue Queue store — the *persistence edge* of the queue.

This module is the durable backbone the console "queue" and the dispatcher both
consume. Today the console projects a "queue" by grouping ``runs`` rows by
branch, and run state is never registered to Postgres, so a killed run cannot be
resumed. This store fixes both: it persists every admitted issue as a durable
``queue_entries`` row and registers resumable run-state into ``runs``.

It is *only* the persistence edge. The queue *decisions* stay pure and live in
two deep modules this file reuses, never re-implements:

- ``agentrail.afk.input_contract`` — the GATE: an issue with no machine-checkable
  acceptance criteria is rejected and never becomes a ``QueueEntry``.
- ``agentrail.afk.queue_state`` — the pure state machine: ``admit`` (park if
  blocked) and ``transition`` (the only place state changes are *decided*).

``QueueStore`` wraps those with an injectable ``executor`` so it is hermetic in
tests (an in-memory fake) and real in production (``PostgresExecutor`` talking to
the same ``DATABASE_URL`` the rest of the app uses). The executor speaks a tiny
operation vocabulary (``insert_entry``/``update_entry``/``upsert_run`` writes and
``list_queue``/``next_grabbable`` reads) so the SQL never leaks into the queue
logic and the store can be tested without a database.

Seam consumed by the dispatcher (exact signatures):

    enqueue(*, workspace_id, source, external_id, title, body,
            blocked_by=frozenset()) -> QueueEntry | Rejected
    next_grabbable(workspace_id) -> QueueEntry | None
    transition(entry, event) -> QueueEntry
    register_run(*, entry, run_id, phase, status, cost_usd=0.0) -> None
    list_queue(workspace_id) -> list[QueueEntry]
"""
from __future__ import annotations

import os
import uuid
import zlib
from datetime import datetime, timezone
from typing import Any, Dict, FrozenSet, List, Optional, Protocol, Union

from agentrail.afk import input_contract
from agentrail.afk.input_contract import Rejected
from agentrail.afk.queue_state import (
    Event,
    QueueEntry,
    QueueState,
    Terminal,
    Tier,
    admit,
)

# Sources an entry can come from (mirrors the schema CHECK / drizzle enum).
Source = str  # 'cli' | 'github' | 'linear'

# The ``runs.status`` Postgres enum is {queued, running, success, failed}. The
# dispatcher reports run outcomes in the Run-Outcome vocabulary (green / red /
# error). Normalize to the enum so register_run never writes an invalid label
# (caught against a real Postgres; the in-memory test executor accepted anything).
_RUN_STATUS_ENUM = {
    "queued": "queued",
    "running": "running",
    "success": "success",
    "failed": "failed",
    "green": "success",
    "red": "failed",
    "error": "failed",
}


def _normalize_run_status(status: str) -> str:
    """Map a reported run status to the ``runs.status`` enum (unknown → failed)."""
    return _RUN_STATUS_ENUM.get((status or "").lower(), "failed")


class Executor(Protocol):
    """The injectable persistence seam.

    Implementations translate a small fixed operation vocabulary into storage.
    ``execute`` performs a write (no result); ``query`` returns a list of row
    dicts. Keeping this tiny is deliberate: the queue *logic* never sees SQL, and
    tests inject an in-memory fake.
    """

    def execute(self, op: str, params: Dict[str, Any]) -> None:  # pragma: no cover
        ...

    def query(self, op: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:  # pragma: no cover
        ...


def _state_value(state: object) -> str:
    """The persisted string for a queue/terminal state."""
    if isinstance(state, (QueueState, Terminal)):
        return state.value
    return str(state)


def _entry_number(workspace_id: str, source: str, external_id: str) -> int:
    """A stable non-negative int ``number`` for the pure ``QueueEntry``.

    ``QueueEntry.number`` is an int (it predates multi-source ids). When the
    external id is a plain integer (a GitHub issue number) we use it directly so
    the number stays human-meaningful; otherwise (e.g. a Linear id or a URL) we
    fall back to a deterministic CRC of the identity so the same issue always
    maps to the same number.
    """
    if external_id.isdigit():
        return int(external_id)
    seed = f"{workspace_id}:{source}:{external_id}".encode("utf-8")
    return zlib.crc32(seed)


def _entry_uuid(workspace_id: str, source: str, external_id: str) -> str:
    """A stable UUID primary key for the ``queue_entries`` row.

    Deterministic in the issue identity so enqueueing the same issue twice
    upserts the same row rather than duplicating it.
    """
    return str(
        uuid.uuid5(uuid.NAMESPACE_URL, f"agentrail-queue:{workspace_id}:{source}:{external_id}")
    )


class QueueStore:
    """Durable, Postgres-backed Issue Queue + resumable run registration."""

    def __init__(self, executor: Executor):
        self._exec = executor
        # Identity map: QueueEntry.number -> the row's stable uuid/source/external.
        # The pure QueueEntry only carries ``number``; we remember the rest so
        # transitions/register_run can address the right row.
        self._identity: Dict[int, Dict[str, str]] = {}

    # -- identity helpers ------------------------------------------------------

    def entry_id(self, entry: QueueEntry) -> str:
        """The durable ``queue_entries`` row id for an entry."""
        ident = self._identity.get(entry.number)
        if ident is None:
            raise KeyError(
                f"entry #{entry.number} is not known to this store; enqueue it first"
            )
        return ident["id"]

    def _workspace_of(self, entry: QueueEntry) -> str:
        return self._identity[entry.number]["workspace_id"]

    # -- AC1: enqueue (gate + persist) ----------------------------------------

    def enqueue(
        self,
        *,
        workspace_id: str,
        source: Source,
        external_id: str,
        title: str,
        body: str,
        blocked_by: FrozenSet[int] = frozenset(),
    ) -> Union[QueueEntry, Rejected]:
        """Gate an issue, then persist it as a durable ``queue_entries`` row.

        Runs the pure ``input_contract.validate`` GATE: an issue with no
        machine-checkable acceptance criteria is rejected and *nothing* is
        persisted. A validated issue is minted into a fresh ``QueueEntry`` on the
        pure state machine, parked via ``queue_state.admit`` if it has an unmet
        ``blocked_by`` dependency, and persisted with its tier/budget/state.
        """
        number = _entry_number(workspace_id, source, external_id)
        gated = input_contract.admit_to_queue(
            number=number, issue_body=body, blocked_by=blocked_by
        )
        if isinstance(gated, Rejected):
            return gated  # GATE: no row for an issue without machine-checkable AC

        # Park if any blocked-by dependency is unmet (pure decision).
        entry = admit(gated, open_blockers=blocked_by)

        row_id = _entry_uuid(workspace_id, source, external_id)
        self._identity[entry.number] = {
            "id": row_id,
            "workspace_id": workspace_id,
            "source": source,
            "external_id": external_id,
        }
        now = datetime.now(timezone.utc).isoformat()
        self._exec.execute(
            "insert_entry",
            {
                "id": row_id,
                "workspace_id": workspace_id,
                "source": source,
                "external_id": external_id,
                "title": title,
                "body": body,
                "tier": int(entry.tier),
                "remaining_budget": entry.remaining_budget,
                "state": _state_value(entry.state),
                "blocked_by": sorted(entry.blocked_by),
                "created_at": now,
                "updated_at": now,
            },
        )
        return entry

    # -- AC2: next grabbable ---------------------------------------------------

    def next_grabbable(self, workspace_id: str) -> Optional[QueueEntry]:
        """The next QUEUED, non-parked, non-terminal entry, or ``None``.

        Oldest-first. Parked entries (unmet ``blocked_by``) and terminal entries
        (Green / Escalated-to-human / Blocked) are skipped — they are not
        grabbable. The executor's ``next_grabbable`` query already filters to the
        QUEUED state; ordering is by ``created_at``.
        """
        rows = self._exec.query("next_grabbable", {"workspace_id": workspace_id})
        if not rows:
            return None
        return self._row_to_entry(rows[0])

    # -- transition (pure decision + persist) ---------------------------------

    def transition(self, entry: QueueEntry, event: Event) -> QueueEntry:
        """Apply the pure ``queue_state.transition`` and persist the result.

        The decision is *not* made here — it is delegated to the pure machine, so
        escalation/budget/termination semantics live in exactly one place. This
        method only writes the new tier/budget/state back to the durable row.
        """
        from agentrail.afk import queue_state

        nxt = queue_state.transition(entry, event)
        self._persist_state(nxt)
        return nxt

    # -- AC3: register resumable run state ------------------------------------

    def register_run(
        self,
        *,
        entry: QueueEntry,
        run_id: str,
        phase: str,
        status: str,
        cost_usd: float = 0.0,
    ) -> None:
        """Upsert resumable run state into ``runs`` for a queue entry.

        Records enough to resume a killed run: workspace, the originating
        ``queue_entry_id``, the current ``phase``, ``status``, accrued
        ``cost_usd`` and an ``updated_at`` watermark. Upserts on ``run_id`` so
        repeated phase/cost updates mutate the same row instead of duplicating.
        """
        ident = self._identity[entry.number]
        now = datetime.now(timezone.utc).isoformat()
        self._exec.execute(
            "upsert_run",
            {
                "id": run_id,
                "workspace_id": ident["workspace_id"],
                "queue_entry_id": ident["id"],
                "phase": phase,
                "status": _normalize_run_status(status),
                "cost_usd": cost_usd,
                "updated_at": now,
                # Legacy NOT NULL columns on ``runs`` (pre-MVP) that the
                # dispatcher will refine once it owns the run. They are supplied
                # here so a minimal run-registration row is a valid INSERT; the
                # branch carries the entry identity for resume.
                "repository_id": ident["external_id"],
                "agent": ident["source"],
                "branch": f"afk/{ident['source']}-{ident['external_id']}",
            },
        )

    # -- list_queue read model -------------------------------------------------

    def list_queue(self, workspace_id: str) -> List[QueueEntry]:
        """All queue entries for a workspace, oldest-first — the console read model."""
        rows = self._exec.query("list_queue", {"workspace_id": workspace_id})
        return [self._row_to_entry(r) for r in rows]

    # -- internals -------------------------------------------------------------

    def _persist_state(self, entry: QueueEntry) -> None:
        ident = self._identity[entry.number]
        self._exec.execute(
            "update_entry",
            {
                "id": ident["id"],
                "tier": int(entry.tier),
                "remaining_budget": entry.remaining_budget,
                "state": _state_value(entry.state),
                "blocked_by": sorted(entry.blocked_by),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
        )

    def _row_to_entry(self, row: Dict[str, Any]) -> QueueEntry:
        """Rehydrate a pure ``QueueEntry`` from a persisted row.

        Also refreshes the identity map so a transition/register_run on the
        rehydrated entry can find its row (important after a resume, when the
        store process is fresh and has no in-memory identity).
        """
        number = _entry_number(row["workspace_id"], row["source"], row["external_id"])
        self._identity[number] = {
            "id": row["id"],
            "workspace_id": row["workspace_id"],
            "source": row["source"],
            "external_id": row["external_id"],
        }
        state = _parse_state(row["state"])
        blocked = frozenset(int(b) for b in (row.get("blocked_by") or []))
        return QueueEntry(
            number=number,
            tier=Tier(int(row["tier"])),
            remaining_budget=int(row["remaining_budget"]),
            state=state,
            blocked_by=blocked,
        )


def _parse_state(value: str) -> object:
    """Turn a persisted state string back into a QueueState or Terminal."""
    for member in QueueState:
        if member.value == value:
            return member
    for member in Terminal:
        if member.value == value:
            return member
    raise ValueError(f"unknown persisted state: {value!r}")  # pragma: no cover


# --- Real Postgres executor (the production edge) -----------------------------


_SQL = {
    "insert_entry": (
        "INSERT INTO queue_entries "
        "(id, workspace_id, source, external_id, title, body, tier, "
        " remaining_budget, state, blocked_by, created_at, updated_at) "
        "VALUES (%(id)s, %(workspace_id)s, %(source)s, %(external_id)s, "
        " %(title)s, %(body)s, %(tier)s, %(remaining_budget)s, %(state)s, "
        " %(blocked_by)s, %(created_at)s, %(updated_at)s) "
        "ON CONFLICT (id) DO UPDATE SET "
        " title = EXCLUDED.title, body = EXCLUDED.body, tier = EXCLUDED.tier, "
        " remaining_budget = EXCLUDED.remaining_budget, state = EXCLUDED.state, "
        " blocked_by = EXCLUDED.blocked_by, updated_at = EXCLUDED.updated_at"
    ),
    "update_entry": (
        "UPDATE queue_entries SET tier = %(tier)s, "
        " remaining_budget = %(remaining_budget)s, state = %(state)s, "
        " blocked_by = %(blocked_by)s, updated_at = %(updated_at)s "
        "WHERE id = %(id)s"
    ),
    "upsert_run": (
        "INSERT INTO runs "
        "(id, workspace_id, queue_entry_id, phase, status, cost_usd, "
        " updated_at, repository_id, agent, branch) "
        "VALUES (%(id)s, %(workspace_id)s, %(queue_entry_id)s, %(phase)s, "
        " %(status)s, %(cost_usd)s, %(updated_at)s, %(repository_id)s, "
        " %(agent)s, %(branch)s) "
        "ON CONFLICT (id) DO UPDATE SET "
        " workspace_id = EXCLUDED.workspace_id, "
        " queue_entry_id = EXCLUDED.queue_entry_id, phase = EXCLUDED.phase, "
        " status = EXCLUDED.status, cost_usd = EXCLUDED.cost_usd, "
        " updated_at = EXCLUDED.updated_at"
    ),
    "list_queue": (
        "SELECT id, workspace_id, source, external_id, title, body, tier, "
        " remaining_budget, state, blocked_by, created_at, updated_at "
        "FROM queue_entries WHERE workspace_id = %(workspace_id)s "
        "ORDER BY created_at ASC"
    ),
    "next_grabbable": (
        "SELECT id, workspace_id, source, external_id, title, body, tier, "
        " remaining_budget, state, blocked_by, created_at, updated_at "
        "FROM queue_entries WHERE workspace_id = %(workspace_id)s "
        "AND state = 'queued' ORDER BY created_at ASC LIMIT 1"
    ),
}


class PostgresExecutor:
    """An :class:`Executor` backed by the app's Postgres (same ``DATABASE_URL``).

    Lazily imports a DB-API driver (``psycopg`` then ``psycopg2``) so the module
    imports cleanly without a driver installed — tests use the in-memory fake and
    never touch this path. Construct it only when a real connection is wanted.
    """

    def __init__(self, dsn: Optional[str] = None):
        self._dsn = dsn or os.environ.get(
            "DATABASE_URL", "postgres://agentrail:agentrail@localhost:5432/agentrail"
        )
        self._connect = _load_driver()
        self._conn = None

    def _connection(self):  # pragma: no cover - needs a live DB
        if self._conn is None:
            self._conn = self._connect(self._dsn)
        return self._conn

    def execute(self, op: str, params: Dict[str, Any]) -> None:  # pragma: no cover
        conn = self._connection()
        with conn.cursor() as cur:
            cur.execute(_SQL[op], params)
        conn.commit()

    def query(self, op: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:  # pragma: no cover
        conn = self._connection()
        with conn.cursor() as cur:
            cur.execute(_SQL[op], params)
            cols = [c[0] for c in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


def _load_driver():  # pragma: no cover - environment dependent
    """Return a ``connect(dsn) -> connection`` callable from an installed driver."""
    try:
        import psycopg  # type: ignore

        return psycopg.connect
    except ImportError:
        pass
    try:
        import psycopg2  # type: ignore

        return psycopg2.connect
    except ImportError as exc:
        raise RuntimeError(
            "PostgresExecutor needs a DB-API driver (psycopg or psycopg2). "
            "Install one, or inject a custom executor for tests."
        ) from exc
