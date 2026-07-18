"""Unit tests for ``select_sandbox_runner`` (AC3; #1267 PR④ item 1).

The selector picks the execution backend, checked in this order:

1. Explicit ``AGENTRAIL_SANDBOX`` ∈ {"host", "docker"} always wins.
2. Legacy trigger (unchanged): Docker when ``ANTHROPIC_API_KEY`` is set (CI /
   cloud, API-key auth), host-native otherwise (local dev — the agent CLI
   uses the host login + its own native sandbox).
"""
from __future__ import annotations

from agentrail.sandbox.docker_runner import run_issue_in_sandbox
from agentrail.sandbox.native_runner import run_issue_on_host, select_sandbox_runner


# --- Legacy trigger (pre-#1267-PR④ behaviour — byte-identical) --------------


def test_host_native_when_no_api_key() -> None:
    assert select_sandbox_runner({}) is run_issue_on_host


def test_host_native_when_api_key_blank() -> None:
    assert select_sandbox_runner({"ANTHROPIC_API_KEY": ""}) is run_issue_on_host


def test_docker_when_api_key_present() -> None:
    assert (
        select_sandbox_runner({"ANTHROPIC_API_KEY": "sk-ant-xxx"})
        is run_issue_in_sandbox
    )


def test_other_env_keys_do_not_force_docker() -> None:
    env = {"GIT_TOKEN": "ght", "AGENTRAIL_SERVER_URL": "https://srv"}
    assert select_sandbox_runner(env) is run_issue_on_host


# --- AGENTRAIL_SANDBOX explicit override — six-cell selection matrix --------
#
# {AGENTRAIL_SANDBOX unset/host/docker} x {ANTHROPIC_API_KEY set/empty}. The
# two "unset" cells (above) must stay byte-identical to the pre-#1267-PR④
# behavior — an explicit value only ever OVERRIDES, it never removes, the
# legacy trigger.


def test_matrix_unset_key_empty_is_host_native():
    assert select_sandbox_runner({}) is run_issue_on_host


def test_matrix_unset_key_set_is_docker_via_legacy_trigger():
    assert (
        select_sandbox_runner({"ANTHROPIC_API_KEY": "sk-ant-xxx"})
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
        select_sandbox_runner({"AGENTRAIL_SANDBOX": "docker", "ANTHROPIC_API_KEY": ""})
        is run_issue_in_sandbox
    )


def test_matrix_explicit_docker_key_set_is_docker():
    assert (
        select_sandbox_runner(
            {"AGENTRAIL_SANDBOX": "docker", "ANTHROPIC_API_KEY": "sk-ant-xxx"}
        )
        is run_issue_in_sandbox
    )


# --- Robustness of the explicit override -------------------------------------


def test_sandbox_mode_is_case_and_whitespace_insensitive():
    assert select_sandbox_runner({"AGENTRAIL_SANDBOX": " Docker "}) is run_issue_in_sandbox
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
    assert result is run_issue_in_sandbox  # legacy trigger: key present -> docker
