"""Tests for the runner execute callback's tier→model wiring (BUG 1).

``_make_execute`` builds the callback the worker invokes per claimed issue. It
must pass a ``model`` override for an escalated (tier >= 1) attempt and pass NO
``model`` for tier 0 (so the local run uses the config default). We inject a
fake runner that records the kwargs it was called with.
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Dict

import agentrail.cli.commands.runner as runner_cmd
from agentrail.runner.client import WorkItem
from agentrail.runner.escalation import DEFAULT_ESCALATION_MODEL
from agentrail.sandbox.docker_runner import RunResult


def _creds() -> SimpleNamespace:
    return SimpleNamespace(
        base_url="https://app.agentrail.dev",
        token="rt_secret",
        workspace_id="ws1",
    )


def _work_item(tier: int) -> WorkItem:
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
        tier=tier,
    )


class _FakeRunner:
    """Stands in for native_runner.run_issue_on_host; records call kwargs.

    It declares ``model`` (and run_id/pr_title) so the callback's signature
    introspection (accepts_model etc.) sees them, matching the real runner.
    """

    def __init__(self) -> None:
        self.calls: list[Dict[str, Any]] = []

    def __call__(
        self,
        *,
        repo_url: str,
        ref: str,
        issue_ref: str,
        workspace_id: str,
        env: Dict[str, str],
        run_id: str = "",
        pr_title: str = "",
        model=None,
    ) -> RunResult:
        self.calls.append(
            {
                "repo_url": repo_url,
                "ref": ref,
                "issue_ref": issue_ref,
                "workspace_id": workspace_id,
                "env": env,
                "run_id": run_id,
                "pr_title": pr_title,
                "model": model,
            }
        )
        return RunResult(status="green", cost_usd=0.0)


def _execute_with_fake(monkeypatch) -> _FakeRunner:
    fake = _FakeRunner()
    monkeypatch.setattr(runner_cmd, "select_sandbox_runner", lambda env: fake)
    return fake


def test_tier_zero_passes_no_model_override(monkeypatch):
    fake = _execute_with_fake(monkeypatch)
    execute = runner_cmd._make_execute(_creds())
    execute(_work_item(tier=0))
    assert fake.calls[0]["model"] is None


def test_tier_one_passes_strong_model(monkeypatch):
    fake = _execute_with_fake(monkeypatch)
    execute = runner_cmd._make_execute(_creds())
    execute(_work_item(tier=1))
    assert fake.calls[0]["model"] == DEFAULT_ESCALATION_MODEL


def test_tier_two_also_escalates(monkeypatch):
    fake = _execute_with_fake(monkeypatch)
    execute = runner_cmd._make_execute(_creds())
    execute(_work_item(tier=2))
    assert fake.calls[0]["model"] == DEFAULT_ESCALATION_MODEL


def test_env_override_threads_through_to_runner(monkeypatch):
    monkeypatch.setenv("AGENTRAIL_ESCALATION_MODEL", "claude-opus-4-8-x")
    fake = _execute_with_fake(monkeypatch)
    execute = runner_cmd._make_execute(_creds())
    execute(_work_item(tier=1))
    assert fake.calls[0]["model"] == "claude-opus-4-8-x"


def test_runner_without_model_param_does_not_get_model(monkeypatch):
    """If a runner's signature has no ``model`` param, we must not pass it."""

    calls: list[Dict[str, Any]] = []

    def no_model_runner(*, repo_url, ref, issue_ref, workspace_id, env, run_id=""):
        calls.append({"issue_ref": issue_ref})
        return RunResult(status="green", cost_usd=0.0)

    monkeypatch.setattr(runner_cmd, "select_sandbox_runner", lambda env: no_model_runner)
    execute = runner_cmd._make_execute(_creds())
    # Even at tier 1, a runner that can't take `model` is called without error.
    result = execute(_work_item(tier=1))
    assert result.status == "green"
    assert len(calls) == 1
