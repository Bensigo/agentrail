"""Tests for the fleet's sync client (agentrail/runner/fleet_sync.py).

The sync route (#1267 PR ①, ``POST /api/v1/fleet/workspace-tokens/sync``) is
the fleet's ONLY provisioning path — no human ever approves a device-flow
code for a fleet-served workspace. These tests mock HTTP the same way
``agentrail/tests/runner/test_client.py`` / ``test_login.py`` do: an injectable
transport, never real urllib.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from agentrail.runner.client import Response
from agentrail.runner.fleet_credentials import (
    FleetWorkspaceToken,
    load_fleet_store,
)
from agentrail.runner.fleet_sync import (
    FleetFailedWorkspace,
    FleetStalledWorkspace,
    FleetSyncError,
    FleetSyncResult,
    SelfHealResult,
    apply_sync,
    run_sync_cycle,
    self_heal_workspace_token,
    sync_fleet_tokens,
)


class FakeTransport:
    """Records requests and replays a scripted queue of responses (or raises)."""

    def __init__(self, responses: Optional[List[Any]] = None) -> None:
        self.responses: List[Any] = list(responses or [])
        self.calls: List[Dict[str, Any]] = []

    def __call__(self, method, url, *, headers, body=None) -> Response:
        self.calls.append({"method": method, "url": url, "headers": headers, "body": body})
        if not self.responses:  # pragma: no cover - defensive
            raise AssertionError("no scripted response left")
        nxt = self.responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


# --- sync_fleet_tokens: HTTP + parsing --------------------------------------


def test_sync_posts_with_bearer_console_token():
    transport = FakeTransport([Response(status=200, body=b'{"minted":[],"active":[],"revoked":[]}')])
    sync_fleet_tokens(
        base_url="https://app.agentrail.dev/", console_token="fleet-secret", transport=transport
    )
    call = transport.calls[0]
    assert call["method"] == "POST"
    assert call["url"] == "https://app.agentrail.dev/api/v1/fleet/workspace-tokens/sync"
    assert call["headers"]["Authorization"] == "Bearer fleet-secret"


def test_sync_parses_minted_active_revoked():
    transport = FakeTransport(
        [
            Response(
                status=200,
                body=(
                    b'{"minted":[{"workspaceId":"ws1","slug":"acme","token":"rt_new"}],'
                    b'"active":["ws2"],"revoked":["ws3"]}'
                ),
            )
        ]
    )
    result = sync_fleet_tokens(
        base_url="https://app.agentrail.dev", console_token="fleet-secret", transport=transport
    )
    assert result == FleetSyncResult(
        minted=[FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_new")],
        active=["ws2"],
        revoked=["ws3"],
    )


def test_sync_raises_on_404_anti_enumeration_response():
    # The route collapses "secret unset" and "secret wrong" into the same 404
    # — the client must surface it as a plain failure, not try to special-case it.
    transport = FakeTransport([Response(status=404, body=b'{"error":"Not found"}')])
    with pytest.raises(FleetSyncError):
        sync_fleet_tokens(
            base_url="https://app.agentrail.dev", console_token="wrong", transport=transport
        )


def test_sync_raises_on_connection_error():
    transport = FakeTransport([OSError("connection refused")])
    with pytest.raises(FleetSyncError):
        sync_fleet_tokens(
            base_url="https://app.agentrail.dev", console_token="t", transport=transport
        )


def test_sync_raises_on_invalid_json():
    transport = FakeTransport([Response(status=200, body=b"not json")])
    with pytest.raises(FleetSyncError):
        sync_fleet_tokens(
            base_url="https://app.agentrail.dev", console_token="t", transport=transport
        )


def test_sync_error_message_never_contains_the_console_token():
    transport = FakeTransport([Response(status=500, body=b"internal error")])
    try:
        sync_fleet_tokens(
            base_url="https://app.agentrail.dev",
            console_token="super-secret-fleet-token",
            transport=transport,
        )
        raise AssertionError("expected FleetSyncError")
    except FleetSyncError as exc:
        assert "super-secret-fleet-token" not in str(exc)


def test_sync_defaults_missing_optional_fields_to_empty_lists():
    # Also covers a pre-failed-bucket server (older console) — `failed` absent
    # must parse as [], never crash.
    transport = FakeTransport([Response(status=200, body=b"{}")])
    result = sync_fleet_tokens(
        base_url="https://app.agentrail.dev", console_token="t", transport=transport
    )
    assert result == FleetSyncResult(minted=[], active=[], revoked=[], failed=[])


def test_sync_parses_failed_bucket():
    # The route's review-fix round added per-row failure isolation: a mint or
    # revoke that failed for ONE workspace lands in `failed` with a terse
    # closed-union reason instead of discarding the whole response.
    transport = FakeTransport(
        [
            Response(
                status=200,
                body=(
                    b'{"minted":[],"active":[],"revoked":[],'
                    b'"failed":[{"workspaceId":"ws1","reason":"mint_failed"},'
                    b'{"workspaceId":"ws2","reason":"revoke_failed"}]}'
                ),
            )
        ]
    )
    result = sync_fleet_tokens(
        base_url="https://app.agentrail.dev", console_token="t", transport=transport
    )
    assert result.failed == [
        FleetFailedWorkspace(workspace_id="ws1", reason="mint_failed"),
        FleetFailedWorkspace(workspace_id="ws2", reason="revoke_failed"),
    ]


def test_sync_failed_bucket_skips_malformed_entries():
    transport = FakeTransport(
        [
            Response(
                status=200,
                body=(
                    b'{"failed":["not-a-dict",'
                    b'{"workspaceId":"ws1","reason":"mint_failed"}]}'
                ),
            )
        ]
    )
    result = sync_fleet_tokens(
        base_url="https://app.agentrail.dev", console_token="t", transport=transport
    )
    assert result.failed == [FleetFailedWorkspace(workspace_id="ws1", reason="mint_failed")]


# --- apply_sync: pure merge logic -------------------------------------------


def test_apply_sync_adds_minted_tokens():
    store, drift = apply_sync(
        {},
        FleetSyncResult(
            minted=[FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_1")]
        ),
    )
    assert store == {"ws1": FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_1")}
    assert drift == []


def test_apply_sync_overwrites_existing_token_for_same_workspace():
    existing = {"ws1": FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_old")}
    store, _ = apply_sync(
        existing,
        FleetSyncResult(
            minted=[FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_new")]
        ),
    )
    assert store["ws1"].token == "rt_new"


def test_apply_sync_drops_revoked_workspaces():
    existing = {
        "ws1": FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_1"),
        "ws2": FleetWorkspaceToken(workspace_id="ws2", slug="widgets", token="rt_2"),
    }
    store, drift = apply_sync(existing, FleetSyncResult(revoked=["ws2"]))
    assert set(store) == {"ws1"}
    assert drift == []


def test_apply_sync_active_with_no_local_token_is_drift():
    # Server says ws9 has an active fleet key; this instance never received one.
    store, drift = apply_sync({}, FleetSyncResult(active=["ws9"]))
    assert store == {}
    assert drift == ["ws9"]


def test_apply_sync_active_with_a_local_token_is_not_drift():
    existing = {"ws1": FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_1")}
    store, drift = apply_sync(existing, FleetSyncResult(active=["ws1"]))
    assert drift == []
    assert store == existing


def test_apply_sync_leaves_untouched_workspaces_alone():
    existing = {"ws1": FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_1")}
    store, drift = apply_sync(existing, FleetSyncResult())
    assert store == existing
    assert drift == []


# --- run_sync_cycle: HTTP + store integration + drift warning --------------


def test_run_sync_cycle_persists_minted_tokens_to_disk(tmp_path: Path):
    transport = FakeTransport(
        [
            Response(
                status=200,
                body=b'{"minted":[{"workspaceId":"ws1","slug":"acme","token":"rt_1"}],'
                     b'"active":[],"revoked":[]}',
            )
        ]
    )
    result = run_sync_cycle(
        base_url="https://app.agentrail.dev",
        console_token="fleet-secret",
        home=tmp_path,
        transport=transport,
    )
    assert result == {"ws1": FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_1")}
    assert load_fleet_store(home=tmp_path) == result


def test_run_sync_cycle_merges_with_existing_store(tmp_path: Path):
    # ws0 was minted on a prior cycle and must survive an unrelated sync.
    from agentrail.runner.fleet_credentials import save_fleet_store

    save_fleet_store(
        {"ws0": FleetWorkspaceToken(workspace_id="ws0", slug="old", token="rt_0")}, home=tmp_path
    )
    transport = FakeTransport(
        [Response(status=200, body=b'{"minted":[],"active":["ws0"],"revoked":[]}')]
    )
    result = run_sync_cycle(
        base_url="https://app.agentrail.dev",
        console_token="fleet-secret",
        home=tmp_path,
        transport=transport,
    )
    assert "ws0" in result


def test_run_sync_cycle_warns_loudly_on_drift_naming_workspace_ids(tmp_path: Path):
    transport = FakeTransport(
        [Response(status=200, body=b'{"minted":[],"active":["ws-drifted"],"revoked":[]}')]
    )
    warnings: List[str] = []
    run_sync_cycle(
        base_url="https://app.agentrail.dev",
        console_token="fleet-secret",
        home=tmp_path,
        transport=transport,
        warn=warnings.append,
    )
    assert len(warnings) == 1
    assert "ws-drifted" in warnings[0]
    # The recovery path must be spelled out, not just "there's a problem".
    assert "revoke" in warnings[0].lower()


def test_run_sync_cycle_drift_warning_never_contains_a_token(tmp_path: Path):
    # The drifted workspace has NO token in this instance (that's the whole
    # point of drift) — but assert defensively that the console token used to
    # authenticate the call never leaks into the warning either.
    transport = FakeTransport(
        [Response(status=200, body=b'{"minted":[],"active":["ws-drifted"],"revoked":[]}')]
    )
    warnings: List[str] = []
    run_sync_cycle(
        base_url="https://app.agentrail.dev",
        console_token="super-secret-console-token",
        home=tmp_path,
        transport=transport,
        warn=warnings.append,
    )
    assert "super-secret-console-token" not in warnings[0]


def test_run_sync_cycle_warns_on_failed_bucket_naming_workspaces_and_reasons(tmp_path: Path):
    transport = FakeTransport(
        [
            Response(
                status=200,
                body=(
                    b'{"minted":[],"active":[],"revoked":[],'
                    b'"failed":[{"workspaceId":"ws-broken","reason":"mint_failed"}]}'
                ),
            )
        ]
    )
    warnings: List[str] = []
    run_sync_cycle(
        base_url="https://app.agentrail.dev",
        console_token="fleet-secret",
        home=tmp_path,
        transport=transport,
        warn=warnings.append,
    )
    assert len(warnings) == 1
    assert "ws-broken" in warnings[0]
    assert "mint_failed" in warnings[0]
    # And it must say retry happens automatically (route contract: the fleet
    # "warns on a non-empty `failed` and simply retries ... on its next sync").
    assert "next sync" in warnings[0]


def test_run_sync_cycle_failed_bucket_does_not_touch_the_store(tmp_path: Path):
    # A revoke_failed workspace's key is still active server-side, so keeping
    # our stored token is CORRECT until the revoke actually lands; a
    # mint_failed workspace never handed us a token. Either way: no store change.
    from agentrail.runner.fleet_credentials import save_fleet_store

    original = {"ws1": FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_1")}
    save_fleet_store(original, home=tmp_path)
    transport = FakeTransport(
        [
            Response(
                status=200,
                body=(
                    b'{"minted":[],"active":["ws1"],"revoked":[],'
                    b'"failed":[{"workspaceId":"ws1","reason":"revoke_failed"},'
                    b'{"workspaceId":"ws2","reason":"mint_failed"}]}'
                ),
            )
        ]
    )
    result = run_sync_cycle(
        base_url="https://app.agentrail.dev",
        console_token="fleet-secret",
        home=tmp_path,
        transport=transport,
        warn=lambda _msg: None,
    )
    assert result == original
    assert load_fleet_store(home=tmp_path) == original


def test_run_sync_cycle_no_drift_warning_when_everything_reconciles(tmp_path: Path):
    transport = FakeTransport(
        [
            Response(
                status=200,
                body=b'{"minted":[{"workspaceId":"ws1","slug":"a","token":"rt_1"}],'
                     b'"active":[],"revoked":[]}',
            )
        ]
    )
    warnings: List[str] = []
    run_sync_cycle(
        base_url="https://app.agentrail.dev",
        console_token="fleet-secret",
        home=tmp_path,
        transport=transport,
        warn=warnings.append,
    )
    assert warnings == []


def test_run_sync_cycle_raises_and_does_not_touch_store_on_failure(tmp_path: Path):
    from agentrail.runner.fleet_credentials import save_fleet_store

    original = {"ws1": FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_1")}
    save_fleet_store(original, home=tmp_path)
    transport = FakeTransport([Response(status=500, body=b"boom")])
    with pytest.raises(FleetSyncError):
        run_sync_cycle(
            base_url="https://app.agentrail.dev",
            console_token="fleet-secret",
            home=tmp_path,
            transport=transport,
        )
    # The existing store must be left exactly as it was (periodic-resync
    # failure keeps serving the existing store — this is what makes that true).
    assert load_fleet_store(home=tmp_path) == original


# --- No token ever lands in a log record ------------------------------------


# --- sync_fleet_tokens: parses the `stalled` bucket -------------------------


def test_sync_parses_stalled_bucket():
    transport = FakeTransport(
        [
            Response(
                status=200,
                body=(
                    b'{"minted":[],"active":[],"revoked":[],"failed":[],'
                    b'"stalled":[{"workspaceId":"ws-stuck","slug":"stuck-co",'
                    b'"staleQueuedCount":3,"oldestQueuedMinutes":42}]}'
                ),
            )
        ]
    )
    result = sync_fleet_tokens(
        base_url="https://app.agentrail.dev", console_token="t", transport=transport
    )
    assert result.stalled == [
        FleetStalledWorkspace(
            workspace_id="ws-stuck", slug="stuck-co", stale_queued_count=3, oldest_queued_minutes=42
        )
    ]


def test_sync_stalled_bucket_defaults_to_empty_when_absent():
    # An older console that predates the `stalled` field must never crash this.
    transport = FakeTransport([Response(status=200, body=b"{}")])
    result = sync_fleet_tokens(
        base_url="https://app.agentrail.dev", console_token="t", transport=transport
    )
    assert result.stalled == []


# --- self_heal_workspace_token: HTTP + parsing (never raises) ---------------


def test_self_heal_posts_to_the_self_heal_route_with_bearer_and_body():
    transport = FakeTransport(
        [Response(status=200, body=b'{"ok":true,"workspaceId":"ws1","slug":"acme","token":"ar_new"}')]
    )
    self_heal_workspace_token(
        base_url="https://app.agentrail.dev/",
        console_token="fleet-secret",
        workspace_id="ws1",
        fleet_instance_id="fleet-host-abc",
        transport=transport,
    )
    call = transport.calls[0]
    assert call["method"] == "POST"
    assert call["url"] == "https://app.agentrail.dev/api/v1/fleet/workspace-tokens/self-heal"
    assert call["headers"]["Authorization"] == "Bearer fleet-secret"
    import json as _json

    body = _json.loads(call["body"])
    assert body == {"workspaceId": "ws1", "fleetInstanceId": "fleet-host-abc"}


def test_self_heal_parses_a_successful_rotation():
    transport = FakeTransport(
        [Response(status=200, body=b'{"ok":true,"workspaceId":"ws1","slug":"acme","token":"ar_new"}')]
    )
    result = self_heal_workspace_token(
        base_url="https://app.agentrail.dev",
        console_token="t",
        workspace_id="ws1",
        fleet_instance_id="fleet-1",
        transport=transport,
    )
    assert result == SelfHealResult(
        ok=True, token=FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="ar_new")
    )


def test_self_heal_parses_a_cooldown_refusal_with_retry_after():
    transport = FakeTransport(
        [Response(status=200, body=b'{"ok":false,"reason":"cooldown","retryAfterSeconds":42}')]
    )
    result = self_heal_workspace_token(
        base_url="https://app.agentrail.dev",
        console_token="t",
        workspace_id="ws1",
        fleet_instance_id="fleet-1",
        transport=transport,
    )
    assert result.ok is False
    assert result.reason == "cooldown"
    assert result.retry_after_seconds == 42


def test_self_heal_never_raises_on_a_connection_error():
    transport = FakeTransport([OSError("connection refused")])
    result = self_heal_workspace_token(
        base_url="https://app.agentrail.dev",
        console_token="t",
        workspace_id="ws1",
        fleet_instance_id="fleet-1",
        transport=transport,
    )
    assert result.ok is False
    assert result.reason is not None


def test_self_heal_never_raises_on_a_non_2xx_status():
    transport = FakeTransport([Response(status=500, body=b"internal error")])
    result = self_heal_workspace_token(
        base_url="https://app.agentrail.dev",
        console_token="t",
        workspace_id="ws1",
        fleet_instance_id="fleet-1",
        transport=transport,
    )
    assert result.ok is False


def test_self_heal_never_raises_on_invalid_json():
    transport = FakeTransport([Response(status=200, body=b"not json")])
    result = self_heal_workspace_token(
        base_url="https://app.agentrail.dev",
        console_token="t",
        workspace_id="ws1",
        fleet_instance_id="fleet-1",
        transport=transport,
    )
    assert result.ok is False


def test_self_heal_error_reason_never_contains_the_console_token():
    transport = FakeTransport([Response(status=500, body=b"internal error")])
    result = self_heal_workspace_token(
        base_url="https://app.agentrail.dev",
        console_token="super-secret-fleet-token",
        workspace_id="ws1",
        fleet_instance_id="fleet-1",
        transport=transport,
    )
    assert "super-secret-fleet-token" not in (result.reason or "")


# --- run_sync_cycle: self-heal integration (fleet_instance_id opt-in) -------


def test_run_sync_cycle_self_heals_a_drifted_workspace_and_resumes_claims(tmp_path: Path):
    # Sync call reports ws-drifted active (console believes it has a key) but
    # this instance's store is empty for it; self-heal call succeeds.
    transport = FakeTransport(
        [
            Response(status=200, body=b'{"minted":[],"active":["ws-drifted"],"revoked":[]}'),
            Response(
                status=200,
                body=b'{"ok":true,"workspaceId":"ws-drifted","slug":"acme","token":"ar_healed"}',
            ),
        ]
    )
    warnings: List[str] = []
    result = run_sync_cycle(
        base_url="https://app.agentrail.dev",
        console_token="fleet-secret",
        home=tmp_path,
        transport=transport,
        warn=warnings.append,
        fleet_instance_id="fleet-host-abc",
    )
    # The healed token is folded into the store exactly like an ordinary mint.
    assert result == {
        "ws-drifted": FleetWorkspaceToken(workspace_id="ws-drifted", slug="acme", token="ar_healed")
    }
    assert load_fleet_store(home=tmp_path) == result
    # The OLD manual-recovery fallback must NOT fire — self-heal resolved it.
    assert not any("Recovery: revoke" in w for w in warnings)
    # But the self-heal success itself is logged (log every decision).
    assert any("self-heal" in w and "ws-drifted" in w for w in warnings)


def test_run_sync_cycle_self_heal_declined_falls_back_to_the_manual_recovery_warning(tmp_path: Path):
    transport = FakeTransport(
        [
            Response(status=200, body=b'{"minted":[],"active":["ws-drifted"],"revoked":[]}'),
            Response(status=200, body=b'{"ok":false,"reason":"cooldown","retryAfterSeconds":30}'),
        ]
    )
    warnings: List[str] = []
    result = run_sync_cycle(
        base_url="https://app.agentrail.dev",
        console_token="fleet-secret",
        home=tmp_path,
        transport=transport,
        warn=warnings.append,
        fleet_instance_id="fleet-host-abc",
    )
    assert result == {}
    # The fallback warning still fires, naming the workspace and the recovery path.
    assert any("Recovery: revoke" in w and "ws-drifted" in w for w in warnings)
    # A cooldown/declined refusal must NOT be retried (only ONE self-heal call).
    assert len(transport.calls) == 2  # one sync + exactly one self-heal attempt


def test_run_sync_cycle_self_heal_retries_transient_failures_with_bounded_backoff(tmp_path: Path):
    transport = FakeTransport(
        [
            Response(status=200, body=b'{"minted":[],"active":["ws-drifted"],"revoked":[]}'),
            Response(status=500, body=b"boom"),  # attempt 1: transient
            Response(status=500, body=b"boom"),  # attempt 2: transient
            Response(
                status=200,
                body=b'{"ok":true,"workspaceId":"ws-drifted","slug":"acme","token":"ar_healed"}',
            ),  # attempt 3: succeeds
        ]
    )
    sleeps: List[float] = []
    warnings: List[str] = []
    result = run_sync_cycle(
        base_url="https://app.agentrail.dev",
        console_token="fleet-secret",
        home=tmp_path,
        transport=transport,
        warn=warnings.append,
        fleet_instance_id="fleet-host-abc",
        self_heal_max_attempts=3,
        sleep=sleeps.append,
    )
    assert "ws-drifted" in result
    assert len(transport.calls) == 4  # sync + 3 self-heal attempts
    # Bounded backoff: slept between attempts 1->2 and 2->3, never after the
    # final (successful) attempt.
    assert sleeps == [1.0, 2.0]


def test_run_sync_cycle_self_heal_exhausts_retries_then_falls_back(tmp_path: Path):
    transport = FakeTransport(
        [
            Response(status=200, body=b'{"minted":[],"active":["ws-drifted"],"revoked":[]}'),
            Response(status=500, body=b"boom"),
            Response(status=500, body=b"boom"),
            Response(status=500, body=b"boom"),
        ]
    )
    sleeps: List[float] = []
    warnings: List[str] = []
    result = run_sync_cycle(
        base_url="https://app.agentrail.dev",
        console_token="fleet-secret",
        home=tmp_path,
        transport=transport,
        warn=warnings.append,
        fleet_instance_id="fleet-host-abc",
        self_heal_max_attempts=3,
        sleep=sleeps.append,
    )
    assert result == {}
    assert len(transport.calls) == 4  # sync + exactly 3 self-heal attempts, bounded
    assert sleeps == [1.0, 2.0]  # never slept after the 3rd (final) attempt
    # Falls back to the SAME manual-recovery line as before self-heal existed.
    assert any("Recovery: revoke" in w and "ws-drifted" in w for w in warnings)
    # And the exhaustion itself is logged (log every decision).
    assert any("exhausted" in w and "ws-drifted" in w for w in warnings)


def test_run_sync_cycle_self_heal_is_off_by_default_no_fleet_instance_id(tmp_path: Path):
    # Omitting fleet_instance_id (every pre-existing caller) must never call
    # the self-heal route at all — only the immediate fallback warning fires,
    # byte-identical to the pre-self-heal behavior.
    transport = FakeTransport(
        [Response(status=200, body=b'{"minted":[],"active":["ws-drifted"],"revoked":[]}')]
    )
    warnings: List[str] = []
    result = run_sync_cycle(
        base_url="https://app.agentrail.dev",
        console_token="fleet-secret",
        home=tmp_path,
        transport=transport,
        warn=warnings.append,
    )
    assert result == {}
    assert len(transport.calls) == 1  # sync only — self-heal never attempted
    assert any("Recovery: revoke" in w for w in warnings)


def test_run_sync_cycle_multiple_drifted_workspaces_are_healed_independently(tmp_path: Path):
    transport = FakeTransport(
        [
            Response(
                status=200,
                body=b'{"minted":[],"active":["ws-a","ws-b"],"revoked":[]}',
            ),
            Response(
                status=200,
                body=b'{"ok":true,"workspaceId":"ws-a","slug":"a","token":"ar_a"}',
            ),
            Response(status=200, body=b'{"ok":false,"reason":"not_hosted"}'),
        ]
    )
    warnings: List[str] = []
    result = run_sync_cycle(
        base_url="https://app.agentrail.dev",
        console_token="fleet-secret",
        home=tmp_path,
        transport=transport,
        warn=warnings.append,
        fleet_instance_id="fleet-host-abc",
    )
    assert result == {"ws-a": FleetWorkspaceToken(workspace_id="ws-a", slug="a", token="ar_a")}
    # ws-b could not be healed (not_hosted, never retried) -> still in the
    # fallback warning; ws-a must NOT be.
    fallback = [w for w in warnings if "Recovery: revoke" in w]
    assert len(fallback) == 1
    assert "ws-b" in fallback[0]
    assert "ws-a" not in fallback[0]


def test_run_sync_cycle_warns_loudly_and_repeatedly_on_a_stalled_bucket(tmp_path: Path):
    transport = FakeTransport(
        [
            Response(
                status=200,
                body=(
                    b'{"minted":[],"active":[],"revoked":[],"failed":[],'
                    b'"stalled":[{"workspaceId":"ws-stuck","slug":"stuck-co",'
                    b'"staleQueuedCount":3,"oldestQueuedMinutes":42}]}'
                ),
            )
        ]
    )
    warnings: List[str] = []
    run_sync_cycle(
        base_url="https://app.agentrail.dev",
        console_token="fleet-secret",
        home=tmp_path,
        transport=transport,
        warn=warnings.append,
    )
    stalled_warnings = [w for w in warnings if "STALLED" in w]
    assert len(stalled_warnings) == 1
    assert "ws-stuck" in stalled_warnings[0]
    assert "42" in stalled_warnings[0]  # the oldest-queued-minutes figure


def test_no_token_appears_in_any_log_record(tmp_path: Path, caplog):
    caplog.set_level(logging.DEBUG)
    transport = FakeTransport(
        [
            Response(
                status=200,
                body=b'{"minted":[{"workspaceId":"ws1","slug":"acme","token":"THE_SECRET_TOKEN"}],'
                     b'"active":["ws-drifted"],"revoked":[]}',
            )
        ]
    )
    run_sync_cycle(
        base_url="https://app.agentrail.dev",
        console_token="THE_CONSOLE_SECRET",
        home=tmp_path,
        transport=transport,
        warn=lambda _msg: None,
    )
    for record in caplog.records:
        assert "THE_SECRET_TOKEN" not in record.getMessage()
        assert "THE_CONSOLE_SECRET" not in record.getMessage()
