"""Tests for ``agentrail fleet``'s CLI wiring (agentrail/cli/commands/fleet.py).

These test the GLUE only — env var validation, help/unknown-arg handling, and
that a successful boot sync feeds the right workspaces into the claim loop
while a failed one never starts it at all. The actual claim/rotation/sync
mechanics are exercised hermetically in test_fleet_worker.py / test_fleet_sync.py;
here we mock ``run_sync_cycle`` / ``run_fleet_worker`` themselves (the same
"mock the downstream call, assert the wiring" style
agentrail/tests/cli/test_auth_gate.py already uses for dispatch), rather than
letting a real infinite loop / background thread run in a unit test.
"""
from __future__ import annotations

import os
from types import SimpleNamespace
from typing import Any, Dict, List
from unittest.mock import MagicMock, patch

import agentrail.cli.commands.fleet as fleet_cmd
import agentrail.cli.commands.runner as runner_cmd
from agentrail.runner.fleet_credentials import FleetWorkspaceToken
from agentrail.runner.fleet_sync import FleetSyncError
from agentrail.runner.fleet_worker import WorkspaceRotation
from agentrail.sandbox.docker_runner import RunResult


def _clean_env(**overrides) -> Dict[str, str]:
    base = {"AGENTRAIL_SERVER_BASE_URL": "https://app.agentrail.dev", "FLEET_CONSOLE_TOKEN": "fleet-secret"}
    base.update(overrides)
    return {k: v for k, v in base.items() if v is not None}


# --- --help / unknown args ---------------------------------------------------


def test_help_flag_prints_docstring_and_returns_zero(capsys):
    rc = fleet_cmd.run_fleet(["--help"])
    assert rc == 0
    assert "agentrail fleet" in capsys.readouterr().out


def test_unknown_option_errors(capsys):
    rc = fleet_cmd.run_fleet(["--bogus"])
    assert rc == 1
    assert "unknown option" in capsys.readouterr().err


# --- Required env vars --------------------------------------------------------


def test_missing_both_required_env_vars_errors_naming_both(capsys):
    with patch.dict(os.environ, {}, clear=True):
        rc = fleet_cmd.run_fleet([])
    assert rc == 1
    err = capsys.readouterr().err
    assert "AGENTRAIL_SERVER_BASE_URL" in err
    assert "FLEET_CONSOLE_TOKEN" in err


def test_missing_only_console_token_names_just_that_one(capsys):
    with patch.dict(
        os.environ, {"AGENTRAIL_SERVER_BASE_URL": "https://app.agentrail.dev"}, clear=True
    ):
        rc = fleet_cmd.run_fleet([])
    err = capsys.readouterr().err
    assert "FLEET_CONSOLE_TOKEN" in err
    assert "AGENTRAIL_SERVER_BASE_URL" not in err
    assert rc == 1


def test_missing_env_vars_never_calls_sync_or_worker():
    with patch.dict(os.environ, {}, clear=True), \
         patch.object(fleet_cmd, "run_sync_cycle") as mock_sync, \
         patch.object(fleet_cmd, "run_fleet_worker") as mock_worker:
        fleet_cmd.run_fleet([])
    mock_sync.assert_not_called()
    mock_worker.assert_not_called()


# --- Boot sync failure vs success ---------------------------------------------


def test_boot_sync_failure_exits_nonzero_and_never_starts_the_worker(capsys):
    with patch.dict(os.environ, _clean_env(), clear=True), \
         patch.object(fleet_cmd, "run_sync_cycle", side_effect=FleetSyncError("HTTP 404")) as mock_sync, \
         patch.object(fleet_cmd, "run_fleet_worker") as mock_worker:
        rc = fleet_cmd.run_fleet([])
    assert rc == 1
    assert "HTTP 404" in capsys.readouterr().err
    mock_sync.assert_called_once()
    mock_worker.assert_not_called()


def test_successful_boot_starts_the_worker_with_the_synced_workspaces(capsys):
    tokens = {
        "ws1": FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_1"),
        "ws2": FleetWorkspaceToken(workspace_id="ws2", slug="widgets", token="rt_2"),
    }
    with patch.dict(os.environ, _clean_env(), clear=True), \
         patch.object(fleet_cmd, "run_sync_cycle", return_value=tokens), \
         patch.object(fleet_cmd, "run_fleet_worker") as mock_worker:
        rc = fleet_cmd.run_fleet([])
    assert rc == 0
    mock_worker.assert_called_once()
    rotation = mock_worker.call_args.args[0]
    assert isinstance(rotation, WorkspaceRotation)
    assert sorted(rotation.workspace_ids()) == ["ws1", "ws2"]
    assert "2 workspace(s)" in capsys.readouterr().out


def test_default_concurrency_is_two_when_env_unset():
    with patch.dict(os.environ, _clean_env(), clear=True), \
         patch.object(fleet_cmd, "run_sync_cycle", return_value={}), \
         patch.object(fleet_cmd, "run_fleet_worker") as mock_worker:
        fleet_cmd.run_fleet([])
    assert mock_worker.call_args.kwargs["concurrency"] == 2


def test_fleet_concurrency_env_var_is_honored():
    with patch.dict(os.environ, _clean_env(FLEET_CONCURRENCY="5"), clear=True), \
         patch.object(fleet_cmd, "run_sync_cycle", return_value={}), \
         patch.object(fleet_cmd, "run_fleet_worker") as mock_worker:
        fleet_cmd.run_fleet([])
    assert mock_worker.call_args.kwargs["concurrency"] == 5


def test_bad_concurrency_env_var_falls_back_to_default(capsys):
    with patch.dict(os.environ, _clean_env(FLEET_CONCURRENCY="not-a-number"), clear=True), \
         patch.object(fleet_cmd, "run_sync_cycle", return_value={}), \
         patch.object(fleet_cmd, "run_fleet_worker") as mock_worker:
        fleet_cmd.run_fleet([])
    assert mock_worker.call_args.kwargs["concurrency"] == 2
    assert "FLEET_CONCURRENCY" in capsys.readouterr().err


def test_sync_interval_below_the_floor_is_clamped(capsys):
    # FLEET_SYNC_INTERVAL_SECONDS=0 would busy-loop the console's sync
    # endpoint — it must clamp to the documented 30s floor, loudly.
    with patch.dict(os.environ, _clean_env(FLEET_SYNC_INTERVAL_SECONDS="0"), clear=True), \
         patch.object(fleet_cmd, "run_sync_cycle", return_value={}), \
         patch.object(fleet_cmd, "run_fleet_worker"):
        fleet_cmd.run_fleet([])
    captured = capsys.readouterr()
    assert "30s" in captured.out  # the banner shows the resolved (clamped) interval, not 0
    assert "clamp" in captured.err.lower()


def test_float_env_clamps_to_minimum(monkeypatch, capsys):
    monkeypatch.setenv("X_INTERVAL", "5")
    assert fleet_cmd._float_env("X_INTERVAL", 300.0, minimum=30.0) == 30.0
    assert "floor" in capsys.readouterr().err
    monkeypatch.setenv("X_INTERVAL", "45")
    assert fleet_cmd._float_env("X_INTERVAL", 300.0, minimum=30.0) == 45.0
    assert capsys.readouterr().err == ""  # above the floor: no warning


def test_sync_interval_env_var_is_passed_to_the_sync_cycle_helper():
    # run_sync_cycle itself doesn't take an interval (it's a single cycle); the
    # interval governs how often run_fleet's own periodic thread re-invokes it.
    # We can't observe the background thread's timing without a real sleep
    # (avoided per house convention), so we only assert env parsing here via
    # the printed banner, which echoes the resolved interval.
    with patch.dict(os.environ, _clean_env(FLEET_SYNC_INTERVAL_SECONDS="60"), clear=True), \
         patch.object(fleet_cmd, "run_sync_cycle", return_value={}), \
         patch.object(fleet_cmd, "run_fleet_worker"):
        with patch("builtins.print") as mock_print:
            fleet_cmd.run_fleet([])
    banner = " ".join(str(c.args[0]) for c in mock_print.call_args_list if c.args)
    assert "60s" in banner


def test_fleet_home_env_var_is_forwarded_to_sync_cycle(tmp_path):
    with patch.dict(os.environ, _clean_env(AGENTRAIL_FLEET_HOME=str(tmp_path)), clear=True), \
         patch.object(fleet_cmd, "run_sync_cycle", return_value={}) as mock_sync, \
         patch.object(fleet_cmd, "run_fleet_worker"):
        fleet_cmd.run_fleet([])
    assert mock_sync.call_args.kwargs["home"] == tmp_path


# --- _run_sync_loop: the periodic re-sync thread's body ----------------------
# Driven directly with a scripted stop event — no real thread, no real sleep.


class _ScriptedStop:
    """Stands in for threading.Event: wait(timeout) records the timeout and
    replays scripted returns (False = tick proceeds, True = shutdown)."""

    def __init__(self, script) -> None:
        self._script = list(script)
        self.waits: List[float] = []

    def wait(self, timeout: float) -> bool:
        self.waits.append(timeout)
        return self._script.pop(0) if self._script else True


def _rotation_of(*workspace_ids: str) -> "fleet_cmd.WorkspaceRotation":
    from agentrail.runner.fleet_worker import WorkspaceRotation, WorkspaceSlot

    return WorkspaceRotation(
        [
            WorkspaceSlot(workspace_id=ws, client=object(), execute=lambda item: None)
            for ws in workspace_ids
        ]
    )


def test_periodic_resync_success_refreshes_the_rotation(tmp_path):
    rotation = _rotation_of("ws-old")
    stop = _ScriptedStop([False, True])  # one tick, then shutdown
    new_tokens = {"ws-new": FleetWorkspaceToken(workspace_id="ws-new", slug="n", token="rt_n")}
    with patch.object(fleet_cmd, "run_sync_cycle", return_value=new_tokens) as mock_sync:
        fleet_cmd._run_sync_loop(
            stop,
            base_url="https://app.agentrail.dev",
            console_token="fleet-secret",
            home=tmp_path,
            sync_interval=60.0,
            rotation=rotation,
        )
    # The tick really ran run_sync_cycle and swapped the rotation to the new set.
    mock_sync.assert_called_once_with(
        base_url="https://app.agentrail.dev", console_token="fleet-secret", home=tmp_path
    )
    assert rotation.workspace_ids() == ["ws-new"]
    # And it paced itself with the configured interval (both waits: the tick's
    # lead-in and the shutdown check).
    assert stop.waits == [60.0, 60.0]


def test_periodic_resync_failure_warns_and_keeps_the_existing_rotation(tmp_path, capsys):
    rotation = _rotation_of("ws-old")
    stop = _ScriptedStop([False, True])  # one (failing) tick, then shutdown
    with patch.object(
        fleet_cmd, "run_sync_cycle", side_effect=FleetSyncError("HTTP 500")
    ):
        fleet_cmd._run_sync_loop(
            stop,
            base_url="https://app.agentrail.dev",
            console_token="fleet-secret",
            home=tmp_path,
            sync_interval=60.0,
            rotation=rotation,
        )
    # Warned, did NOT crash, and the existing rotation keeps serving untouched.
    err = capsys.readouterr().err
    assert "re-sync failed" in err
    assert rotation.workspace_ids() == ["ws-old"]


def test_periodic_resync_recovers_on_the_tick_after_a_failure(tmp_path, capsys):
    # Tick 1 fails (warn, keep serving), tick 2 succeeds (rotation refreshed) —
    # a transient console outage never permanently wedges provisioning.
    rotation = _rotation_of("ws-old")
    stop = _ScriptedStop([False, False, True])
    new_tokens = {"ws-new": FleetWorkspaceToken(workspace_id="ws-new", slug="n", token="rt_n")}
    with patch.object(
        fleet_cmd,
        "run_sync_cycle",
        side_effect=[FleetSyncError("HTTP 502"), new_tokens],
    ):
        fleet_cmd._run_sync_loop(
            stop,
            base_url="https://app.agentrail.dev",
            console_token="fleet-secret",
            home=tmp_path,
            sync_interval=60.0,
            rotation=rotation,
        )
    assert "re-sync failed" in capsys.readouterr().err
    assert rotation.workspace_ids() == ["ws-new"]


# --- build_slots: reuses the existing single-workspace machinery -------------


def test_build_slots_returns_one_slot_per_token():
    tokens = {
        "ws1": FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_1"),
        "ws2": FleetWorkspaceToken(workspace_id="ws2", slug="widgets", token="rt_2"),
    }
    slots = fleet_cmd.build_slots("https://app.agentrail.dev", tokens)
    assert sorted(s.workspace_id for s in slots) == ["ws1", "ws2"]


def test_build_slots_client_uses_the_per_workspace_token():
    tokens = {"ws1": FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_secret_1")}
    slots = fleet_cmd.build_slots("https://app.agentrail.dev", tokens)
    client = slots[0].client
    assert client._token == "rt_secret_1"  # noqa: SLF001 - white-box check
    assert client._workspace_id == "ws1"  # noqa: SLF001


# --- Regression: fleet's per-workspace execute == agentrail runner's own ----


class _FakeSandboxRunner:
    """Stands in for select_sandbox_runner's return value; records kwargs."""

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []

    def __call__(self, *, repo_url, ref, issue_ref, workspace_id, env, **_kw):
        self.calls.append({"env": dict(env)})
        return RunResult(status="green", cost_usd=0.0)


def _work_item():
    from agentrail.runner.client import WorkItem

    return WorkItem(
        id="wi-1", workspace_id="ws1", source="github", external_id="owner/repo#5",
        repo_url="https://github.com/owner/repo", ref="main", title="Fix it", body="b",
        repository_id="repo-1", github_token="gho_workspace_token",
    )


def test_fleet_single_workspace_execute_matches_agentrail_runner_single_workspace_path(monkeypatch):
    """Regression guard (#1267 PR②): a fleet serving exactly ONE workspace must
    produce the SAME run_env `agentrail runner`'s existing single-workspace
    `_make_execute` would for identical inputs — build_slots is not a new
    execution path, it is the OLD `_make_execute` constructed once per
    workspace. If this ever diverges, the single-workspace CLI path has
    silently changed."""
    fake_old = _FakeSandboxRunner()
    fake_new = _FakeSandboxRunner()

    creds = SimpleNamespace(
        base_url="https://app.agentrail.dev", token="rt_secret", workspace_id="ws1"
    )

    monkeypatch.setattr(runner_cmd, "select_sandbox_runner", lambda env: fake_old)
    old_execute = runner_cmd._make_execute(creds)

    tokens = {"ws1": FleetWorkspaceToken(workspace_id="ws1", slug="acme", token="rt_secret")}
    monkeypatch.setattr(runner_cmd, "select_sandbox_runner", lambda env: fake_new)
    slots = fleet_cmd.build_slots("https://app.agentrail.dev", tokens)
    new_execute = slots[0].execute

    item = _work_item()
    old_execute(item)
    new_execute(item)

    assert fake_old.calls[0]["env"] == fake_new.calls[0]["env"]
    # Sanity: prove this actually asserts something non-trivial.
    assert fake_old.calls[0]["env"]["GIT_TOKEN"] == "gho_workspace_token"
    assert fake_old.calls[0]["env"]["AGENTRAIL_SERVER_API_KEY"] == "rt_secret"
