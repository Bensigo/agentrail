"""Unit tests for ``select_sandbox_runner`` (AC3).

The selector picks the execution backend purely from ``env``:

- host-native by default for local dev (no ``ANTHROPIC_API_KEY``) — the agent
  CLI uses the host login + its own native sandbox;
- Docker when ``ANTHROPIC_API_KEY`` is set (CI / cloud, API-key auth).
"""
from __future__ import annotations

from agentrail.sandbox.docker_runner import run_issue_in_sandbox
from agentrail.sandbox.native_runner import run_issue_on_host, select_sandbox_runner


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
