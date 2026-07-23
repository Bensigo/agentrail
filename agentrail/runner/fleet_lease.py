"""Single-active-fleet lease — deploy-overlap safety (issue #1390).

## Why this exists

The hosted fleet (:mod:`agentrail.runner.fleet_worker`) is documented as a
1-replica service (``deploy/fleet/README.md``): its on-disk per-workspace
token store (:mod:`agentrail.runner.fleet_credentials`) is last-writer-wins,
and its ``os.replace`` write is *atomicity*, not *coordination*. But Railway
overlaps the OLD and NEW container on **every deploy**, so "two live fleets at
once" is a routine event, not a misconfiguration. During that overlap two
fleets both sync tokens (racing each other's mints — a freshly minted,
hash-only, unrecoverable token can be silently clobbered) and both perform any
future fleet-singleton work.

Claims themselves are already overlap-safe — the backend claims with
``FOR UPDATE SKIP LOCKED`` (``packages/db-postgres/src/queries/runner.ts``), so
no queue row is ever double-claimed. The UNPROTECTED surfaces are token-store
sync and fleet-singleton work. This module closes them with a
**single-active-fleet lease**: exactly one fleet instance is "active" (claims +
syncs tokens) at a time; the rest stand by and poll to take over.

## Mechanism: a TTL lease ROW (not a Postgres advisory lock)

Both were on the table (see the issue). This picks a **TTL lease row** —
one row in ``fleet_leases`` keyed by a lease name, carrying the current
``holder`` and an ``expires_at`` — for four concrete reasons:

1. **The acceptance criteria describe TTL-row semantics literally.** AC4 says a
   restart recovers "against its own unexpired stale lease ... within one TTL,"
   and the crash story is "a stale lease self-expires — no manual unlock ever."
   An advisory lock has no *stale* lease to recover against: it vanishes the
   instant its connection closes. A TTL row is exactly the object AC4 talks
   about.
2. **Hermetic testability.** The acquire/renew/steal decision is a single
   atomic SQL statement whose semantics are mirrored byte-for-byte by
   :class:`InMemoryLeaseExecutor` with an injectable clock — so AC1 (one active,
   one standby), AC2 (handoff within one TTL), and AC4 (single-instance
   restart) are all deterministic pytest without a live Postgres, matching this
   repo's hermetic-fake convention (``agentrail.afk.queue_store``'s
   ``Executor`` / ``PostgresExecutor`` split). ``pg_try_advisory_lock`` is a
   server primitive that would force a live DB into the test.
3. **No held connection to babysit.** An advisory lock must keep one dedicated
   session open for the lock's whole lifetime; if that connection blips the
   lock is silently lost. The TTL row is stateless per sweep — each renewal is
   one independent statement — so a transient connection blip just retries.
4. **Survives crash cleanly anyway.** A crashed holder stops renewing; its row
   expires after the TTL and a standby steals it. No manual unlock, ever
   (same guarantee the advisory lock's connection-close gives, reached a
   different way).

The one cost — a migration (``0045_fleet_lease.sql``) — is cheap and the slot
was pre-assigned for exactly this.

## The atomic acquire/renew/steal statement

One statement decides everything, race-free, in the database:

    INSERT INTO fleet_leases (name, holder, acquired_at, expires_at)
    VALUES (:name, :holder, now(), now() + :ttl)
    ON CONFLICT (name) DO UPDATE
        SET holder = EXCLUDED.holder,
            acquired_at = CASE WHEN fleet_leases.holder = EXCLUDED.holder
                               THEN fleet_leases.acquired_at ELSE now() END,
            expires_at  = EXCLUDED.expires_at
        WHERE fleet_leases.holder = EXCLUDED.holder      -- renew my own, OR
           OR fleet_leases.expires_at <= now()           -- steal an expired one
    RETURNING holder;

- No row yet            -> INSERT           -> RETURNING me   -> I hold it.
- Row is mine           -> UPDATE (renew)   -> RETURNING me   -> I hold it.
- Row is someone's, expired -> UPDATE (steal)-> RETURNING me  -> I hold it.
- Row is someone's, live -> WHERE false, no update -> RETURNING () -> STANDBY.

So "did I get the lease?" is simply "did the statement return a row?" —
:meth:`FleetLease.acquire_or_renew` reads exactly that.

## Holder identity is per-PROCESS, on purpose

Each :class:`FleetLease` mints a fresh ``holder`` id at construction (a uuid,
prefixed with the hostname only for operator-legible logs). It is deliberately
NOT stable across restarts:

- **AC1 / deploy overlap** needs the OLD and NEW deploy processes to be
  DISTINGUISHABLE, so exactly one wins the live lease and the other stands by.
  A volume-persisted id would make an overlapping old+new pair present the SAME
  id and both believe they hold it — the exact split we're preventing.
- **AC4** ("restart recovers within one TTL") is satisfied by a per-process id:
  a restarted lone instance presents a new id, sees its predecessor's row still
  unexpired, stands by for at most one TTL, then steals the expired row and
  resumes. "Within one TTL" is precisely the bound AC4 states.

## Failure posture: fail-OPEN

If the lease query itself errors (DB unreachable),
:meth:`acquire_or_renew` returns ``True`` (assume active). This is deliberate:
AC4 requires the lease adds "no new failure mode when running alone," and a lone
fleet must not stand itself down on a transient DB blip. The cost is that during
a DB outage two overlapping instances both fail-open (a brief split-brain) — but
that reverts precisely to today's pre-lease behavior, which is already
tolerated: claims stay ``SKIP LOCKED``-safe and only token-sync races, exactly
the routine deploy-overlap state this lease improves on the happy path. It never
makes things WORSE than today, and it self-heals to a single holder within one
TTL once the DB is reachable again.
"""
from __future__ import annotations

import logging
import os
import socket
import threading
import uuid
from typing import Any, Callable, Dict, List, Optional, Protocol

_log = logging.getLogger("agentrail.runner.fleet_lease")

# The one lease every fleet instance contends for. A string (not a magic
# integer like an advisory-lock key would need) so the row is self-describing
# in ``SELECT * FROM fleet_leases``.
FLEET_LEASE_NAME = "fleet-singleton"

# Default lease lifetime and the renewal cadence derived from it. A modest TTL
# keeps the deploy-handoff gap (and a lone instance's post-restart recovery
# gap) small; renewing at a third of the TTL means two renewals can fail
# (transient DB blips) before the lease is at risk of expiring under the
# holder.
DEFAULT_LEASE_TTL_SECONDS = 30.0
_RENEW_FRACTION = 3.0


class LeaseExecutor(Protocol):
    """The tiny DB vocabulary the lease needs, injectable so the mechanics are
    hermetically testable. :class:`PostgresLeaseExecutor` is the real edge;
    :class:`InMemoryLeaseExecutor` mirrors its semantics for tests.
    """

    def acquire(self, name: str, holder: str, ttl_seconds: float) -> List[Dict[str, Any]]:
        """Run the atomic acquire/renew/steal statement. Return the RETURNING
        rows: a one-element list ``[{"holder": holder}]`` if THIS holder now
        holds the lease, or an empty list if another instance holds a live one.
        """
        ...

    def release(self, name: str, holder: str) -> None:
        """Delete the lease row iff ``holder`` still owns it (a clean handoff on
        graceful shutdown; a no-op if we already lost it)."""
        ...


class FleetLease:
    """A single-active-fleet lease. Thread-safe; one instance per fleet process.

    Construct with a :class:`LeaseExecutor`. Call :meth:`acquire_or_renew`
    on a cadence (see :func:`run_lease_loop`); read :meth:`is_held` from the
    hot claim path (cheap, no DB). :meth:`release` on graceful shutdown hands
    the lease over immediately rather than making a standby wait out the TTL.
    """

    def __init__(
        self,
        executor: LeaseExecutor,
        *,
        name: str = FLEET_LEASE_NAME,
        holder: Optional[str] = None,
        ttl_seconds: float = DEFAULT_LEASE_TTL_SECONDS,
    ) -> None:
        self._executor = executor
        self._name = name
        self._holder = holder or self._mint_holder_id()
        self._ttl_seconds = float(ttl_seconds)
        self._lock = threading.Lock()
        self._held = False
        # Rate-limit the fail-open warning to once per error episode (not once
        # per renewal tick) so a DB outage doesn't flood the log.
        self._in_error = False

    @staticmethod
    def _mint_holder_id() -> str:
        # Hostname prefix is purely for operator-legible logs ("which container
        # holds it?"); the uuid guarantees per-process uniqueness even if two
        # overlapping deploy containers share a hostname.
        try:
            host = socket.gethostname() or "fleet"
        except OSError:
            host = "fleet"
        return f"{host}-{uuid.uuid4().hex[:12]}"

    @property
    def holder(self) -> str:
        return self._holder

    @property
    def ttl_seconds(self) -> float:
        return self._ttl_seconds

    @property
    def renew_interval(self) -> float:
        """How often to call :meth:`acquire_or_renew` — a third of the TTL, so
        the holder refreshes well before expiry and a couple of transient
        failures are survivable."""
        return max(1.0, self._ttl_seconds / _RENEW_FRACTION)

    def acquire_or_renew(self) -> bool:
        """Try to acquire (or renew, or steal-if-expired) the lease. Returns
        whether THIS instance now holds it. Fails OPEN (returns ``True``) on any
        executor error — a lone fleet must not stand down on a DB blip (AC4);
        see the module docstring's failure-posture note.
        """
        try:
            rows = self._executor.acquire(self._name, self._holder, self._ttl_seconds)
            held = bool(rows)
            if self._in_error:
                self._in_error = False
                _log.info("fleet lease: DB reachable again; lease coordination resumed")
        except Exception as exc:  # noqa: BLE001 - a DB blip must never crash/stand down the fleet
            held = True  # fail OPEN — see module docstring
            if not self._in_error:
                self._in_error = True
                _log.warning(
                    "fleet lease: could not reach the lease store (%s) — assuming "
                    "ACTIVE so a lone fleet keeps serving; coordination resumes "
                    "when the DB is reachable",
                    exc,
                )
        with self._lock:
            self._held = held
        return held

    def is_held(self) -> bool:
        """The last known hold state — read this from the hot path; no DB call."""
        with self._lock:
            return self._held

    def release(self) -> None:
        """Best-effort release on graceful shutdown so a standby takes over at
        once instead of waiting a full TTL. Never raises."""
        try:
            self._executor.release(self._name, self._holder)
        except Exception as exc:  # noqa: BLE001 - shutdown must not raise
            _log.debug("fleet lease: release failed (harmless, lease self-expires): %s", exc)
        with self._lock:
            self._held = False


def run_lease_loop(
    lease: FleetLease,
    stop: threading.Event,
    *,
    renew_interval: Optional[float] = None,
    on_promote: Callable[[], None] = lambda: None,
    on_demote: Callable[[], None] = lambda: None,
    was_active: bool = False,
    log: Callable[[str], None] = lambda msg: _log.info("%s", msg),
) -> None:
    """Renew the lease on a cadence until ``stop`` is set, firing ``on_promote``
    on a standby->active transition and ``on_demote`` on active->standby.

    ``stop.wait(timeout)`` both paces the loop AND is the shutdown signal (it
    returns ``True`` immediately when ``stop`` is set), the same shape
    :func:`agentrail.cli.commands.fleet._run_sync_loop` uses. ``was_active`` is
    the boot-time hold state so the FIRST post-boot transition is detected
    correctly (a fleet that booted active shouldn't fire ``on_promote`` on its
    first renewal). Module-level so tests drive ticks with a scripted stop
    event — no real thread, no real sleep.
    """
    interval = renew_interval if renew_interval is not None else lease.renew_interval
    prev = was_active
    while not stop.wait(interval):
        active = lease.acquire_or_renew()
        if active and not prev:
            log(
                f"fleet lease: acquired (holder={lease.holder}) — this instance "
                "is now ACTIVE and resuming claims/token-sync"
            )
            on_promote()
        elif prev and not active:
            log(
                "fleet lease: lost to another instance — this instance is now on "
                "STANDBY, claiming nothing and polling to take over"
            )
            on_demote()
        prev = active


# --- Real Postgres edge ------------------------------------------------------

# The atomic acquire/renew/steal statement (see the module docstring for the
# full truth table). ``make_interval(secs => ...)`` builds the TTL interval from
# a float-seconds bind param without string-formatting SQL.
_ACQUIRE_SQL = """
INSERT INTO fleet_leases (name, holder, acquired_at, expires_at)
VALUES (%(name)s, %(holder)s, now(), now() + make_interval(secs => %(ttl)s))
ON CONFLICT (name) DO UPDATE
    SET holder = EXCLUDED.holder,
        acquired_at = CASE WHEN fleet_leases.holder = EXCLUDED.holder
                           THEN fleet_leases.acquired_at ELSE now() END,
        expires_at  = EXCLUDED.expires_at
    WHERE fleet_leases.holder = EXCLUDED.holder
       OR fleet_leases.expires_at <= now()
RETURNING holder
"""

_RELEASE_SQL = "DELETE FROM fleet_leases WHERE name = %(name)s AND holder = %(holder)s"


class PostgresLeaseExecutor:
    """A :class:`LeaseExecutor` backed by the app's Postgres (same
    ``DATABASE_URL``). Lazily imports a DB-API driver (``psycopg`` then
    ``psycopg2``) so importing this module never requires a driver — tests use
    :class:`InMemoryLeaseExecutor` and never touch this path. Mirrors
    ``agentrail.afk.queue_store.PostgresExecutor`` exactly (same lazy-driver,
    same lazy-connection shape).
    """

    def __init__(self, dsn: Optional[str] = None) -> None:
        self._dsn = dsn or os.environ.get(
            "DATABASE_URL", "postgres://agentrail:agentrail@localhost:5432/agentrail"
        )
        self._connect = _load_driver()
        self._conn = None

    def _connection(self):  # pragma: no cover - needs a live DB
        if self._conn is None:
            self._conn = self._connect(self._dsn)
        return self._conn

    def acquire(self, name: str, holder: str, ttl_seconds: float) -> List[Dict[str, Any]]:  # pragma: no cover - needs a live DB
        conn = self._connection()
        try:
            with conn.cursor() as cur:
                cur.execute(_ACQUIRE_SQL, {"name": name, "holder": holder, "ttl": float(ttl_seconds)})
                rows = cur.fetchall()
            conn.commit()
        except Exception:
            # A failed statement leaves the connection in an aborted
            # transaction; drop it so the next renewal reconnects cleanly rather
            # than erroring forever on a half-dead connection.
            self._discard_connection(conn)
            raise
        return [{"holder": r[0]} for r in rows]

    def release(self, name: str, holder: str) -> None:  # pragma: no cover - needs a live DB
        conn = self._connection()
        try:
            with conn.cursor() as cur:
                cur.execute(_RELEASE_SQL, {"name": name, "holder": holder})
            conn.commit()
        except Exception:
            self._discard_connection(conn)
            raise

    def _discard_connection(self, conn) -> None:  # pragma: no cover - needs a live DB
        try:
            conn.rollback()
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass
        if conn is self._conn:
            self._conn = None


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
            "PostgresLeaseExecutor needs a DB-API driver (psycopg or psycopg2). "
            "Install one, or inject a custom executor for tests."
        ) from exc


# --- Hermetic in-memory edge (the canonical spec the SQL mirrors) ------------


class InMemoryLeaseExecutor:
    """A :class:`LeaseExecutor` that models the ``_ACQUIRE_SQL`` truth table in
    memory with an injectable clock. This is the authoritative Python statement
    of the lease contract — the Postgres statement above mirrors it (and vice
    versa) — so tests exercise the exact same acquire/renew/steal decisions the
    database would make, deterministically and without a live DB.

    Two :class:`FleetLease` instances sharing ONE of these share the store and
    the clock, which is what makes the two-worker AC1/AC2/AC4 tests hermetic:
    advance the clock to model time passing while a killed holder stops
    renewing, and a standby's next ``acquire`` steals the expired row exactly as
    Postgres' ``expires_at <= now()`` would.
    """

    def __init__(self, *, now: Optional[Callable[[], float]] = None) -> None:
        import time as _time

        self._now = now or _time.monotonic
        self._rows: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()

    def acquire(self, name: str, holder: str, ttl_seconds: float) -> List[Dict[str, Any]]:
        with self._lock:
            t = self._now()
            row = self._rows.get(name)
            if row is None:
                # No row yet -> INSERT.
                self._rows[name] = {"holder": holder, "acquired_at": t, "expires_at": t + ttl_seconds}
                return [{"holder": holder}]
            mine = row["holder"] == holder
            expired = row["expires_at"] <= t
            if mine or expired:
                # Renew my own (keep acquired_at) or steal an expired one (reset it).
                acquired_at = row["acquired_at"] if mine else t
                self._rows[name] = {"holder": holder, "acquired_at": acquired_at, "expires_at": t + ttl_seconds}
                return [{"holder": holder}]
            # Held by another instance, still live -> standby.
            return []

    def release(self, name: str, holder: str) -> None:
        with self._lock:
            row = self._rows.get(name)
            if row is not None and row["holder"] == holder:
                self._rows.pop(name, None)

    # Read-only helpers for tests/introspection (not part of LeaseExecutor).
    def current_holder(self, name: str = FLEET_LEASE_NAME) -> Optional[str]:
        with self._lock:
            row = self._rows.get(name)
            return row["holder"] if row else None
