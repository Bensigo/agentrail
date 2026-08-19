from __future__ import annotations

import pytest

from agentrail.cli.commands.dependency_observation_worker import (
    _real_worker,
    run_dependency_observation_worker,
)


class FakeWorker:
    def __init__(self) -> None:
        self.calls = 0

    def run_once(self) -> str:
        self.calls += 1
        return "posted"


def test_once_runs_one_observation_cycle_without_builder_or_install_actions(capsys) -> None:
    worker = FakeWorker()
    result = run_dependency_observation_worker(
        ["--once"],
        worker_factory=lambda: worker,
    )
    assert result == 0
    assert worker.calls == 1
    assert capsys.readouterr().out == "dependency-observation: posted\n"


def test_worker_rejects_the_global_console_secret_without_a_workspace_api_key(monkeypatch) -> None:
    monkeypatch.setenv("JACE_CONSOLE_URL", "https://console.example.test")
    monkeypatch.setenv("JACE_CONSOLE_TOKEN", "global-secret-must-not-authorize-a-tenant")
    monkeypatch.setenv("AGENTRAIL_WORKSPACE_ID", "11111111-1111-4111-8111-111111111111")
    monkeypatch.setenv("AGENTRAIL_DEPENDENCY_WORKER_ID", "worker:pnpm-1")
    monkeypatch.delenv("AGENTRAIL_SERVER_API_KEY", raising=False)

    with pytest.raises(ValueError, match="AGENTRAIL_SERVER_API_KEY"):
        _real_worker()
