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


def _work_item(
    tier: int, *, model_override=None, estimated_budget_usd=None
) -> WorkItem:
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
        model_override=model_override,
        estimated_budget_usd=estimated_budget_usd,
    )


class _FakeRunner:
    """Stands in for native_runner.run_issue_on_host; records call kwargs.

    It declares ``model``/``budget_usd``/``budget_source`` (and run_id/
    pr_title) so the callback's signature introspection (accepts_model,
    accepts_budget, etc.) sees them, matching the real runner.
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
        budget_usd=None,
        budget_source=None,
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
                "budget_usd": budget_usd,
                "budget_source": budget_source,
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


# ---------------------------------------------------------------------------
# #1275: model_override vs. tier escalation — CONTROLLER-DECIDED precedence.
# Precedence matrix: tier {0, 1, 2} x override {set, unset} -> exact model.
# ---------------------------------------------------------------------------


def test_tier_zero_no_override_passes_no_model(monkeypatch):
    """Regression pin: no override, tier 0 -> byte-identical to pre-#1275
    (no model kwarg at all — the local run uses the config default)."""
    fake = _execute_with_fake(monkeypatch)
    execute = runner_cmd._make_execute(_creds())
    execute(_work_item(tier=0))
    assert fake.calls[0]["model"] is None


def test_tier_zero_with_override_passes_the_override(monkeypatch):
    """First attempt, nothing has failed yet: the brief-confirmed override
    wins over the config default, exactly like an explicit --model flag."""
    fake = _execute_with_fake(monkeypatch)
    execute = runner_cmd._make_execute(_creds())
    execute(_work_item(tier=0, model_override="anthropic/claude-opus-4-8"))
    assert fake.calls[0]["model"] == "anthropic/claude-opus-4-8"


def test_tier_one_with_override_escalation_still_wins(monkeypatch):
    """A re-queued retry (tier >= 1, #890) ALWAYS escalates past a set
    model_override — the override already ran once (at tier 0) and failed,
    so it must not keep re-running at the user's original pick."""
    fake = _execute_with_fake(monkeypatch)
    execute = runner_cmd._make_execute(_creds())
    execute(_work_item(tier=1, model_override="anthropic/claude-opus-4-8"))
    assert fake.calls[0]["model"] == DEFAULT_ESCALATION_MODEL


def test_tier_two_with_override_escalation_still_wins(monkeypatch):
    fake = _execute_with_fake(monkeypatch)
    execute = runner_cmd._make_execute(_creds())
    execute(_work_item(tier=2, model_override="anthropic/claude-opus-4-8"))
    assert fake.calls[0]["model"] == DEFAULT_ESCALATION_MODEL


# ---------------------------------------------------------------------------
# #1275: budget passthrough — the alignment brief's confirmed estimate, when
# present, becomes --budget-usd + --budget-source "brief".
# ---------------------------------------------------------------------------


def test_no_estimate_passes_no_budget_kwargs(monkeypatch):
    """Regression pin: no estimate -> byte-identical argv (neither
    budget_usd nor budget_source reaches the runner at all)."""
    fake = _execute_with_fake(monkeypatch)
    execute = runner_cmd._make_execute(_creds())
    execute(_work_item(tier=0))
    assert fake.calls[0]["budget_usd"] is None
    assert fake.calls[0]["budget_source"] is None


def test_estimate_present_passes_budget_usd_and_brief_source(monkeypatch):
    fake = _execute_with_fake(monkeypatch)
    execute = runner_cmd._make_execute(_creds())
    execute(_work_item(tier=0, estimated_budget_usd=12.5))
    assert fake.calls[0]["budget_usd"] == 12.5
    assert fake.calls[0]["budget_source"] == "brief"


def test_estimate_zero_still_forwards_as_a_deliberate_value(monkeypatch):
    """0 is a real, if unusual, deliberately-uncapped estimate (the same
    convention as --budget-usd 0 elsewhere) — `is not None`, not truthiness,
    must gate this, so it is NOT dropped the way a falsy check would drop it."""
    fake = _execute_with_fake(monkeypatch)
    execute = runner_cmd._make_execute(_creds())
    execute(_work_item(tier=0, estimated_budget_usd=0.0))
    assert fake.calls[0]["budget_usd"] == 0.0
    assert fake.calls[0]["budget_source"] == "brief"


def test_estimate_present_at_escalated_tier_still_forwards_budget(monkeypatch):
    """Budget passthrough is independent of the model precedence decision —
    an escalated attempt still enforces the SAME confirmed brief ceiling."""
    fake = _execute_with_fake(monkeypatch)
    execute = runner_cmd._make_execute(_creds())
    execute(_work_item(tier=1, estimated_budget_usd=12.5))
    assert fake.calls[0]["budget_usd"] == 12.5
    assert fake.calls[0]["budget_source"] == "brief"
    assert fake.calls[0]["model"] == DEFAULT_ESCALATION_MODEL


def test_runner_without_budget_param_does_not_get_budget(monkeypatch):
    """If a runner's signature has no ``budget_usd`` param, we must not pass
    it (mirrors test_runner_without_model_param_does_not_get_model)."""

    calls: list[Dict[str, Any]] = []

    def no_budget_runner(*, repo_url, ref, issue_ref, workspace_id, env, run_id="", model=None):
        calls.append({"issue_ref": issue_ref, "model": model})
        return RunResult(status="green", cost_usd=0.0)

    monkeypatch.setattr(runner_cmd, "select_sandbox_runner", lambda env: no_budget_runner)
    execute = runner_cmd._make_execute(_creds())
    result = execute(_work_item(tier=0, estimated_budget_usd=12.5))
    assert result.status == "green"
    assert len(calls) == 1
