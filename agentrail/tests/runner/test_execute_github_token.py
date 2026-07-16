"""Tests for the runner execute callback's GitHub-token wiring.

Connecting a repo on the console attaches the workspace's GitHub OAuth token to
the claim payload (see the console's runner/claim route + WorkItem.github_token);
``_make_execute`` must thread it into ``GIT_TOKEN`` for the local run so
``native_runner`` can authenticate git clone/push + `gh pr create` WITHOUT a
separately-configured PAT. A claim token must win over whatever GIT_TOKEN is
already in this process's own environment; when the claim carries none at all
(older backend, or a workspace with no linked GitHub owner), the process's own
GIT_TOKEN (if any) is left untouched as the back-compat fallback.
"""
from __future__ import annotations

import os
from types import SimpleNamespace
from typing import Any, Dict

import agentrail.cli.commands.runner as runner_cmd
from agentrail.runner.client import WorkItem
from agentrail.sandbox.docker_runner import RunResult


def _creds() -> SimpleNamespace:
    return SimpleNamespace(
        base_url="https://app.agentrail.dev",
        token="rt_secret",
        workspace_id="ws1",
    )


def _work_item(github_token: str = "") -> WorkItem:
    return WorkItem(
        id="wi-1",
        workspace_id="ws1",
        source="github",
        external_id="owner/repo#5",
        repo_url="https://github.com/owner/repo",
        ref="main",
        title="Fix it",
        body="b",
        repository_id="repo-1",
        github_token=github_token,
    )


class _FakeRunner:
    def __init__(self) -> None:
        self.calls: list[Dict[str, Any]] = []

    def __call__(self, *, repo_url, ref, issue_ref, workspace_id, env, **_kw):
        self.calls.append({"env": env})
        return RunResult(status="green", cost_usd=0.0)


def _execute_with_fake(monkeypatch) -> _FakeRunner:
    fake = _FakeRunner()
    monkeypatch.setattr(runner_cmd, "select_sandbox_runner", lambda env: fake)
    return fake


def test_claim_token_is_threaded_into_git_token(monkeypatch):
    monkeypatch.delenv("GIT_TOKEN", raising=False)
    fake = _execute_with_fake(monkeypatch)
    execute = runner_cmd._make_execute(_creds())
    execute(_work_item(github_token="gho_workspace_token"))
    assert fake.calls[0]["env"]["GIT_TOKEN"] == "gho_workspace_token"


def test_claim_token_overrides_a_locally_configured_git_token(monkeypatch):
    # The workspace's connected token is the source of truth for THIS claim —
    # a stale/different local PAT must not silently win instead.
    monkeypatch.setenv("GIT_TOKEN", "local-pat")
    fake = _execute_with_fake(monkeypatch)
    execute = runner_cmd._make_execute(_creds())
    execute(_work_item(github_token="gho_workspace_token"))
    assert fake.calls[0]["env"]["GIT_TOKEN"] == "gho_workspace_token"


def test_no_claim_token_falls_back_to_local_git_token(monkeypatch):
    # Back-compat: an older backend (or a workspace with no linked GitHub
    # owner) sends no token at all — the runner's own env GIT_TOKEN still works.
    monkeypatch.setenv("GIT_TOKEN", "local-pat")
    fake = _execute_with_fake(monkeypatch)
    execute = runner_cmd._make_execute(_creds())
    execute(_work_item(github_token=""))
    assert fake.calls[0]["env"]["GIT_TOKEN"] == "local-pat"


def test_no_claim_token_and_no_local_token_leaves_git_token_unset(monkeypatch):
    monkeypatch.delenv("GIT_TOKEN", raising=False)
    fake = _execute_with_fake(monkeypatch)
    execute = runner_cmd._make_execute(_creds())
    execute(_work_item(github_token=""))
    assert "GIT_TOKEN" not in fake.calls[0]["env"]
