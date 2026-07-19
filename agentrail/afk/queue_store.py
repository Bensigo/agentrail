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

import json
import os
import uuid
import zlib
from datetime import datetime, timezone
from typing import Any, Dict, FrozenSet, List, Optional, Protocol, Union

from agentrail.afk import input_contract
from agentrail.afk.input_contract import (
    Admission,
    AdmissionLedger,
    Rejected,
    WriterClass,
)
from agentrail.afk.queue_state import (
    ALIGNMENT_DENIED_PARK_REASON,
    ALIGNMENT_PARK_REASON,
    Event,
    QueueEntry,
    QueueState,
    Terminal,
    Tier,
    admit,
    apply_admission_alignment,
    release_if_aligned,
)

# Sources an entry can come from (mirrors the schema CHECK / drizzle enum).
Source = str  # 'cli' | 'github' | 'linear'

# --- Input-Contract v2 feature flag (issue #1026, Blocker 3) -----------------
# The v2 queue-entrance guardrails — prompt-injection screen, duplicate-content
# dedup, and per-writer rate limit — are a NEW enforcement layer on the LIVE
# intake path, so per the project rollout rule they merge behind a default-OFF
# env-var flag. With the flag OFF (unset or anything other than "1"), ``enqueue``
# behaves EXACTLY as it did before this PR: the legacy stateless gate (injection
# screen + machine-checkable-AC) hard-REJECTs and no ledger is threaded, so dedup
# and rate-limit never run. With the flag ON, ``enqueue`` threads the persistent
# ledger and parks (never drops) an injection/dup/rate-limit hit for human review.
_V2_FLAG = "AGENTRAIL_QUEUE_GUARDRAILS_V2"


def _v2_enabled() -> bool:
    """True when the Input-Contract v2 queue-entrance guardrails are enabled.

    Default-OFF: only the exact value ``"1"`` turns the layer on, so an unset or
    empty env var (production default) leaves live intake unchanged (Blocker 3).
    """
    return os.environ.get(_V2_FLAG) == "1"


# Map the persisted ``source`` string to the writer class the rate limiter keys
# on. Live GitHub intake (poll + webhook) is a human labelling an issue; the eval
# harness and Jace are their own writer classes when they feed the same seam.
# Linear intake (issue #1036) is *also* a human labelling an issue in another
# tracker, so it shares the HUMAN_GITHUB writer class (and its rate-limit budget)
# by design — it flows through the SAME entrance gate, not a second one. Listed
# explicitly (rather than relying on the default) so the equivalence is an
# intentional decision, not an accident of the fallback.
_SOURCE_TO_WRITER: Dict[str, WriterClass] = {
    "github": WriterClass.HUMAN_GITHUB,
    "linear": WriterClass.HUMAN_GITHUB,
    "eval": WriterClass.EVAL_AUTOTICKET,
    "jace": WriterClass.JACE,
}


def _writer_for_source(source: str) -> WriterClass:
    """The rate-limit writer class for a queue source (defaults to human-github)."""
    return _SOURCE_TO_WRITER.get(source, WriterClass.HUMAN_GITHUB)

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
        # The Input-Contract v2 admission ledger (issue #1026, Blocker 1): the
        # dedup hashes + per-writer counts, threaded forward across every enqueue.
        # It lives on the store instance so it PERSISTS across poll/dispatch sweeps
        # within a runtime process — the reason the live loop (which admits through
        # this single seam) now actually runs dedup + rate-limit, not just the
        # test-only dispatcher.py. Only used when the v2 flag is ON; every enqueue
        # swaps in the next ledger the gate returns.
        self._ledger: AdmissionLedger = AdmissionLedger()

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

        Input-Contract v2 (issue #1026, behind the default-OFF ``_V2_FLAG``): when
        enabled, this ALSO threads the store's persistent :class:`AdmissionLedger`
        through the gate so duplicate-content dedup (AC2) and per-writer rate
        limiting (AC3) actually run on the live loop — this is the single seam both
        the poller and the webhook admit through. A positive injection screen, a
        duplicate, or a writer over its limit is PARKED (a durable, operator-visible
        ``queue_entries`` row in the PARKED state carrying a human-readable reason),
        never a silent drop. With the flag OFF, intake is byte-for-byte the legacy
        behaviour: the stateless gate hard-REJECTs and no ledger is threaded.
        """
        number = _entry_number(workspace_id, source, external_id)

        if _v2_enabled():
            # v2 path: thread the persistent ledger (dedup + rate-limit) and PARK —
            # never drop — an injection/dup/rate-limit hit for human review.
            admission = input_contract.admit_to_queue(
                number=number,
                issue_body=body,
                blocked_by=blocked_by,
                writer=_writer_for_source(source),
                ledger=self._ledger,
                injection_park=True,
            )
            assert isinstance(admission, Admission)  # ledger supplied ⇒ Admission
            self._ledger = admission.ledger  # thread the next ledger forward
            if admission.is_rejected:
                # Only a missing machine-checkable-AC reject reaches here now
                # (injection parks under injection_park); keep the legacy contract:
                # no row for an un-admittable issue.
                return admission.rejected  # type: ignore[return-value]
            gated: Union[QueueEntry, Rejected] = admission.entry  # type: ignore[assignment]
        else:
            # Legacy path (flag OFF): unchanged from before this PR.
            gated = input_contract.admit_to_queue(  # type: ignore[assignment]
                number=number, issue_body=body, blocked_by=blocked_by
            )
            if isinstance(gated, Rejected):
                return gated  # GATE: no row for an issue without machine-checkable AC

        # Tracks ONLY a v2 guardrail park (injection/dup/rate-limit) — distinct
        # from a dependency park, which ``admit`` below can ALSO produce. The
        # alignment gate below (#1274 PR③) must still run for a dependency
        # park (mirrors ``enqueueGithubIssue``'s finding-1 fix), just never
        # for a v2-guardrail park — there is no automatic unpark for a
        # guardrail park, so that interaction bug cannot occur the same way
        # (out of this fix's scope, mirrors the TS ``v2Parked`` short-circuit
        # exactly).
        v2_parked = isinstance(gated, QueueEntry) and gated.state is QueueState.PARKED

        # Park if any blocked-by dependency is unmet (pure decision). ``admit``
        # preserves a gate park (dup/rate-limit/injection): it will not resurrect a
        # PARKED entry that already carries a reason to QUEUED.
        entry = admit(gated, open_blockers=blocked_by)

        # Alignment gate (#1274 PR③ — the Python mirror of enqueueGithubIssue's
        # admission hold). Evaluated INDEPENDENTLY of the dependency outcome
        # above (a dependency park must NOT skip alignment), but skipped
        # entirely for a v2-guardrail park (mirrors TS's ``!v2Parked`` guard).
        #
        # No brief posting from here (locked design point 1): this module has
        # no Telegram/console access — parking honestly with the right
        # reason/state is the whole job; the console reconciler
        # (``apps/console/lib/alignment-reconciler.ts::reconcileAlignmentBriefs``)
        # is what later finds this row (state='parked', estimated_budget_usd
        # IS NULL, no jace_approvals row referencing it) and posts its brief.
        #
        # `kind` is always 'issue' for every Python-admitted row: this
        # function has no `kind` parameter and `insert_entry` never sets that
        # column, so the table's own DEFAULT 'issue' applies unconditionally
        # (Python has no onboard-kind equivalent — that is TS-only, via
        # `enqueueOnboard`). "No sanctioned values exist for it" is likewise
        # always true for a FRESH row here: Python never writes
        # estimated_budget_usd/model_override on insert (no equivalent of
        # TS's confirmed-brief URL-match lookup — out of this PR's scope), so
        # `aligned` reduces to exactly "workspace does not require it".
        if not v2_parked:
            aligned = not self._workspace_requires_alignment(workspace_id)
            entry = apply_admission_alignment(entry, aligned=aligned)

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
                # Issue #1239: persist the pure state machine's human-readable
                # park reason (set by ``queue_state.admit`` for a blocked-by
                # dependency, or by the Input-Contract v2 gate for a duplicate/
                # rate-limit/injection park) so a later read — the console Work
                # page — can show WHY without needing this enqueue call's return
                # value. Empty string (a QUEUED/RUNNING entry) persists as NULL.
                "park_reason": entry.reason or None,
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

    def _workspace_requires_alignment(self, workspace_id: str) -> bool:
        """Read a workspace's ``require_alignment`` flag (#1274 PR③).

        Mirrors ``github_intake.ts``'s ``workspaceRequiresAlignment`` exactly,
        INCLUDING its fail-closed default: a missing workspace row (the
        lookup returns zero rows) reads as ``True`` ("still gate"), not
        ``False`` — the safer direction, and the Python/TS lockstep default.
        A real Postgres row for a truly nonexistent workspace_id can never be
        written in the first place (``queue_entries.workspace_id`` is a
        ``NOT NULL`` FK onto ``workspaces.id`` — see the migration and
        ``schema/workspaces.ts``), so this branch is defensive/moot in
        practice for the real executor; it matters for keeping the two
        writers' DEFAULT POSTURE identical, not for a reachable production
        gap.

        VERIFIED while building this PR (see the task report): both real
        Python call sites (``agentrail/heartbeat/webhook.py``,
        ``agentrail/heartbeat/runtime.py``) hard-require a non-empty
        ``workspace_id`` (env/CLI-flag validated) before ``enqueue`` is ever
        reached — there is no live path where a Python-admitted row carries
        no workspace binding at all.
        """
        rows = self._exec.query(
            "workspace_require_alignment", {"workspace_id": workspace_id}
        )
        if not rows:
            return True
        value = rows[0].get("require_alignment")
        return True if value is None else bool(value)

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
                # Issue #1239: ``transition`` never operates on a PARKED entry
                # (queue_state.transition raises), so by construction every
                # entry reaching this method carries reason="" — this write is
                # the clear-on-unpark side of the contract, defensively kept in
                # lockstep with ``insert_entry`` rather than assumed.
                "park_reason": entry.reason or None,
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
        # Issue #1239: rehydrate the persisted park reason so a resumed/re-read
        # entry (list_queue, next_grabbable) keeps its human-readable reason
        # instead of silently losing it to the dataclass's "" default.
        reason = str(row.get("park_reason") or "")
        return QueueEntry(
            number=number,
            tier=Tier(int(row["tier"])),
            remaining_budget=int(row["remaining_budget"]),
            state=state,
            blocked_by=blocked,
            reason=reason,
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

# Params whose SQL placeholder now casts ``::jsonb`` (see ``_SQL``'s own
# comment): pre-serialize them to a JSON string here, driver-agnostically,
# rather than relying on psycopg2's default Python-list adapter — which
# targets Postgres ARRAY syntax, not JSON, and either mis-stores an empty
# list as ``{}`` (a jsonb OBJECT, not ``[]``) or outright fails to cast a
# non-empty one (``cannot cast type integer[] to jsonb``). Found and fixed
# while building #1274 PR③'s live dev-DB proof — this class was previously
# `# pragma: no cover` end to end, so nothing had ever round-tripped a real
# ``blocked_by`` value through a genuine Postgres connection before.
_JSONB_PARAMS = ("blocked_by",)


def _jsonb_params(params: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy of ``params`` with every jsonb-bound value pre-serialized
    to a JSON string, ready for a ``%(name)s::jsonb`` placeholder. Only
    touches the params dict; leaves the caller's own dict (and the
    ``FakeExecutor``s in tests, which never call this) untouched."""
    out = dict(params)
    for key in _JSONB_PARAMS:
        if key in out:
            out[key] = json.dumps(out[key])
    return out


_SQL = {
    # ON CONFLICT DO NOTHING — re-enqueuing an issue that already has a row is a
    # NO-OP, never a resurrection. This is the money-burn fix: the poller re-polls
    # every still-OPEN trigger-labeled issue every cycle, and an issue stays open
    # (PR not yet merged / label not yet removed) AFTER its run reached a terminal
    # state. The old `DO UPDATE SET ... state = EXCLUDED.state` reset that terminal
    # row back to 'queued' (and refilled budget/reset tier), so next_grabbable
    # re-grabbed it and the loop re-ran a done issue every cycle, burning money.
    # Lifecycle columns (state/remaining_budget/tier) are owned by the dispatcher's
    # transitions, never by re-enqueue. Mirrors the TS path's onConflictDoNothing
    # (packages/db-postgres .../github_intake.ts).
    # ``blocked_by`` casts an explicit ``::jsonb`` (issue found + fixed while
    # building #1274 PR③'s live dev-DB proof — see PostgresExecutor.execute's
    # own comment): the param arrives pre-serialized to a JSON string, so this
    # cast is what turns it back into the column's real ``jsonb`` type,
    # driver-agnostically (no psycopg-version-specific wrapper needed).
    "insert_entry": (
        "INSERT INTO queue_entries "
        "(id, workspace_id, source, external_id, title, body, tier, "
        " remaining_budget, state, blocked_by, park_reason, created_at, updated_at) "
        "VALUES (%(id)s, %(workspace_id)s, %(source)s, %(external_id)s, "
        " %(title)s, %(body)s, %(tier)s, %(remaining_budget)s, %(state)s, "
        " %(blocked_by)s::jsonb, %(park_reason)s, %(created_at)s, %(updated_at)s) "
        "ON CONFLICT (id) DO NOTHING"
    ),
    "update_entry": (
        "UPDATE queue_entries SET tier = %(tier)s, "
        " remaining_budget = %(remaining_budget)s, state = %(state)s, "
        " blocked_by = %(blocked_by)s::jsonb, park_reason = %(park_reason)s, "
        " updated_at = %(updated_at)s "
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
        " remaining_budget, state, blocked_by, park_reason, created_at, updated_at "
        "FROM queue_entries WHERE workspace_id = %(workspace_id)s "
        "ORDER BY created_at ASC"
    ),
    "next_grabbable": (
        "SELECT id, workspace_id, source, external_id, title, body, tier, "
        " remaining_budget, state, blocked_by, park_reason, created_at, updated_at "
        "FROM queue_entries WHERE workspace_id = %(workspace_id)s "
        "AND state = 'queued' ORDER BY created_at ASC LIMIT 1"
    ),
    # #1274 PR③: the alignment gate's one new read. Mirrors the TS
    # ``workspaceRequiresAlignment`` lookup exactly (same column, same
    # single-row-by-id shape) so both writers resolve the identical fact.
    "workspace_require_alignment": (
        "SELECT require_alignment FROM workspaces WHERE id = %(workspace_id)s"
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
            cur.execute(_SQL[op], _jsonb_params(params))
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
