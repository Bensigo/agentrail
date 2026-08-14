from __future__ import annotations

from agentrail.cli.commands.dependency_observation_worker import run_dependency_observation_worker


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
