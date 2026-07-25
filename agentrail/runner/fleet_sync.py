"""The fleet's sync client — the ONLY provisioning path for a fleet workspace
token (issue #1267 PR ①'s ``POST /api/v1/fleet/workspace-tokens/sync``).

No human ever clicks through ``/activate`` for a fleet-served workspace (that
device flow, :mod:`agentrail.runner.login`, mints a SINGLE-workspace token for
whichever workspace a signed-in user picks). Instead the fleet calls this
route on its own schedule — at boot and every
``FLEET_SYNC_INTERVAL_SECONDS`` — with a single shared secret
(``FLEET_CONSOLE_TOKEN``), and reads off
``{minted, active, revoked, failed, stalled}`` to keep its on-disk
multi-workspace store (:mod:`agentrail.runner.fleet_credentials`) in sync
with the console's ``hosted_execution`` flag per workspace.

Reuses the SAME ``Response``/``Transport`` shape
:mod:`agentrail.runner.client` established (an injectable HTTP seam, real
``urllib`` in production) — :mod:`agentrail.runner.login` already imports
``_urllib_transport`` from there for exactly this reason, so doing the same
here is the established cross-module convention, not a new one.

**Self-heal (the fix for the fleet silently stopping claims on every
restart):** every Railway redeploy — and a bare container restart with no
deploy at all — starts a fresh process with an EMPTY on-disk token store
while the console still reports an active fleet key for every
previously-served workspace. That is ``apply_sync``'s "drift": the console
says active, this instance holds nothing. Before this fix the ONLY thing
that happened was a loud stderr warning telling an operator to go revoke the
orphaned key by hand — observed, six times in one session, to go unnoticed
for up to four days once, silently stopping the queue the whole time.
:func:`self_heal_workspace_token` (``POST
/api/v1/fleet/workspace-tokens/self-heal``) is what :func:`run_sync_cycle`
now calls automatically for every drifted workspace instead of only logging
it — see that function's own doc-comment for the request/response contract,
and :func:`_self_heal_drift` for the bounded retry/backoff and "log every
decision" wiring. Self-heal is OPT-IN via ``fleet_instance_id`` (only
non-``None`` when the caller — :mod:`agentrail.cli.commands.fleet` in
production — passes one): every EXISTING caller of :func:`run_sync_cycle`
that predates this feature omits it and keeps its byte-identical
drift-warning-only behavior.
"""
from __future__ import annotations

import json
import sys
import time
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
class FleetFailedWorkspace:
    """One workspace whose sync-side unit of work (mint/revoke) failed.

    ``reason`` is the route's closed union — ``'mint_failed' |
    'revoke_failed'`` — terse by design (never a token, never raw error
    text; the route's own doc-comment guarantees this), so it is safe to
    print verbatim in the warning below.
    """

    workspace_id: str
    reason: str


@dataclass(frozen=True)
class FleetStalledWorkspace:
    """One hosted-eligible workspace with unclaimed 'queued' work sitting
    past the console's staleness window and no live self-hosted fallback —
    the VISIBLE half of the self-heal fix (see
    ``listStalledHostedWorkspaces`` server-side). Field names/units match
    the wire response exactly (minutes, not seconds — the console's own
    staleness window is minutes-grained).
    """

    workspace_id: str
    slug: str
    stale_queued_count: int
    oldest_queued_minutes: float


@dataclass(frozen=True)
class FleetSyncResult:
    """The parsed ``{minted, active, revoked, failed, stalled}`` response body."""

    minted: List[FleetWorkspaceToken] = field(default_factory=list)
    active: List[str] = field(default_factory=list)
    revoked: List[str] = field(default_factory=list)
    failed: List[FleetFailedWorkspace] = field(default_factory=list)
    stalled: List[FleetStalledWorkspace] = field(default_factory=list)


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
    failed = [
        FleetFailedWorkspace(
            workspace_id=str(f.get("workspaceId") or ""),
            reason=str(f.get("reason") or "unknown"),
        )
        for f in (data.get("failed") or [])
        if isinstance(f, dict)
    ]
    stalled = [
        FleetStalledWorkspace(
            workspace_id=str(s.get("workspaceId") or ""),
            slug=str(s.get("slug") or ""),
            stale_queued_count=int(s.get("staleQueuedCount") or 0),
            oldest_queued_minutes=float(s.get("oldestQueuedMinutes") or 0),
        )
        for s in (data.get("stalled") or [])
        if isinstance(s, dict)
    ]
    return FleetSyncResult(
        minted=minted, active=active, revoked=revoked, failed=failed, stalled=stalled
    )


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
      caller to act on.

      THIS function stays a pure, side-effect-free merge — it never guesses
      or re-requests a token itself. The self-heal fix lives one layer up:
      :func:`run_sync_cycle` (its only caller) now attempts
      :func:`self_heal_workspace_token` for every drifted id before falling
      back to a warning, so "drift" is no longer a dead end that only a
      human can clear — see that function's own doc-comment. The distinction
      matters for testability: :func:`apply_sync`'s own tests stay pure/sync
      and never touch HTTP; only :func:`run_sync_cycle`'s tests need to
      script the self-heal transport too.
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


@dataclass(frozen=True)
class SelfHealResult:
    """The parsed ``POST /api/v1/fleet/workspace-tokens/self-heal`` response.

    ``ok=True`` -> ``token`` carries the freshly-minted
    :class:`FleetWorkspaceToken`. ``ok=False`` -> ``reason`` is the route's
    closed union (``'not_found' | 'not_hosted' | 'cooldown' | 'error'``,
    where ``'error'`` is THIS client's own addition for a network failure /
    non-2xx / malformed body — the route itself never sends that literal);
    never a token, never raw error text, mirroring
    :class:`FleetFailedWorkspace`'s own terseness contract.
    """

    ok: bool
    token: Optional[FleetWorkspaceToken] = None
    reason: Optional[str] = None
    retry_after_seconds: Optional[float] = None


def self_heal_workspace_token(
    *,
    base_url: str,
    console_token: str,
    workspace_id: str,
    fleet_instance_id: str,
    transport: Optional[Transport] = None,
) -> SelfHealResult:
    """Ask the console to atomically rotate (revoke old + mint fresh) the
    ``kind: 'fleet'`` key for ``workspace_id`` and hand this instance the new
    token — the self-heal fix's HTTP edge. Never raises: every failure mode
    (network error, non-2xx, malformed body, or the route's own
    not_found/not_hosted/cooldown refusal) comes back as ``SelfHealResult(ok=False,
    reason=...)`` so the caller (:func:`_self_heal_drift`) can decide whether
    to retry, log, or fall back — a self-heal attempt must never itself raise
    and abort the sync cycle it is trying to rescue.

    ``fleet_instance_id`` is this process's identity
    (:func:`agentrail.runner.fleet_lease.mint_fleet_instance_id`) — sent so
    the console's rotation audit trail (``fleet_key_rotations``) records
    which instance asked. It does NOT grant this instance an exemption from
    the console's cooldown guard; see the route's own doc-comment.
    """
    transport = transport or _urllib_transport
    url = f"{base_url.rstrip('/')}/api/v1/fleet/workspace-tokens/self-heal"
    headers = {
        "Authorization": f"Bearer {console_token}",
        "Content-Type": "application/json",
    }
    body = json.dumps(
        {"workspaceId": workspace_id, "fleetInstanceId": fleet_instance_id}
    ).encode("utf-8")
    try:
        resp: Response = transport("POST", url, headers=headers, body=body)
    except OSError as exc:
        return SelfHealResult(ok=False, reason=f"error: {exc}")

    if not (200 <= resp.status < 300):
        return SelfHealResult(
            ok=False,
            reason=f"error: HTTP {resp.status} "
            f"{resp.body[:200].decode('utf-8', 'replace')}",
        )
    try:
        data = json.loads(resp.body.decode("utf-8"))
    except ValueError as exc:
        return SelfHealResult(ok=False, reason=f"error: invalid JSON ({exc})")

    if not isinstance(data, dict) or not data.get("ok"):
        reason = (
            str(data.get("reason")) if isinstance(data, dict) and data.get("reason") else "error"
        )
        retry_after = (
            data.get("retryAfterSeconds") if isinstance(data, dict) else None
        )
        return SelfHealResult(
            ok=False,
            reason=reason,
            retry_after_seconds=float(retry_after) if isinstance(retry_after, (int, float)) else None,
        )

    try:
        token = FleetWorkspaceToken(
            workspace_id=str(data["workspaceId"]),
            slug=str(data.get("slug") or ""),
            token=str(data["token"]),
        )
    except KeyError as exc:
        return SelfHealResult(ok=False, reason=f"error: malformed success body ({exc})")
    return SelfHealResult(ok=True, token=token)


def _self_heal_drift(
    store: dict,
    drift: List[str],
    *,
    base_url: str,
    console_token: str,
    fleet_instance_id: str,
    transport: Optional[Transport],
    warn: Callable[[str], None],
    sleep: Callable[[float], None],
    max_attempts: int,
) -> "tuple[dict, List[str]]":
    """Attempt server-authoritative self-heal for each drifted workspace id,
    with a small BOUNDED retry (network blips only) per workspace. Returns
    ``(new_store, still_drifted)``:

    - A healed workspace's fresh token is folded into the store (exactly
      like an ordinary ``minted`` token) and dropped from the drift list.
    - A workspace self-heal could not resolve stays in ``still_drifted`` so
      the caller's EXISTING drift-warning fallback still names it — self-heal
      is additive, never a replacement for that safety net.

    Every attempt logs a decision via ``warn`` (success, a declined refusal,
    or a retryable failure) — this is deliberately noisier than the
    surrounding sync cycle's usual warnings, because a silent automatic
    credential rotation is exactly the kind of thing an operator reading
    fleet logs should be able to reconstruct after the fact.

    A ``not_found`` / ``not_hosted`` / ``cooldown`` refusal is NEVER retried
    locally: retrying in a tight loop cannot change a server-enforced
    cooldown or a workspace's ``hosted_execution`` flag, so one attempt is
    logged and this workspace moves on (a LATER sync cycle, once real
    wall-clock time has passed, is what actually resolves a cooldown).
    Anything else (network error, 5xx, malformed body — this client's own
    ``'error: ...'`` reasons) is treated as transient and retried up to
    ``max_attempts`` times with linear backoff (``attempt`` seconds between
    tries) via the injectable ``sleep`` — hermetically testable, no real
    waiting in tests.
    """
    new_store = dict(store)
    still_drifted: List[str] = []
    for workspace_id in drift:
        healed: Optional[FleetWorkspaceToken] = None
        for attempt in range(1, max_attempts + 1):
            outcome = self_heal_workspace_token(
                base_url=base_url,
                console_token=console_token,
                workspace_id=workspace_id,
                fleet_instance_id=fleet_instance_id,
                transport=transport,
            )
            if outcome.ok:
                healed = outcome.token
                warn(
                    f"fleet: self-heal minted a fresh token for workspace "
                    f"{workspace_id} (attempt {attempt}/{max_attempts}) — "
                    "resuming claims for it."
                )
                break
            reason = outcome.reason or "unknown"
            if reason in ("not_found", "not_hosted", "cooldown"):
                warn(
                    f"fleet: self-heal declined for workspace {workspace_id} "
                    f"({reason}) — will retry on a later sync cycle."
                )
                break
            if attempt < max_attempts:
                warn(
                    f"fleet: self-heal attempt {attempt}/{max_attempts} failed "
                    f"for workspace {workspace_id} ({reason}); retrying."
                )
                sleep(float(attempt))
            else:
                warn(
                    f"fleet: self-heal exhausted {max_attempts} attempt(s) for "
                    f"workspace {workspace_id} ({reason}) — falling back to "
                    "the manual-recovery warning below."
                )
        if healed is not None:
            new_store[workspace_id] = healed
        else:
            still_drifted.append(workspace_id)
    return new_store, still_drifted


def run_sync_cycle(
    *,
    base_url: str,
    console_token: str,
    home: Optional[Path] = None,
    transport: Optional[Transport] = None,
    warn: Callable[[str], None] = _default_warn,
    fleet_instance_id: Optional[str] = None,
    self_heal_max_attempts: int = 3,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    """One full sync cycle: call the route, merge into the on-disk store,
    self-heal any drift, persist it, and loudly warn on whatever self-heal
    could not resolve. Returns the resulting
    ``{workspace_id: FleetWorkspaceToken}`` map.

    ``fleet_instance_id`` gates self-heal: ``None`` (the default) disables
    it entirely, keeping every pre-existing caller's behavior byte-identical
    (immediate drift warning, no HTTP call to the self-heal route — the same
    convention :mod:`agentrail.runner.fleet_worker`'s ``is_active`` hook
    uses for its own opt-in feature). ``agentrail/cli/commands/fleet.py``
    passes a real, per-process id (:func:`agentrail.runner.fleet_lease.mint_fleet_instance_id`)
    in production, so self-heal is always on there.

    Raises :class:`FleetSyncError` if the HTTP call itself fails — the caller
    (``agentrail/cli/commands/fleet.py``) decides whether that is fatal (boot)
    or a keep-serving-the-existing-store warning (periodic re-sync); this
    function does not know which cycle it's being called for. A self-heal
    attempt failing never raises (see :func:`self_heal_workspace_token`) —
    only the drift-warning fallback follows.
    """
    result = sync_fleet_tokens(
        base_url=base_url, console_token=console_token, transport=transport
    )
    current = load_fleet_store(home=home)
    new_store, drift = apply_sync(current, result)
    if drift and fleet_instance_id:
        new_store, drift = _self_heal_drift(
            new_store,
            drift,
            base_url=base_url,
            console_token=console_token,
            fleet_instance_id=fleet_instance_id,
            transport=transport,
            warn=warn,
            sleep=sleep,
            max_attempts=self_heal_max_attempts,
        )
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
    if result.stalled:
        # The VISIBLE half of the self-heal fix: queued work stuck past the
        # console's staleness window with no live execution path for it,
        # regardless of why (self-heal still catching up, a stuck cooldown,
        # the fleet fully down). Repeats every sync cycle for as long as it
        # persists — deliberately, since a signal that fires once and scrolls
        # away is exactly how the original bug went unnoticed for four days.
        details = ", ".join(
            f"{s.workspace_id} ({s.stale_queued_count} queued, oldest "
            f"{s.oldest_queued_minutes:.0f}min)"
            for s in sorted(result.stalled, key=lambda s: s.workspace_id)
        )
        warn(
            f"fleet: STALLED — workspace(s) {details} have hosted_execution=true, "
            "no self-hosted fallback, and queued work sitting unclaimed past the "
            "staleness window. The fleet is not actually claiming for them right "
            "now — check FLEET_CONSOLE_TOKEN, the self-heal cooldown, and DB "
            "connectivity."
        )
    if result.failed:
        # Per-row failure isolation on the route side (its review-fix round):
        # a mint/revoke that failed for ONE workspace lands here instead of
        # discarding the whole response. Nothing to do locally — a
        # mint_failed workspace handed us no token, and a revoke_failed
        # workspace's key is still active server-side (so keeping our stored
        # token is correct until the revoke actually lands). The route
        # re-derives state fresh every sync, so the failed unit of work is
        # automatically retried on our next cycle; this warning exists so a
        # PERSISTENTLY failing workspace is visible to the operator rather
        # than silently retried forever. Reasons are the route's closed
        # union ('mint_failed' | 'revoke_failed') — never a token, never raw
        # error text — so printing them verbatim is safe.
        details = ", ".join(
            f"{f.workspace_id} ({f.reason})"
            for f in sorted(result.failed, key=lambda f: f.workspace_id)
        )
        warn(
            f"fleet: sync reported per-workspace failures: {details}. These "
            "will be retried automatically on the next sync cycle; if the "
            "same workspace keeps failing, check the console service's logs."
        )
    return new_store
