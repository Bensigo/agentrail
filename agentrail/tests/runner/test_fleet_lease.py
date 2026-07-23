"""Tests for the single-active-fleet lease (agentrail/runner/fleet_lease.py, #1390).

Hermetic and deterministic: two :class:`FleetLease` instances share ONE
:class:`InMemoryLeaseExecutor` with an injectable clock, which models the exact
acquire/renew/steal truth table the Postgres statement implements. No live DB,
no real time, no threads — a controllable clock stands in for "time passing
while a killed holder stops renewing," so the AC1/AC2/AC4 handoff behavior is
verified exactly as Postgres' ``expires_at <= now()`` would decide it.
"""
from __future__ import annotations

from typing import List

from agentrail.runner.fleet_lease import (
    DEFAULT_LEASE_TTL_SECONDS,
    FleetLease,
    InMemoryLeaseExecutor,
    run_lease_loop,
)


class _Clock:
    """A hand-cranked monotonic clock: ``advance`` moves time forward."""

    def __init__(self, t: float = 0.0) -> None:
        self.t = float(t)

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += float(dt)


class _ScriptedStop:
    """threading.Event stand-in: wait(timeout) replays scripted returns
    (False = tick proceeds, True = shutdown) and records the timeouts."""

    def __init__(self, script: List[bool]) -> None:
        self._script = list(script)
        self.waits: List[float] = []

    def wait(self, timeout: float) -> bool:
        self.waits.append(timeout)
        return self._script.pop(0) if self._script else True


def _lease(ex, holder, ttl=30.0):
    return FleetLease(ex, holder=holder, ttl_seconds=ttl)


# --- AC1: exactly one active, the other standby ------------------------------


def test_ac1_two_workers_one_db_exactly_one_active_one_standby():
    clock = _Clock()
    ex = InMemoryLeaseExecutor(now=clock)
    a = _lease(ex, "A")
    b = _lease(ex, "B")

    # A contends first and wins; B contends and stands by.
    assert a.acquire_or_renew() is True
    assert b.acquire_or_renew() is False

    assert a.is_held() is True
    assert b.is_held() is False
    assert ex.current_holder() == "A"


def test_ac1_holder_keeps_the_lease_across_renewals_standby_never_steals_a_live_one():
    clock = _Clock()
    ex = InMemoryLeaseExecutor(now=clock)
    a = _lease(ex, "A", ttl=30)
    b = _lease(ex, "B", ttl=30)
    assert a.acquire_or_renew() is True
    assert b.acquire_or_renew() is False

    # A renews well within the TTL every poll; B can never take a live lease.
    for _ in range(5):
        clock.advance(10)  # a third of the TTL — a normal renewal cadence
        assert a.acquire_or_renew() is True
        assert b.acquire_or_renew() is False
    assert ex.current_holder() == "A"


def test_ac1_order_independent_whoever_gets_there_first_wins():
    clock = _Clock()
    ex = InMemoryLeaseExecutor(now=clock)
    a = _lease(ex, "A")
    b = _lease(ex, "B")
    # B contends first this time.
    assert b.acquire_or_renew() is True
    assert a.acquire_or_renew() is False
    assert ex.current_holder() == "B"


# --- AC2: clean handoff within one TTL after the holder stops ----------------


def test_ac2_standby_takes_over_within_one_ttl_after_holder_is_killed():
    clock = _Clock()
    ex = InMemoryLeaseExecutor(now=clock)
    a = _lease(ex, "A", ttl=30)
    b = _lease(ex, "B", ttl=30)
    assert a.acquire_or_renew() is True   # A holds, expires_at = 30
    assert b.acquire_or_renew() is False

    # A is killed at t=0 and never renews again. Just before the TTL elapses,
    # B still cannot take the lease — no premature failover.
    clock.advance(29)
    assert b.acquire_or_renew() is False

    # Once the TTL elapses the lease is expired; B steals it on its next poll —
    # no manual unlock, no intervention.
    clock.advance(1)  # t = 30 == expires_at -> expired
    assert b.acquire_or_renew() is True
    assert b.is_held() is True
    assert ex.current_holder() == "B"


def test_ac2_release_hands_over_immediately_without_waiting_out_the_ttl():
    clock = _Clock()
    ex = InMemoryLeaseExecutor(now=clock)
    a = _lease(ex, "A", ttl=30)
    b = _lease(ex, "B", ttl=30)
    assert a.acquire_or_renew() is True
    assert b.acquire_or_renew() is False

    # Graceful shutdown releases the lease; the standby takes over on its very
    # next poll, no TTL wait (this is what makes a clean deploy handoff fast).
    a.release()
    assert a.is_held() is False
    assert b.acquire_or_renew() is True
    assert ex.current_holder() == "B"


# --- AC4: single-instance restart recovers within one TTL --------------------


def test_ac4_single_instance_restart_recovers_within_one_ttl():
    clock = _Clock()
    ex = InMemoryLeaseExecutor(now=clock)
    old = _lease(ex, "proc-old", ttl=30)
    assert old.acquire_or_renew() is True  # expires_at = 30

    # The process crashes at t=0 and restarts at t=5 as a FRESH process (new
    # holder id) against its own still-unexpired stale lease.
    clock.advance(5)
    new = _lease(ex, "proc-new", ttl=30)
    assert new.acquire_or_renew() is False  # the stale lease is still live

    # Within one TTL of the crash the stale lease expires and the restarted
    # process recovers on its own — no manual unlock.
    clock.advance(25)  # t = 30 -> old lease expired
    assert new.acquire_or_renew() is True
    assert ex.current_holder() == "proc-new"


def test_ac4_a_lone_instance_reacquires_its_own_lease_every_poll_no_flapping():
    # Running alone (the common case): the single instance holds and renews its
    # own lease forever, and every renewal is a no-op hold — never a handoff.
    clock = _Clock()
    ex = InMemoryLeaseExecutor(now=clock)
    solo = _lease(ex, "solo", ttl=30)
    holds = [solo.acquire_or_renew()]
    for _ in range(10):
        clock.advance(10)
        holds.append(solo.acquire_or_renew())
    assert all(holds)
    assert ex.current_holder() == "solo"


def test_ac4_acquire_fails_open_on_executor_error_no_new_failure_mode_alone():
    class _Boom:
        def acquire(self, *a):
            raise RuntimeError("db unreachable")

        def release(self, *a):
            pass

    lease = FleetLease(_Boom(), ttl_seconds=30)
    # A DB blip must not stand a lone fleet down — it assumes active and keeps
    # serving. This is the AC4 "adds no new failure mode when running alone".
    assert lease.acquire_or_renew() is True
    assert lease.is_held() is True
    # Repeated errors keep it active (and don't raise).
    assert lease.acquire_or_renew() is True


def test_holder_id_is_unique_per_process():
    ex = InMemoryLeaseExecutor()
    a = FleetLease(ex)
    b = FleetLease(ex)
    assert a.holder != b.holder  # distinct processes must be distinguishable


def test_renew_interval_is_a_third_of_the_ttl():
    ex = InMemoryLeaseExecutor()
    lease = FleetLease(ex, ttl_seconds=30)
    assert lease.renew_interval == 10.0
    assert lease.ttl_seconds == 30.0
    assert FleetLease(ex).ttl_seconds == DEFAULT_LEASE_TTL_SECONDS


# --- run_lease_loop: promotion / demotion transitions ------------------------


def test_lease_loop_fires_on_promote_exactly_once_on_standby_to_active():
    clock = _Clock()
    ex = InMemoryLeaseExecutor(now=clock)
    holder = _lease(ex, "holder", ttl=30)
    assert holder.acquire_or_renew() is True
    standby = _lease(ex, "standby", ttl=30)
    assert standby.acquire_or_renew() is False

    # The holder dies: advance past the TTL so the standby can steal on its next
    # renewal tick.
    clock.advance(31)

    promoted: List[bool] = []
    demoted: List[bool] = []
    stop = _ScriptedStop([False, False, True])  # two ticks, then shutdown
    run_lease_loop(
        standby,
        stop,
        renew_interval=10.0,
        on_promote=lambda: promoted.append(True),
        on_demote=lambda: demoted.append(True),
        was_active=False,
    )
    assert promoted == [True]  # promoted once, not on every subsequent renewal
    assert demoted == []
    assert standby.is_held() is True
    assert stop.waits == [10.0, 10.0, 10.0]  # paced at the renew interval


def test_lease_loop_fires_on_demote_when_the_lease_is_lost():
    clock = _Clock()
    ex = InMemoryLeaseExecutor(now=clock)
    a = _lease(ex, "A", ttl=30)
    assert a.acquire_or_renew() is True
    # A stalls past its TTL and B steals the lease.
    clock.advance(31)
    b = _lease(ex, "B", ttl=30)
    assert b.acquire_or_renew() is True

    demoted: List[bool] = []
    stop = _ScriptedStop([False, True])
    run_lease_loop(
        a,
        stop,
        renew_interval=10.0,
        on_demote=lambda: demoted.append(True),
        was_active=True,
    )
    assert demoted == [True]
    assert a.is_held() is False


def test_lease_loop_active_holder_never_fires_promote():
    # A steadily-active holder (was_active=True, keeps renewing) never triggers
    # on_promote — the transition callbacks fire only on real state CHANGES.
    clock = _Clock()
    ex = InMemoryLeaseExecutor(now=clock)
    solo = _lease(ex, "solo", ttl=30)
    assert solo.acquire_or_renew() is True
    promoted: List[bool] = []
    stop = _ScriptedStop([False, False, False, True])
    run_lease_loop(
        solo, stop, renew_interval=10.0, on_promote=lambda: promoted.append(True), was_active=True
    )
    assert promoted == []
    assert solo.is_held() is True
