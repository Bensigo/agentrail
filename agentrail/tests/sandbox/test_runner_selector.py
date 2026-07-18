"""Unit tests for ``select_sandbox_runner`` (AC3) and its docker-sandbox env
passthrough allowlist (#1267 PR④ items 1-2).

The selector picks the execution backend, checked in this order:

1. Explicit ``AGENTRAIL_SANDBOX`` ∈ {"host", "docker"} always wins.
2. Legacy trigger (unchanged): Docker when ``ANTHROPIC_API_KEY`` is set (CI /
   cloud, API-key auth), host-native otherwise (local dev — the agent CLI
   uses the host login + its own native sandbox).

Either way, Docker mode is never the bare ``run_issue_in_sandbox`` — it is
wrapped so its ``env`` is reduced to an explicit allowlist before the
sandbox container ever sees it (item 2), so these tests unwrap via
``__wrapped__`` (set by ``functools.wraps``) wherever they need to assert
identity against the real target function.
"""
from __future__ import annotations

import inspect

from agentrail.sandbox.docker_runner import run_issue_in_sandbox
from agentrail.sandbox.native_runner import (
    filter_docker_sandbox_env,
    run_issue_on_host,
    select_sandbox_runner,
)


def _unwrap(runner):
    """The real target under the docker-sandbox env-allowlist wrapper, or
    ``runner`` itself when it isn't wrapped (host-native is never wrapped)."""
    return getattr(runner, "__wrapped__", runner)


# --- Legacy trigger (pre-#1267-PR④ SELECTION behaviour — byte-identical) ----


def test_host_native_when_no_api_key() -> None:
    assert select_sandbox_runner({}) is run_issue_on_host


def test_host_native_when_api_key_blank() -> None:
    assert select_sandbox_runner({"ANTHROPIC_API_KEY": ""}) is run_issue_on_host


def test_docker_when_api_key_present() -> None:
    assert _unwrap(select_sandbox_runner({"ANTHROPIC_API_KEY": "sk-ant-xxx"})) is run_issue_in_sandbox


def test_other_env_keys_do_not_force_docker() -> None:
    env = {"GIT_TOKEN": "ght", "AGENTRAIL_SERVER_URL": "https://srv"}
    assert select_sandbox_runner(env) is run_issue_on_host


# --- AGENTRAIL_SANDBOX explicit override — six-cell selection matrix --------
#
# {AGENTRAIL_SANDBOX unset/host/docker} x {ANTHROPIC_API_KEY set/empty}. The
# two "unset" cells (above) must stay byte-identical to the pre-#1267-PR④
# SELECTION behavior — an explicit value only ever OVERRIDES, it never
# removes, the legacy trigger.


def test_matrix_unset_key_empty_is_host_native():
    assert select_sandbox_runner({}) is run_issue_on_host


def test_matrix_unset_key_set_is_docker_via_legacy_trigger():
    assert (
        _unwrap(select_sandbox_runner({"ANTHROPIC_API_KEY": "sk-ant-xxx"}))
        is run_issue_in_sandbox
    )


def test_matrix_explicit_host_key_empty_is_host_native():
    assert select_sandbox_runner({"AGENTRAIL_SANDBOX": "host"}) is run_issue_on_host


def test_matrix_explicit_host_key_set_stays_host_native():
    # Explicit host WINS even though the legacy trigger alone would have
    # picked docker for a bare ANTHROPIC_API_KEY.
    assert (
        select_sandbox_runner(
            {"AGENTRAIL_SANDBOX": "host", "ANTHROPIC_API_KEY": "sk-ant-xxx"}
        )
        is run_issue_on_host
    )


def test_matrix_explicit_docker_key_empty_is_docker():
    # The hosted fleet's exact case: ANTHROPIC_API_KEY is structurally always
    # empty (OpenRouter auth rides ANTHROPIC_AUTH_TOKEN instead) — only an
    # explicit AGENTRAIL_SANDBOX=docker can select Docker-sandbox mode for it;
    # the legacy trigger alone can never express this.
    assert (
        _unwrap(select_sandbox_runner({"AGENTRAIL_SANDBOX": "docker", "ANTHROPIC_API_KEY": ""}))
        is run_issue_in_sandbox
    )


def test_matrix_explicit_docker_key_set_is_docker():
    assert (
        _unwrap(
            select_sandbox_runner(
                {"AGENTRAIL_SANDBOX": "docker", "ANTHROPIC_API_KEY": "sk-ant-xxx"}
            )
        )
        is run_issue_in_sandbox
    )


# --- Robustness of the explicit override -------------------------------------


def test_sandbox_mode_is_case_and_whitespace_insensitive():
    assert _unwrap(select_sandbox_runner({"AGENTRAIL_SANDBOX": " Docker "})) is run_issue_in_sandbox
    assert select_sandbox_runner({"AGENTRAIL_SANDBOX": " HOST "}) is run_issue_on_host


def test_unrecognized_sandbox_mode_warns_and_falls_back_to_legacy_trigger(capsys):
    # A typo must not crash the runner — it warns loudly and behaves as if
    # AGENTRAIL_SANDBOX were unset (legacy trigger decides).
    result = select_sandbox_runner({"AGENTRAIL_SANDBOX": "dcoker"})
    assert result is run_issue_on_host  # no ANTHROPIC_API_KEY -> legacy host-native
    err = capsys.readouterr().err
    assert "AGENTRAIL_SANDBOX" in err
    assert "dcoker" in err

    result = select_sandbox_runner({"AGENTRAIL_SANDBOX": "dcoker", "ANTHROPIC_API_KEY": "k"})
    assert _unwrap(result) is run_issue_in_sandbox  # legacy trigger: key present -> docker


# --- Docker-sandbox env passthrough allowlist (#1267 PR④ item 2) ------------


def test_filter_docker_sandbox_env_keeps_only_the_allowlist():
    env = {
        # Allowlisted — the OpenRouter/hosted runtime contract.
        "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
        "ANTHROPIC_AUTH_TOKEN": "or-secret",
        "CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK": "1",
        "AGENTRAIL_HOSTED": "1",
        "AGENTRAIL_CLAUDE_COMMAND": "claude --bare -p --dangerously-skip-permissions",
        "AGENTRAIL_HOSTED_CONFIG": "/opt/agentrail/agentrail-config.hosted.json",
        # Allowlisted — the legacy CI/cloud sandbox-image contract.
        "ANTHROPIC_API_KEY": "sk-ant-xxx",
        "OPENAI_API_KEY": "sk-oai-xxx",
        # Allowlisted — per-run secrets.
        "GIT_TOKEN": "ght-workspace",
        "AGENTRAIL_MCP_LINEAR_KEY": "lin-key",
        "AGENTRAIL_MCP_FIGMA_KEY": "fig-key",
        # Allowlisted — dashboard cost/telemetry link.
        "AGENTRAIL_SERVER_BASE_URL": "https://console.example",
        "AGENTRAIL_SERVER_API_KEY": "dash-key",
        "AGENTRAIL_SERVER_REPOSITORY_ID": "repo-1",
        # NOT allowlisted — must never reach the container.
        "PATH": "/usr/bin",
        "HOME": "/root",
        "FLEET_CONSOLE_TOKEN": "fleet-secret",
        "OPENROUTER_API_KEY": "raw-openrouter-key",
        "AGENTRAIL_FLEET_HOME": "/root/.agentrail",
        "SOME_RANDOM_VAR": "whatever",
    }
    filtered = filter_docker_sandbox_env(env)
    assert filtered == {
        "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
        "ANTHROPIC_AUTH_TOKEN": "or-secret",
        "CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK": "1",
        "AGENTRAIL_HOSTED": "1",
        "AGENTRAIL_CLAUDE_COMMAND": "claude --bare -p --dangerously-skip-permissions",
        "AGENTRAIL_HOSTED_CONFIG": "/opt/agentrail/agentrail-config.hosted.json",
        "ANTHROPIC_API_KEY": "sk-ant-xxx",
        "OPENAI_API_KEY": "sk-oai-xxx",
        "GIT_TOKEN": "ght-workspace",
        "AGENTRAIL_MCP_LINEAR_KEY": "lin-key",
        "AGENTRAIL_MCP_FIGMA_KEY": "fig-key",
        "AGENTRAIL_SERVER_BASE_URL": "https://console.example",
        "AGENTRAIL_SERVER_API_KEY": "dash-key",
        "AGENTRAIL_SERVER_REPOSITORY_ID": "repo-1",
    }


def test_filter_docker_sandbox_env_handles_empty_and_none():
    assert filter_docker_sandbox_env({}) == {}
    assert filter_docker_sandbox_env(None) == {}  # type: ignore[arg-type]


def test_docker_sandbox_env_is_filtered_before_reaching_the_container():
    """End-to-end through select_sandbox_runner's returned callable: the
    fleet's own full-os.environ-derived dict must not leak wholesale into
    the spawned sandbox container."""
    import json

    from agentrail.sandbox.docker_runner import ContainerResult, RESULT_BEGIN, RESULT_END

    calls = []

    def fake_run_container(cmd, *, env=None, timeout=None):
        calls.append({"cmd": list(cmd), "env": dict(env or {})})
        if len(calls) == 1:
            payload = json.dumps(
                {"status": "green", "cost_usd": 0.0, "branch": "", "gate_reason": ""}
            )
            return ContainerResult(exit_code=0, stdout=f"{RESULT_BEGIN}\n{payload}\n{RESULT_END}\n")
        return ContainerResult(exit_code=0)  # the teardown `docker rm`

    runner = select_sandbox_runner({"AGENTRAIL_SANDBOX": "docker"})
    runner(
        repo_url="https://github.com/acme/widgets.git",
        ref="main",
        issue_ref="7",
        workspace_id="ws-1",
        env={
            "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
            "ANTHROPIC_AUTH_TOKEN": "or-secret",
            "GIT_TOKEN": "ght-workspace",
            "AGENTRAIL_MCP_LINEAR_KEY": "lin-key",
            "AGENTRAIL_SERVER_API_KEY": "dash-key",
            # Must NOT reach the container:
            "FLEET_CONSOLE_TOKEN": "fleet-secret",
            "OPENROUTER_API_KEY": "raw-openrouter-key",
            "HOME": "/root",
            "PATH": "/usr/bin",
        },
        run_container=fake_run_container,
    )

    forwarded = calls[0]["env"]
    assert forwarded == {
        "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
        "ANTHROPIC_AUTH_TOKEN": "or-secret",
        "GIT_TOKEN": "ght-workspace",
        "AGENTRAIL_MCP_LINEAR_KEY": "lin-key",
        "AGENTRAIL_SERVER_API_KEY": "dash-key",
    }
    for leaked in ("FLEET_CONSOLE_TOKEN", "OPENROUTER_API_KEY", "HOME", "PATH"):
        assert leaked not in forwarded


def test_docker_wrapper_preserves_introspectable_signature_for_make_execute():
    """agentrail.cli.commands.runner._make_execute decides which kwargs to
    pass by introspecting the selected runner's signature
    (``"model" in inspect.signature(runner).parameters``, etc.). The
    env-allowlist wrapper must not hide run_issue_in_sandbox's real
    parameters behind a bare **kwargs, or Docker-sandbox mode would silently
    stop receiving `model` on an escalation retry."""
    runner = select_sandbox_runner({"AGENTRAIL_SANDBOX": "docker"})
    params = inspect.signature(runner).parameters
    assert set(params) == set(inspect.signature(run_issue_in_sandbox).parameters)
    assert "model" in params
    assert "env" in params
    assert "run_id" not in params  # run_issue_in_sandbox never had this param
