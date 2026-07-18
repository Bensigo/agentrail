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
  FLEET_SYNC_INTERVAL_SECONDS     optional, default 300. How often to re-call
                                  the sync route after the initial boot sync.

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
from typing import Dict, List

from agentrail.cli.commands.runner import _make_execute
from agentrail.runner.client import RunnerClient
from agentrail.runner.credentials import Credentials
from agentrail.runner.fleet_credentials import FleetWorkspaceToken
from agentrail.runner.fleet_sync import FleetSyncError, run_sync_cycle
from agentrail.runner.fleet_worker import WorkspaceRotation, WorkspaceSlot, run_fleet_worker

# Reuses worker.py's own default meaning (how long a slot waits after an idle
# or failed claim before trying again) — not exposed as a fleet env var
# because the brief for this daemon names no such knob; if that changes,
# add FLEET_IDLE_SECONDS here rather than hardcoding a different number.
_DEFAULT_IDLE_SECONDS = 10.0


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


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        print(
            f"agentrail fleet: {name} must be a number, got {raw!r} — using default {default}",
            file=sys.stderr,
        )
        return default


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
    sync_interval = _float_env("FLEET_SYNC_INTERVAL_SECONDS", 300.0)

    # Boot sync MUST succeed — see module docstring. A 404 (the sync route's
    # anti-enumeration posture collapses "secret unset" and "secret wrong"
    # into the same response) or a connection failure both surface identically
    # here as a FleetSyncError; there is nothing more specific to tell the
    # operator than "check these two env vars."
    try:
        tokens = run_sync_cycle(base_url=base_url, console_token=console_token, home=home)
    except FleetSyncError as exc:
        print(f"agentrail fleet: initial sync failed — {exc}", file=sys.stderr)
        print(
            "  check FLEET_CONSOLE_TOKEN and AGENTRAIL_SERVER_BASE_URL.",
            file=sys.stderr,
        )
        return 1

    rotation = WorkspaceRotation(build_slots(base_url, tokens))
    print(
        f"Fleet active — {len(tokens)} workspace(s) @ {base_url}. "
        f"{concurrency} concurrent slot(s), re-sync every {int(sync_interval)}s."
    )

    stop = threading.Event()

    def _sync_loop() -> None:
        # stop.wait(timeout) both sleeps AND doubles as the shutdown signal —
        # returns True immediately if `stop` is set, instead of a plain
        # time.sleep that would ignore it until it next wakes up on its own.
        while not stop.wait(sync_interval):
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

    sync_thread = threading.Thread(target=_sync_loop, daemon=True, name="fleet-sync")
    sync_thread.start()

    try:
        run_fleet_worker(
            rotation,
            sleep=time.sleep,
            idle_seconds=_DEFAULT_IDLE_SECONDS,
            concurrency=concurrency,
        )
    except KeyboardInterrupt:
        print("\nFleet stopped.")
    finally:
        stop.set()
    return 0
