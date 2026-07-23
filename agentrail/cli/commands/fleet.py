"""``agentrail fleet`` — the hosted multi-workspace runner daemon (issue #1267).

Where ``agentrail runner`` (``agentrail/cli/commands/runner.py``) is one
machine claiming for the ONE workspace it logged into, ``agentrail fleet`` is
one process serving EVERY hosted-eligible workspace at once — the Railway
service definition in ``deploy/fleet/railway.json`` runs this as its
``startCommand``. It never runs ``agentrail login``; instead it authenticates
itself to the sync route with a shared operator secret and lets the console
tell it which per-workspace tokens to hold.

  agentrail fleet

Configuration is entirely via environment (documented below and in
``deploy/fleet/README.md`` — there is no flag surface, matching how
``agentrail runner`` is configured by ``agentrail login`` rather than flags):

  AGENTRAIL_SERVER_BASE_URL       required. The console's base URL.
  FLEET_CONSOLE_TOKEN             required. Shared secret for
                                  POST /api/v1/fleet/workspace-tokens/sync —
                                  NOT a per-workspace token; see #1267 PR ①'s
                                  route doc-comment. Never logged.
  AGENTRAIL_FLEET_HOME            optional, default ~/.agentrail. Directory
                                  the per-workspace token store
                                  (fleet-credentials.json) is written into.
                                  Deliberately the SAME default directory
                                  ``agentrail login`` uses for
                                  credentials.json (distinct filename avoids
                                  collision) so an existing runner volume
                                  mount covers the fleet's store too.
  FLEET_CONCURRENCY               optional, default 2. How many claims can
                                  execute at once across the WHOLE fleet
                                  (not per workspace).
  FLEET_SYNC_INTERVAL_SECONDS     optional, default 300, floor 30. How often
                                  to re-call the sync route after the initial
                                  boot sync. Values below 30 are clamped to
                                  30 (with a warning) — 0 or a tiny interval
                                  would busy-loop the console's sync endpoint.
  DATABASE_URL                    optional. When set, enables the
                                  single-active-fleet lease (#1390): exactly ONE
                                  fleet instance is active (claims + token sync)
                                  at a time, so overlapping deploy instances
                                  coordinate down to one active + standbys
                                  instead of racing the last-writer-wins token
                                  store. Unset -> lease coordination disabled ->
                                  this process runs as the sole active fleet,
                                  exactly as before (the current 1-replica
                                  assumption). Point it at the same Postgres the
                                  console uses. See agentrail/runner/fleet_lease.py.
  FLEET_LEASE_TTL_SECONDS         optional, default 30, floor 5. Only used when
                                  DATABASE_URL is set. The lease lifetime: after
                                  a holder dies, a standby takes over within
                                  ~one TTL (renewed every TTL/3). Smaller = faster
                                  handoff, more DB traffic.

IMPORTANT — do NOT set AGENTRAIL_WORKSPACE_ID in this process's own
environment. That var (see ``agentrail/cli/commands/afk.py``'s
``_WORKSPACE_ID_ENV``) exists ONLY to exempt an operator's OWN dogfood
workspace from the #1271 hosted-repo auto-merge quarantine guard. Every
per-workspace run this daemon executes inherits this process's OS environment
(``agentrail.cli.commands.runner._make_execute``'s ``run_env = dict(os.environ)``)
— if AGENTRAIL_WORKSPACE_ID were set here, it would leak into EVERY
fleet-served customer workspace's run, one operator-workspace-id at a time,
incorrectly telling each one it is exempt from that quarantine. Fleet-served
customer workspaces must always keep the guard; this var has no legitimate
value for this process and must never be set for it.

Boot-time sync failure (bad/missing FLEET_CONSOLE_TOKEN, or the console
unreachable) exits non-zero with a clear message — starting a daemon that
doesn't know which workspaces to serve would just spin uselessly. A PERIODIC
re-sync failure is not fatal: it's logged as a warning and the fleet keeps
serving whatever workspaces its last-good sync gave it.
"""
from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional

from agentrail.cli.commands.runner import _make_execute
from agentrail.runner.client import RunnerClient
from agentrail.runner.credentials import Credentials
from agentrail.runner.fleet_credentials import FleetWorkspaceToken, load_fleet_store
from agentrail.runner.fleet_lease import (
    DEFAULT_LEASE_TTL_SECONDS,
    FleetLease,
    PostgresLeaseExecutor,
    run_lease_loop,
)
from agentrail.runner.fleet_sync import FleetSyncError, run_sync_cycle
from agentrail.runner.fleet_worker import WorkspaceRotation, WorkspaceSlot, run_fleet_worker

# Reuses worker.py's own default meaning (how long the fleet pauses after a
# fully-empty rotation pass — see fleet_worker's per-pass idle semantics) —
# not exposed as a fleet env var because the brief for this daemon names no
# such knob; if that changes, add FLEET_IDLE_SECONDS here rather than
# hardcoding a different number.
_DEFAULT_IDLE_SECONDS = 10.0

# Floor for FLEET_SYNC_INTERVAL_SECONDS. Without one, 0 (or any tiny value)
# turns the periodic re-sync thread into a busy loop against the console's
# sync endpoint — every tick is a full listFleetProvisionState sweep plus
# potential mints server-side, so this is a real cost, not just noise. 30s is
# far below any practical provisioning latency need (default is 300s) while
# making the pathological configs harmless.
_MIN_SYNC_INTERVAL_SECONDS = 30.0

# Floor for FLEET_LEASE_TTL_SECONDS (#1390). The lease renews at a THIRD of the
# TTL, so a very small TTL would hammer the DB with acquire statements and leave
# almost no slack for a transient blip before expiry. 5s is already an
# aggressively fast handoff; the default is 30s.
_MIN_LEASE_TTL_SECONDS = 5.0


def build_slots(
    base_url: str, tokens: Dict[str, FleetWorkspaceToken]
) -> List[WorkspaceSlot]:
    """Build one :class:`WorkspaceSlot` per stored token.

    Deliberately reuses ``agentrail.cli.commands.runner._make_execute`` and
    ``agentrail.runner.credentials.Credentials`` UNCHANGED: ``_make_execute``
    only ever reads ``creds.base_url`` / ``creds.token`` (never
    ``creds.workspace_id`` — the workspace id an execution needs comes from
    the claimed ``WorkItem`` itself), so building one ``Credentials`` per
    workspace and handing it to the existing single-workspace callback IS the
    whole "per-workspace execute" story — no fork, no parametrized copy of
    that function. This is exactly what keeps ``agentrail runner``'s own
    behavior byte-identical: this module never edits that function, it only
    calls it once per workspace instead of once per process.
    """
    slots: List[WorkspaceSlot] = []
    for workspace_id, tok in tokens.items():
        creds = Credentials(base_url=base_url, token=tok.token, workspace_id=workspace_id)
        client = RunnerClient(base_url=base_url, token=tok.token, workspace_id=workspace_id)
        execute = _make_execute(creds)
        slots.append(WorkspaceSlot(workspace_id=workspace_id, client=client, execute=execute))
    return slots


def _run_sync_loop(
    stop: threading.Event,
    *,
    base_url: str,
    console_token: str,
    home: "Path | None",
    sync_interval: float,
    rotation: WorkspaceRotation,
    is_active: "Callable[[], bool]" = lambda: True,
) -> None:
    """The periodic re-sync thread's body (module-level so tests can drive
    ticks with a scripted stop event — no real sleeping, no real thread).

    ``stop.wait(timeout)`` both paces the loop AND doubles as the shutdown
    signal — it returns ``True`` immediately when ``stop`` is set, where a
    plain ``time.sleep`` would ignore the shutdown until it next woke on its
    own. Each tick: one :func:`run_sync_cycle`; on success the rotation is
    refreshed with the new workspace set, on :class:`FleetSyncError` the
    failure is a stderr warning and the EXISTING rotation keeps serving
    untouched (periodic failure is never fatal — see the module docstring).

    ``is_active`` is the single-active-fleet lease gate (#1390): token-store
    sync runs ONLY on the lease holder (AC3). A standby skips the cycle entirely
    — it must not mint/revoke tokens against the shared store while another
    instance owns it. On promotion the lease loop triggers an immediate catch-up
    sync (see ``run_fleet``'s ``_on_promote``), so a freshly-promoted instance
    doesn't wait a whole interval for fresh tokens. The default ``lambda: True``
    keeps the no-lease path syncing every tick, exactly as before.
    """
    while not stop.wait(sync_interval):
        if not is_active():
            # Standby: the lease holder owns token sync. Skip this cycle.
            continue
        try:
            new_tokens = run_sync_cycle(
                base_url=base_url, console_token=console_token, home=home
            )
        except FleetSyncError as exc:
            # Periodic failure is a warning, not fatal — keep serving the
            # existing rotation untouched (see module docstring).
            print(
                f"agentrail fleet: re-sync failed (keeping existing token store) — {exc}",
                file=sys.stderr,
            )
            continue
        rotation.refresh(build_slots(base_url, new_tokens))


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        print(
            f"agentrail fleet: {name} must be an integer, got {raw!r} — using default {default}",
            file=sys.stderr,
        )
        return default


def _float_env(name: str, default: float, *, minimum: float | None = None) -> float:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        print(
            f"agentrail fleet: {name} must be a number, got {raw!r} — using default {default}",
            file=sys.stderr,
        )
        return default
    if minimum is not None and value < minimum:
        print(
            f"agentrail fleet: {name}={value:g} is below the floor of "
            f"{minimum:g}s — clamping to {minimum:g} (a smaller interval "
            "would busy-loop the console's sync endpoint)",
            file=sys.stderr,
        )
        return minimum
    return value


def _make_lease() -> Optional[FleetLease]:
    """Build the single-active-fleet lease (#1390), or ``None`` when lease
    coordination is disabled.

    Coordination is opt-in on ``DATABASE_URL`` being set for this service.
    Unset (today's fleet deploy) -> ``None`` -> the process runs exactly as
    before this feature: sole active instance, no lease thread, no new failure
    mode. Set -> a real Postgres-backed lease so overlapping deploy instances
    coordinate to exactly one active. See ``deploy/fleet/README.md`` /
    ``RUNBOOK.md`` for the operator wiring.
    """
    dsn = (os.environ.get("DATABASE_URL") or "").strip()
    if not dsn:
        return None
    ttl = _float_env(
        "FLEET_LEASE_TTL_SECONDS", DEFAULT_LEASE_TTL_SECONDS, minimum=_MIN_LEASE_TTL_SECONDS
    )
    return FleetLease(PostgresLeaseExecutor(dsn), ttl_seconds=ttl)


def run_fleet(args: List[str]) -> int:
    if args and args[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if args:
        print(f"agentrail fleet: unknown option: {args[0]}", file=sys.stderr)
        return 1

    base_url = (os.environ.get("AGENTRAIL_SERVER_BASE_URL") or "").strip()
    console_token = (os.environ.get("FLEET_CONSOLE_TOKEN") or "").strip()
    missing = [
        name
        for name, value in (
            ("AGENTRAIL_SERVER_BASE_URL", base_url),
            ("FLEET_CONSOLE_TOKEN", console_token),
        )
        if not value
    ]
    if missing:
        print(
            f"agentrail fleet: missing required env var(s): {', '.join(missing)}",
            file=sys.stderr,
        )
        return 1

    home_env = os.environ.get("AGENTRAIL_FLEET_HOME")
    home = Path(home_env).expanduser() if home_env else None
    concurrency = _int_env("FLEET_CONCURRENCY", 2)
    sync_interval = _float_env(
        "FLEET_SYNC_INTERVAL_SECONDS", 300.0, minimum=_MIN_SYNC_INTERVAL_SECONDS
    )

    # Single-active-fleet lease (#1390). Unset DATABASE_URL -> None -> this
    # process is the sole active instance, exactly as before this feature (no
    # lease thread, no gating, no new failure mode). Set -> a Postgres lease so
    # overlapping deploy instances coordinate down to exactly one active.
    lease = _make_lease()
    is_active: Callable[[], bool] = (lambda: True) if lease is None else lease.is_held

    if lease is None:
        print(
            "agentrail fleet: lease coordination disabled (DATABASE_URL not set) — "
            "running as the sole active fleet. Set DATABASE_URL to coordinate "
            "overlapping deploy instances down to one active (see "
            "deploy/fleet/README.md).",
            file=sys.stderr,
        )
        active_at_boot = True
    else:
        # Fail-open (see FleetLease.acquire_or_renew): a DB blip here returns
        # True so a lone fleet still boots active.
        active_at_boot = lease.acquire_or_renew()

    if active_at_boot:
        # Boot sync MUST succeed — see module docstring. A 404 (the sync route's
        # anti-enumeration posture collapses "secret unset" and "secret wrong"
        # into the same response) or a connection failure both surface
        # identically here as a FleetSyncError; there is nothing more specific to
        # tell the operator than "check these two env vars." Only the lease
        # HOLDER boot-syncs (AC1/AC3): two instances booting at once must not
        # both mint against the shared token store.
        try:
            tokens = run_sync_cycle(base_url=base_url, console_token=console_token, home=home)
        except FleetSyncError as exc:
            print(f"agentrail fleet: initial sync failed — {exc}", file=sys.stderr)
            print(
                "  check FLEET_CONSOLE_TOKEN and AGENTRAIL_SERVER_BASE_URL.",
                file=sys.stderr,
            )
            if lease is not None:
                lease.release()
            return 1
        rotation = WorkspaceRotation(build_slots(base_url, tokens))
        print(
            f"Fleet active — {len(tokens)} workspace(s) @ {base_url}. "
            f"{concurrency} concurrent slot(s), re-sync every {int(sync_interval)}s."
        )
    else:
        # Lease standby: another instance holds it. Do NOT boot-sync (that's the
        # holder's job); serve from the last-good token store on the shared
        # volume so promotion is instant, and poll to take over.
        tokens = load_fleet_store(home=home)
        rotation = WorkspaceRotation(build_slots(base_url, tokens))
        print(
            f"Fleet standby — another instance holds the fleet lease; "
            f"{len(tokens)} workspace(s) warm @ {base_url}. Polling every "
            f"{int(lease.renew_interval)}s to take over."
        )

    stop = threading.Event()
    sync_thread = threading.Thread(
        target=_run_sync_loop,
        args=(stop,),
        kwargs=dict(
            base_url=base_url,
            console_token=console_token,
            home=home,
            sync_interval=sync_interval,
            rotation=rotation,
            is_active=is_active,
        ),
        daemon=True,
        name="fleet-sync",
    )
    sync_thread.start()

    lease_thread: "threading.Thread | None" = None
    if lease is not None:
        def _on_promote() -> None:
            # A standby just became the holder: catch the token store up now
            # rather than waiting a whole sync interval, then swap the rotation
            # to the freshly-synced workspace set. A sync failure here is a
            # warning — the warm store keeps serving and the periodic loop
            # (now active) retries on its own cadence.
            try:
                new_tokens = run_sync_cycle(
                    base_url=base_url, console_token=console_token, home=home
                )
            except FleetSyncError as exc:
                print(
                    "agentrail fleet: promotion sync failed (serving the warm "
                    f"store; will retry) — {exc}",
                    file=sys.stderr,
                )
                return
            rotation.refresh(build_slots(base_url, new_tokens))

        lease_thread = threading.Thread(
            target=run_lease_loop,
            args=(lease, stop),
            kwargs=dict(
                renew_interval=lease.renew_interval,
                on_promote=_on_promote,
                was_active=active_at_boot,
                log=lambda msg: print(f"agentrail fleet: {msg}", file=sys.stderr),
            ),
            daemon=True,
            name="fleet-lease",
        )
        lease_thread.start()

    try:
        run_fleet_worker(
            rotation,
            sleep=time.sleep,
            idle_seconds=_DEFAULT_IDLE_SECONDS,
            concurrency=concurrency,
            is_active=is_active,
        )
    except KeyboardInterrupt:
        print("\nFleet stopped.")
    finally:
        stop.set()
        if lease is not None:
            # Hand the lease over immediately on graceful shutdown so a standby
            # takes over at once instead of waiting out the TTL.
            lease.release()
    return 0
