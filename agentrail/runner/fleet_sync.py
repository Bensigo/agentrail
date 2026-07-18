"""The fleet's sync client — the ONLY provisioning path for a fleet workspace
token (issue #1267 PR ①'s ``POST /api/v1/fleet/workspace-tokens/sync``).

No human ever clicks through ``/activate`` for a fleet-served workspace (that
device flow, :mod:`agentrail.runner.login`, mints a SINGLE-workspace token for
whichever workspace a signed-in user picks). Instead the fleet calls this
route on its own schedule — at boot and every
``FLEET_SYNC_INTERVAL_SECONDS`` — with a single shared secret
(``FLEET_CONSOLE_TOKEN``), and reads off ``{minted, active, revoked}`` to keep
its on-disk multi-workspace store (:mod:`agentrail.runner.fleet_credentials`)
in sync with the console's ``hosted_execution`` flag per workspace.

Reuses the SAME ``Response``/``Transport`` shape
:mod:`agentrail.runner.client` established (an injectable HTTP seam, real
``urllib`` in production) — :mod:`agentrail.runner.login` already imports
``_urllib_transport`` from there for exactly this reason, so doing the same
here is the established cross-module convention, not a new one.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional

from agentrail.runner.client import Response, Transport, _urllib_transport
from agentrail.runner.fleet_credentials import (
    FleetWorkspaceToken,
    load_fleet_store,
    save_fleet_store,
)

class FleetSyncError(Exception):
    """The sync call itself failed — network error, or a non-2xx status.

    Deliberately ONE exception type for every failure mode (connection
    refused, DNS failure, timeout, 404 from a missing/wrong
    ``FLEET_CONSOLE_TOKEN`` — the route collapses "secret unset" and "secret
    wrong" into the SAME 404 on purpose, so this client has no way to tell
    them apart either, nor should it try). The CALLER decides what a failure
    means: fatal at boot (nothing is known yet), a warning mid-run (keep
    serving the last-good store) — see :func:`run_sync_cycle` and
    ``agentrail/cli/commands/fleet.py``.
    """


@dataclass(frozen=True)
class FleetSyncResult:
    """The parsed ``{minted, active, revoked}`` response body."""

    minted: List[FleetWorkspaceToken] = field(default_factory=list)
    active: List[str] = field(default_factory=list)
    revoked: List[str] = field(default_factory=list)


def sync_fleet_tokens(
    *, base_url: str, console_token: str, transport: Optional[Transport] = None
) -> FleetSyncResult:
    """POST the sync route and parse its response. Raises :class:`FleetSyncError`
    on any network failure or non-2xx status; never returns a raw token in an
    exception message (only workspace ids / HTTP status / a short body excerpt
    ever land there — the token itself is never echoed by the console route in
    an error path, and this client doesn't either).
    """
    transport = transport or _urllib_transport
    url = f"{base_url.rstrip('/')}/api/v1/fleet/workspace-tokens/sync"
    headers = {
        "Authorization": f"Bearer {console_token}",
        "Content-Type": "application/json",
    }
    try:
        resp: Response = transport("POST", url, headers=headers, body=None)
    except OSError as exc:
        raise FleetSyncError(f"sync request failed: {exc}") from exc

    if not (200 <= resp.status < 300):
        raise FleetSyncError(
            f"sync failed: HTTP {resp.status} "
            f"{resp.body[:200].decode('utf-8', 'replace')}"
        )
    try:
        data = json.loads(resp.body.decode("utf-8"))
    except ValueError as exc:
        raise FleetSyncError(f"sync returned invalid JSON: {exc}") from exc

    minted = [
        FleetWorkspaceToken(
            workspace_id=str(m["workspaceId"]),
            slug=str(m.get("slug") or ""),
            token=str(m["token"]),
        )
        for m in (data.get("minted") or [])
    ]
    active = [str(w) for w in (data.get("active") or [])]
    revoked = [str(w) for w in (data.get("revoked") or [])]
    return FleetSyncResult(minted=minted, active=active, revoked=revoked)


def apply_sync(
    store: dict, result: FleetSyncResult
) -> "tuple[dict, List[str]]":
    """Pure merge: fold a :class:`FleetSyncResult` into ``store``.

    Returns ``(new_store, drift_workspace_ids)``:

    - ``minted`` -> added/overwritten in the store (the raw token, exactly as
      received — this is the ONLY time it is ever available; a token the
      store later loses cannot be re-fetched here, only re-minted after an
      operator revokes the orphaned key).
    - ``revoked`` -> dropped from the store.
    - ``active`` workspace ids with NO token in the resulting store are
      DRIFT: the console believes this workspace already has an active fleet
      key, but this fleet instance holds none for it (lost, e.g. a wiped
      volume, or minted for a different instance entirely). Returned for the
      caller to warn about loudly; this function never guesses or re-requests
      a token for a drifted workspace — see the module docstring's "no
      service-to-service re-fetch" contract and
      ``deploy/fleet/README.md``'s kill-switch/recovery section.
    """
    new_store = dict(store)
    for tok in result.minted:
        new_store[tok.workspace_id] = tok
    for ws_id in result.revoked:
        new_store.pop(ws_id, None)
    drift = [ws_id for ws_id in result.active if ws_id not in new_store]
    return new_store, drift


def _default_warn(message: str) -> None:
    print(message, file=sys.stderr)


def run_sync_cycle(
    *,
    base_url: str,
    console_token: str,
    home: Optional[Path] = None,
    transport: Optional[Transport] = None,
    warn: Callable[[str], None] = _default_warn,
) -> dict:
    """One full sync cycle: call the route, merge into the on-disk store,
    persist it, and loudly warn on drift. Returns the resulting
    ``{workspace_id: FleetWorkspaceToken}`` map.

    Raises :class:`FleetSyncError` if the HTTP call itself fails — the caller
    (``agentrail/cli/commands/fleet.py``) decides whether that is fatal (boot)
    or a keep-serving-the-existing-store warning (periodic re-sync); this
    function does not know which cycle it's being called for.
    """
    result = sync_fleet_tokens(
        base_url=base_url, console_token=console_token, transport=transport
    )
    current = load_fleet_store(home=home)
    new_store, drift = apply_sync(current, result)
    save_fleet_store(new_store, home=home)
    if drift:
        warn(
            "fleet: the console reports an active fleet key for workspace(s) "
            f"{', '.join(sorted(drift))} but this instance holds no token for "
            "them (lost, or minted for a different fleet instance). Recovery: "
            "revoke the orphaned key for each of these workspaces in the "
            "console — the next sync will mint a fresh one this instance "
            "receives."
        )
    return new_store
