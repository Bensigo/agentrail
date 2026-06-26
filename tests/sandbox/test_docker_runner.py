"""Hermetic unit tests for the Docker-per-run sandbox executor.

These tests NEVER touch a real Docker daemon. The container runner is faked via
the injectable ``run_container`` seam so we can assert on the exact command and
env the executor builds, on how it parses a RunResult out of the container's
output, and — crucially — that the container is ALWAYS removed, even when the
run errors or times out (AC1, AC2).

A separate, clearly-marked smoke test that exercises the REAL image lives in
``test_docker_image_smoke.py`` and is skipped when Docker is unavailable (AC3).
"""
from __future__ import annotations

import json
from typing import List

import pytest

from agentrail.sandbox.docker_runner import (
    ContainerResult,
    DockerError,
    DockerTimeout,
    RunResult,
    RESULT_BEGIN,
    RESULT_END,
    run_issue_in_sandbox,
)


# ---------------------------------------------------------------------------
# Fakes / helpers
# ---------------------------------------------------------------------------

def _wrap_result(payload: dict, *, log_body: str = "log line one\nlog line two") -> str:
    """Build a fake container stdout: free-form logs + a sentinel-fenced JSON."""
    return (
        f"{log_body}\n"
        f"{RESULT_BEGIN}\n"
        f"{json.dumps(payload)}\n"
        f"{RESULT_END}\n"
    )


class FakeRunner:
    """Records the commands it was asked to run and replays scripted results.

    ``run`` results are popped in order; if the queue is empty it raises so a
    test that mis-counts docker calls fails loudly. Calls are recorded so we can
    assert the run command, env, and — for teardown — that ``docker rm`` ran.
    """

    def __init__(self, results: List[object]) -> None:
        self._results = list(results)
        self.calls: List[dict] = []

    def __call__(self, cmd, *, env=None, timeout=None, **kwargs):
        self.calls.append({"cmd": list(cmd), "env": dict(env or {}), "timeout": timeout})
        if not self._results:
            raise AssertionError(f"unexpected extra container call: {cmd}")
        nxt = self._results.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt

    @property
    def commands(self) -> List[List[str]]:
        return [c["cmd"] for c in self.calls]

    def commands_containing(self, token: str) -> List[List[str]]:
        return [c for c in self.commands if token in c]


def _green_payload(**over) -> dict:
    base = {
        "status": "green",
        "cost_usd": 0.42,
        "branch": "agentrail/issue-7",
        "gate_reason": "",
    }
    base.update(over)
    return base


# ---------------------------------------------------------------------------
# AC1 — launches a container, runs the agentrail run inside, returns a parsed
#       RunResult, and ALWAYS removes the container.
# ---------------------------------------------------------------------------

class TestHappyPath:
    def _run(self, runner):
        return run_issue_in_sandbox(
            repo_url="https://github.com/acme/widgets.git",
            ref="main",
            issue_ref="7",
            workspace_id="ws-123",
            env={"AGENT_API_KEY": "sk-secret", "GIT_TOKEN": "ght-secret"},
            run_container=runner,
            image="agentrail/runner:test",
        )

    def test_returns_parsed_run_result(self) -> None:
        runner = FakeRunner([
            ContainerResult(exit_code=0, stdout=_wrap_result(_green_payload()), stderr=""),
            ContainerResult(exit_code=0, stdout="", stderr=""),  # rm
        ])
        result = self._run(runner)
        assert isinstance(result, RunResult)
        assert result.status == "green"
        assert result.cost_usd == pytest.approx(0.42)
        assert result.branch == "agentrail/issue-7"
        assert result.gate_reason == ""
        assert "log line two" in result.logs_tail

    def test_launches_a_container_with_the_image(self) -> None:
        runner = FakeRunner([
            ContainerResult(exit_code=0, stdout=_wrap_result(_green_payload()), stderr=""),
            ContainerResult(exit_code=0, stdout="", stderr=""),
        ])
        self._run(runner)
        run_cmds = [c for c in runner.commands if "run" in c and "agentrail/runner:test" in c]
        assert run_cmds, f"no docker run for the image in {runner.commands}"
        run_cmd = run_cmds[0]
        assert run_cmd[0] == "docker"
        # Named container so teardown is deterministic even if we lose stdout.
        assert "--name" in run_cmd

    def test_passes_repo_ref_and_issue_into_the_container(self) -> None:
        runner = FakeRunner([
            ContainerResult(exit_code=0, stdout=_wrap_result(_green_payload()), stderr=""),
            ContainerResult(exit_code=0, stdout="", stderr=""),
        ])
        self._run(runner)
        run_cmd = next(c for c in runner.commands if "run" in c and "agentrail/runner:test" in c)
        joined = " ".join(run_cmd)
        assert "https://github.com/acme/widgets.git" in joined
        assert "main" in joined  # ref
        assert "7" in joined     # issue ref

    def test_secrets_passed_as_env_not_argv(self) -> None:
        runner = FakeRunner([
            ContainerResult(exit_code=0, stdout=_wrap_result(_green_payload()), stderr=""),
            ContainerResult(exit_code=0, stdout="", stderr=""),
        ])
        self._run(runner)
        run_cmd = next(c for c in runner.commands if "run" in c and "agentrail/runner:test" in c)
        joined = " ".join(run_cmd)
        # Secret VALUES must never appear on the command line (process list leak).
        assert "sk-secret" not in joined
        assert "ght-secret" not in joined
        # They are forwarded by NAME via `-e KEY` (Docker reads the value from
        # the runner's own environment) ...
        assert "AGENT_API_KEY" in run_cmd
        assert "GIT_TOKEN" in run_cmd
        # ... and the value is supplied to the subprocess env.
        env = next(c["env"] for c in runner.calls if "agentrail/runner:test" in c["cmd"])
        assert env["AGENT_API_KEY"] == "sk-secret"
        assert env["GIT_TOKEN"] == "ght-secret"

    def test_container_is_always_removed(self) -> None:
        runner = FakeRunner([
            ContainerResult(exit_code=0, stdout=_wrap_result(_green_payload()), stderr=""),
            ContainerResult(exit_code=0, stdout="", stderr=""),
        ])
        self._run(runner)
        rm_cmds = [c for c in runner.commands if c[:2] == ["docker", "rm"]]
        assert rm_cmds, f"docker rm was never invoked: {runner.commands}"
        # The same container name is started and removed.
        run_cmd = next(c for c in runner.commands if "run" in c and "agentrail/runner:test" in c)
        name = run_cmd[run_cmd.index("--name") + 1]
        assert name in rm_cmds[0]

    def test_red_status_is_parsed_with_gate_reason(self) -> None:
        payload = _green_payload(status="red", gate_reason="AC2 unverified")
        runner = FakeRunner([
            ContainerResult(exit_code=1, stdout=_wrap_result(payload), stderr=""),
            ContainerResult(exit_code=0, stdout="", stderr=""),
        ])
        result = self._run(runner)
        assert result.status == "red"
        assert result.gate_reason == "AC2 unverified"


# ---------------------------------------------------------------------------
# AC2 — resource limits + timeout are applied; a timeout/error returns
#       status='error' and still tears down.
# ---------------------------------------------------------------------------

class TestResourceLimits:
    def _run(self, runner, **over):
        kwargs = dict(
            repo_url="r", ref="main", issue_ref="7", workspace_id="w",
            env={}, run_container=runner, image="img",
            cpus="1.5", memory="3g", timeout=900,
        )
        kwargs.update(over)
        return run_issue_in_sandbox(**kwargs)

    def test_cpu_and_memory_limits_on_run_command(self) -> None:
        runner = FakeRunner([
            ContainerResult(exit_code=0, stdout=_wrap_result(_green_payload()), stderr=""),
            ContainerResult(exit_code=0, stdout="", stderr=""),
        ])
        self._run(runner)
        run_cmd = next(c for c in runner.commands if "run" in c and "img" in c)
        joined = " ".join(run_cmd)
        assert "--cpus" in run_cmd and "1.5" in joined
        assert "--memory" in run_cmd and "3g" in joined

    def test_timeout_is_passed_to_the_runner(self) -> None:
        runner = FakeRunner([
            ContainerResult(exit_code=0, stdout=_wrap_result(_green_payload()), stderr=""),
            ContainerResult(exit_code=0, stdout="", stderr=""),
        ])
        self._run(runner, timeout=42)
        run_call = next(c for c in runner.calls if "img" in c["cmd"] and "run" in c["cmd"])
        assert run_call["timeout"] == 42


class TestErrorAndTimeoutTeardown:
    def _run(self, runner):
        return run_issue_in_sandbox(
            repo_url="r", ref="main", issue_ref="7", workspace_id="w",
            env={}, run_container=runner, image="img", timeout=10,
        )

    def test_timeout_returns_error_status(self) -> None:
        runner = FakeRunner([
            DockerTimeout("container exceeded 10s"),
            ContainerResult(exit_code=1, stdout="", stderr="no such path"),  # cost cp
            ContainerResult(exit_code=0, stdout="", stderr=""),  # rm
        ])
        result = self._run(runner)
        assert result.status == "error"
        assert "timeout" in result.gate_reason.lower() or "10s" in result.gate_reason

    def test_timeout_still_tears_down(self) -> None:
        runner = FakeRunner([
            DockerTimeout("boom"),
            ContainerResult(exit_code=1, stdout="", stderr=""),  # cost cp
            ContainerResult(exit_code=0, stdout="", stderr=""),
        ])
        self._run(runner)
        assert any(c[:2] == ["docker", "rm"] for c in runner.commands)

    def test_docker_error_returns_error_status_and_tears_down(self) -> None:
        runner = FakeRunner([
            DockerError("daemon not reachable"),
            ContainerResult(exit_code=1, stdout="", stderr=""),  # cost cp
            ContainerResult(exit_code=0, stdout="", stderr=""),
        ])
        result = self._run(runner)
        assert result.status == "error"
        assert any(c[:2] == ["docker", "rm"] for c in runner.commands)

    def test_unparseable_output_is_error_not_crash(self) -> None:
        runner = FakeRunner([
            ContainerResult(exit_code=0, stdout="garbage with no sentinel", stderr="oops"),
            ContainerResult(exit_code=1, stdout="", stderr=""),  # cost cp
            ContainerResult(exit_code=0, stdout="", stderr=""),
        ])
        result = self._run(runner)
        assert result.status == "error"
        # Logs tail should still surface SOMETHING for debugging.
        assert result.logs_tail

    def test_teardown_failure_does_not_mask_result(self) -> None:
        # rm itself failing must not turn a green run into a crash.
        runner = FakeRunner([
            ContainerResult(exit_code=0, stdout=_wrap_result(_green_payload()), stderr=""),
            DockerError("rm failed: no such container"),
        ])
        result = self._run(runner)
        assert result.status == "green"


# ---------------------------------------------------------------------------
# Cost fault-tolerance — a sandbox-level FAILURE (timeout / daemon error /
# unparseable output) must NOT report $0 when the run already spent money. The
# partial per-phase cost ledger is `docker cp`-ed out of the (still-present,
# --rm=false) container BEFORE teardown and summed. Any problem extracting it
# falls back to 0.0 and never masks the original failure.
# ---------------------------------------------------------------------------

class _CostRecoveringRunner(FakeRunner):
    """Like FakeRunner, but a ``docker cp`` of the cost ledger materialises a
    partial ledger at the requested host destination (mimicking a real cp out of
    a container that had written partial cost before crashing)."""

    def __init__(self, results, *, ledger_lines):
        super().__init__(results)
        self._ledger_lines = ledger_lines

    def __call__(self, cmd, *, env=None, timeout=None, **kwargs):
        cmd = list(cmd)
        if cmd[:2] == ["docker", "cp"]:
            # argv == ["docker", "cp", "<name>:<src>", "<dest>"]
            dest = cmd[3]
            with open(dest, "w") as fh:
                fh.write("\n".join(self._ledger_lines))
        return super().__call__(cmd, env=env, timeout=timeout, **kwargs)


class TestCostRecoveryOnFailure:
    def _run(self, runner):
        return run_issue_in_sandbox(
            repo_url="r", ref="main", issue_ref="7", workspace_id="w",
            env={}, run_container=runner, image="img", timeout=10,
        )

    def test_successful_run_still_reports_summed_cost(self) -> None:
        # (a) The happy path is unaffected — cost comes from the parsed payload.
        runner = FakeRunner([
            ContainerResult(exit_code=0, stdout=_wrap_result(_green_payload(cost_usd=1.23)), stderr=""),
            ContainerResult(exit_code=0, stdout="", stderr=""),  # rm
        ])
        result = self._run(runner)
        assert result.status == "green"
        assert result.cost_usd == pytest.approx(1.23)

    def test_timeout_recovers_partial_cost_from_ledger(self) -> None:
        # (b) A timeout would report $0, but the partial ledger holds real spend.
        runner = _CostRecoveringRunner(
            [
                DockerTimeout("container exceeded 10s"),
                ContainerResult(exit_code=0, stdout="", stderr=""),  # cost cp succeeds
                ContainerResult(exit_code=0, stdout="", stderr=""),  # rm
            ],
            ledger_lines=[
                json.dumps({"phase": "plan", "cost_usd": 0.10}),
                json.dumps({"phase": "execute", "cost_usd": 0.25}),
            ],
        )
        result = self._run(runner)
        assert result.status == "error"
        assert result.cost_usd == pytest.approx(0.35)
        # The ledger was pulled out BEFORE teardown removed the container.
        cmds = runner.commands
        cp_idx = next(i for i, c in enumerate(cmds) if c[:2] == ["docker", "cp"])
        rm_idx = next(i for i, c in enumerate(cmds) if c[:2] == ["docker", "rm"])
        assert cp_idx < rm_idx

    def test_unparseable_output_recovers_partial_cost(self) -> None:
        runner = _CostRecoveringRunner(
            [
                ContainerResult(exit_code=0, stdout="garbage, no sentinel", stderr=""),
                ContainerResult(exit_code=0, stdout="", stderr=""),  # cost cp
                ContainerResult(exit_code=0, stdout="", stderr=""),  # rm
            ],
            ledger_lines=[json.dumps({"cost_usd": 0.5})],
        )
        result = self._run(runner)
        assert result.status == "error"
        assert result.cost_usd == pytest.approx(0.5)

    def test_garbled_ledger_on_failure_falls_back_to_zero(self) -> None:
        # (c) A truncated/garbled ledger must not raise — bad lines are skipped,
        # and the one good line still contributes.
        runner = _CostRecoveringRunner(
            [
                DockerError("daemon error"),
                ContainerResult(exit_code=0, stdout="", stderr=""),  # cost cp
                ContainerResult(exit_code=0, stdout="", stderr=""),  # rm
            ],
            ledger_lines=[
                "not json at all",
                json.dumps({"cost_usd": 0.07}),
                '{"cost_usd": 0.9',  # truncated final line
            ],
        )
        result = self._run(runner)
        assert result.status == "error"
        assert result.cost_usd == pytest.approx(0.07)

    def test_missing_ledger_on_failure_reports_zero_without_raising(self) -> None:
        # cp fails (ledger never written) → cost stays 0.0, no crash.
        runner = FakeRunner([
            DockerTimeout("boom"),
            ContainerResult(exit_code=1, stdout="", stderr="No such file"),  # cp fails
            ContainerResult(exit_code=0, stdout="", stderr=""),  # rm
        ])
        result = self._run(runner)
        assert result.status == "error"
        assert result.cost_usd == 0.0


# ---------------------------------------------------------------------------
# AC4 (escalation loop) — model + compacted failure handoff are forwarded into
#       the container by NAME (env), never on the argv (handoff can be large /
#       multiline; the model name is harmless but kept uniform with secrets).
# ---------------------------------------------------------------------------

class TestModelAndHandoffForwarding:
    def _run(self, runner, **over):
        kwargs = dict(
            repo_url="https://github.com/acme/widgets.git",
            ref="main", issue_ref="7", workspace_id="ws-1",
            env={"AGENT_API_KEY": "sk-secret"},
            run_container=runner, image="img",
        )
        kwargs.update(over)
        return run_issue_in_sandbox(**kwargs)

    def _ok_runner(self) -> "FakeRunner":
        return FakeRunner([
            ContainerResult(exit_code=0, stdout=_wrap_result(_green_payload()), stderr=""),
            ContainerResult(exit_code=0, stdout="", stderr=""),  # rm
        ])

    def test_model_forwarded_by_name_via_env(self) -> None:
        runner = self._ok_runner()
        self._run(runner, model="claude-opus-4-8")
        run_cmd = next(c for c in runner.commands if "run" in c and "img" in c)
        # forwarded by NAME (-e AGENTRAIL_MODEL), value lives in the subprocess env
        assert "AGENTRAIL_MODEL" in run_cmd
        run_env = next(c["env"] for c in runner.calls if "img" in c["cmd"])
        assert run_env["AGENTRAIL_MODEL"] == "claude-opus-4-8"

    def test_handoff_forwarded_by_name_via_env_not_argv(self) -> None:
        handoff = "## Escalation\n### Goal\nadd widget\n### Exact gate error\nAC2 unverified"
        runner = self._ok_runner()
        self._run(runner, failure_handoff=handoff)
        run_cmd = next(c for c in runner.commands if "run" in c and "img" in c)
        joined = " ".join(run_cmd)
        # the (possibly large/multiline) handoff value must NOT land on the argv
        assert "AC2 unverified" not in joined
        assert "AGENTRAIL_FAILURE_HANDOFF" in run_cmd
        run_env = next(c["env"] for c in runner.calls if "img" in c["cmd"])
        assert run_env["AGENTRAIL_FAILURE_HANDOFF"] == handoff

    def test_omitted_model_and_handoff_are_not_forwarded(self) -> None:
        runner = self._ok_runner()
        self._run(runner)  # no model, no handoff
        run_cmd = next(c for c in runner.commands if "run" in c and "img" in c)
        assert "AGENTRAIL_MODEL" not in run_cmd
        assert "AGENTRAIL_FAILURE_HANDOFF" not in run_cmd
        run_env = next(c["env"] for c in runner.calls if "img" in c["cmd"])
        assert "AGENTRAIL_MODEL" not in run_env
        assert "AGENTRAIL_FAILURE_HANDOFF" not in run_env

    def test_model_and_handoff_do_not_clobber_caller_env(self) -> None:
        runner = self._ok_runner()
        self._run(runner, model="m", failure_handoff="h")
        run_env = next(c["env"] for c in runner.calls if "img" in c["cmd"])
        # original secret still present alongside the injected pair
        assert run_env["AGENT_API_KEY"] == "sk-secret"
