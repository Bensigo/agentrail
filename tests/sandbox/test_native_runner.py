"""Hermetic unit tests for the host-native sandbox runner.

These tests NEVER clone a real repo, run a real agent, or touch the network.
The shell boundary (git clone + ``agentrail run issue``) is faked via the
injectable ``runner`` seam — mirroring how ``test_docker_runner`` fakes
``run_container``. We assert on the exact commands/env the runner builds, that
it parses a RunResult out of the run's ``run.json``.

Workdir cleanup follows the caller-owned-workdir contract (#997): a self-owned
temp dir (no ``run_dir_factory``) is ALWAYS torn down, even on error or timeout;
but a dir handed in via an injected ``run_dir_factory`` is CALLER-OWNED, so
``run_issue_on_host`` PRESERVES it (the caller's own ``finally`` — e.g.
``agentrail.evals.runner.run`` — cleans it up). Because these tests inject a
``run_dir_factory``, they assert the injected dir is preserved (AC1, AC2).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import List, Optional

import pytest

from agentrail.sandbox.native_runner import (
    HostError,
    HostTimeout,
    _build_run_command,
    run_issue_on_host,
)
from agentrail.sandbox.docker_runner import RunResult


# ---------------------------------------------------------------------------
# Fakes / helpers
# ---------------------------------------------------------------------------

class _Completed:
    """Stand-in for subprocess.CompletedProcess (the runner's value type)."""

    def __init__(self, returncode: int, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class FakeRunner:
    """Records the commands it ran and replays scripted results in order.

    A scripted entry may be a ``_Completed``, an ``Exception`` (raised), or a
    callable ``(cmd, cwd, env) -> _Completed`` so a test can lay down a fake
    ``run.json`` as a side effect of the "agentrail run" step.
    """

    def __init__(self, results: List[object]) -> None:
        self._results = list(results)
        self.calls: List[dict] = []

    def run(self, cmd, *, cwd=None, env=None, timeout=None, **kwargs):
        self.calls.append(
            {"cmd": list(cmd), "cwd": cwd, "env": dict(env or {}),
             "timeout": timeout, "kwargs": dict(kwargs)}
        )
        if not self._results:
            raise AssertionError(f"unexpected extra call: {cmd}")
        nxt = self._results.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        if callable(nxt):
            return nxt(cmd, cwd, env)
        return nxt

    @property
    def commands(self) -> List[List[str]]:
        return [c["cmd"] for c in self.calls]

    def command_with(self, token: str) -> List[str]:
        for c in self.commands:
            if token in c:
                return c
        raise AssertionError(f"no command containing {token!r} in {self.commands}")


class CaptureFaithfulRunner(FakeRunner):
    """Like FakeRunner, but FAITHFUL to real subprocess: a command's stdout is
    only readable when the caller passed ``capture_output=True`` — exactly how
    ``subprocess.run`` behaves. This guards the regression where ``_publish_green``
    read ``gh pr create``'s stdout without capturing it, so the PR URL came back
    empty in production while the (stdout-supplying) fake hid the bug.
    """

    def run(self, cmd, *, cwd=None, env=None, timeout=None, **kwargs):
        result = super().run(cmd, cwd=cwd, env=env, timeout=timeout, **kwargs)
        if kwargs.get("capture_output") is not True and hasattr(result, "stdout"):
            result.stdout = None  # subprocess leaves .stdout=None without capture
        return result


def _write_run_json(run_dir: Path, payload: dict) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "run.json").write_text(json.dumps(payload))


def _green_run_json() -> dict:
    return {"objectiveGate": {"verdict": "green"}}


class _RunDirs:
    """Hands out a fresh, real temp run dir per invocation (run_dir_factory).

    Records the dirs it created so tests can assert cleanup.
    """

    def __init__(self, tmp_path: Path) -> None:
        self._base = tmp_path
        self._n = 0
        self.created: List[Path] = []

    def __call__(self) -> Path:
        self._n += 1
        d = self._base / f"run-{self._n}"
        d.mkdir(parents=True, exist_ok=True)
        self.created.append(d)
        return d


# ---------------------------------------------------------------------------
# AC1 — clones at ref, runs ``agentrail run issue``, parses run.json → RunResult,
#       and cleans up the temp dir.
# ---------------------------------------------------------------------------

class TestHappyPath:
    def _run(self, tmp_path, runner, **over):
        dirs = _RunDirs(tmp_path)
        kwargs = dict(
            repo_url="https://github.com/acme/widgets.git",
            ref="main",
            issue_ref="7",
            workspace_id="ws-123",
            env={"GIT_TOKEN": "ght-secret"},
            run_dir_factory=dirs,
            runner=runner,
        )
        kwargs.update(over)
        result = run_issue_on_host(**kwargs)
        return result, dirs

    def _ok_runner(self, run_dir: Path, payload: Optional[dict] = None) -> FakeRunner:
        payload = payload or _green_run_json()

        def _do_run(cmd, cwd, env):
            # The "agentrail run issue" step writes run.json under the run dir.
            log_dir = _extract_log_dir(cmd, run_dir)
            run_id = _extract_run_id(cmd) or "host-run"
            _write_run_json(Path(log_dir) / run_id, payload)
            return _Completed(0, stdout="ran", stderr="")

        return FakeRunner([
            _Completed(0, stdout="cloned"),   # git clone
            _do_run,                          # agentrail run issue
        ])

    def test_returns_parsed_green_run_result(self, tmp_path) -> None:
        # The run dir factory's first dir is where artifacts land.
        first_dir = tmp_path / "run-1"
        runner = self._ok_runner(first_dir)
        result, dirs = self._run(tmp_path, runner)
        assert isinstance(result, RunResult)
        assert result.status == "green"
        assert result.gate_reason == ""

    def test_clones_repo_at_ref(self, tmp_path) -> None:
        runner = self._ok_runner(tmp_path / "run-1")
        self._run(tmp_path, runner)
        clone = runner.command_with("clone")
        joined = " ".join(clone)
        assert "git" == clone[0]
        assert "https://github.com/acme/widgets.git" in joined or any(
            "widgets.git" in part for part in clone
        )
        # ref is checked out (either as a clone --branch or a later checkout)
        all_joined = " ".join(" ".join(c) for c in runner.commands)
        assert "main" in all_joined

    def test_runs_agentrail_run_issue_with_agent(self, tmp_path) -> None:
        runner = self._ok_runner(tmp_path / "run-1")
        self._run(tmp_path, runner)
        run_cmd = runner.command_with("issue")
        assert "agentrail" in run_cmd
        assert "run" in run_cmd
        assert "issue" in run_cmd
        assert "7" in run_cmd
        # default agent is claude (host login + claude's native sandbox)
        assert "--agent" in run_cmd
        assert run_cmd[run_cmd.index("--agent") + 1] == "claude"

    def test_agent_from_env_overrides_default(self, tmp_path) -> None:
        runner = self._ok_runner(tmp_path / "run-1")
        self._run(tmp_path, runner, env={"AGENTRAIL_AGENT": "codex"})
        run_cmd = runner.command_with("issue")
        assert run_cmd[run_cmd.index("--agent") + 1] == "codex"

    def test_model_passed_when_given(self, tmp_path) -> None:
        runner = self._ok_runner(tmp_path / "run-1")
        self._run(tmp_path, runner, model="claude-opus-4-8")
        run_cmd = runner.command_with("issue")
        assert "--model" in run_cmd
        assert run_cmd[run_cmd.index("--model") + 1] == "claude-opus-4-8"

    def test_no_model_flag_when_absent(self, tmp_path) -> None:
        runner = self._ok_runner(tmp_path / "run-1")
        self._run(tmp_path, runner, model=None)
        run_cmd = runner.command_with("issue")
        assert "--model" not in run_cmd

    def test_failure_handoff_forwarded_via_env_not_argv(self, tmp_path) -> None:
        handoff = "## Escalation\n### Exact gate error\nAC2 unverified"
        runner = self._ok_runner(tmp_path / "run-1")
        self._run(tmp_path, runner, failure_handoff=handoff)
        run_call = next(c for c in runner.calls if "issue" in c["cmd"])
        joined = " ".join(run_call["cmd"])
        # the (possibly large/multiline) handoff value must NOT land on argv
        assert "AC2 unverified" not in joined
        assert run_call["env"].get("AGENTRAIL_FAILURE_HANDOFF") == handoff

    def test_link_env_forwarded_to_run(self, tmp_path) -> None:
        runner = self._ok_runner(tmp_path / "run-1")
        self._run(
            tmp_path,
            runner,
            env={
                "AGENTRAIL_SERVER_URL": "https://srv",
                "AGENTRAIL_SERVER_TOKEN": "tok",
            },
        )
        run_call = next(c for c in runner.calls if "issue" in c["cmd"])
        assert run_call["env"].get("AGENTRAIL_SERVER_URL") == "https://srv"
        assert run_call["env"].get("AGENTRAIL_SERVER_TOKEN") == "tok"

    def test_red_verdict_parsed_with_reason(self, tmp_path) -> None:
        payload = {
            "objectiveGate": {
                "verdict": "red",
                "failedReasons": ["AC2 unverified", "tests failed"],
            }
        }
        runner = self._ok_runner(tmp_path / "run-1", payload=payload)
        result, _ = self._run(tmp_path, runner)
        assert result.status == "red"
        assert "AC2 unverified" in result.gate_reason

    def test_caller_owned_dir_preserved_on_success(self, tmp_path) -> None:
        # Caller-owned-workdir contract (#997): when a ``run_dir_factory`` is
        # injected the CALLER owns the workdir, so ``run_issue_on_host`` must NOT
        # delete it (it sets ``_own_work_dir=False`` and skips the rmtree). The
        # real end-to-end teardown of an injected dir happens in the caller's own
        # ``finally`` (``agentrail.evals.runner.run``), not here.
        runner = self._ok_runner(tmp_path / "run-1")
        _, dirs = self._run(tmp_path, runner)
        assert dirs.created, "expected a run dir to be created"
        for d in dirs.created:
            assert d.exists(), f"caller-owned dir must be preserved by run_issue_on_host: {d}"

    def test_green_run_commits_pushes_and_opens_pr(self, tmp_path) -> None:
        # A green gate must PUBLISH before the clone is torn down: commit the
        # agent's uncommitted work to a feature branch, push it, open a PR.
        run_dir = tmp_path / "run-1"

        def _do_run(cmd, cwd, env):
            log_dir = _extract_log_dir(cmd, run_dir)
            run_id = _extract_run_id(cmd) or "host-run"
            _write_run_json(Path(log_dir) / run_id, _green_run_json())
            return _Completed(0, stdout="ran")

        runner = FakeRunner([
            _Completed(0, stdout="cloned"),                 # git clone
            _do_run,                                        # agentrail run issue
            _Completed(0, stdout="main"),                   # rev-parse (branch)
            _Completed(0),                                  # checkout -B
            _Completed(0),                                  # add -A
            _Completed(0),                                  # commit
            _Completed(0),                                  # push
            _Completed(0, stdout="https://github.com/acme/widgets/pull/42"),  # gh pr create
        ])
        result, _ = self._run(tmp_path, runner, pr_title="Add a thing")
        assert result.status == "green"
        assert result.pr_url == "https://github.com/acme/widgets/pull/42"
        assert result.branch == "agentrail/issue-7"
        # The PR was opened against the right head branch + base.
        pr_cmd = runner.command_with("create")
        assert "gh" == pr_cmd[0] and "pr" in pr_cmd
        assert "agentrail/issue-7" in pr_cmd and "main" in pr_cmd
        # The push targets the feature branch, never main directly.
        push_cmd = runner.command_with("push")
        assert "HEAD:agentrail/issue-7" in push_cmd

    def test_publish_disabled_leaves_no_pr(self, tmp_path) -> None:
        runner = self._ok_runner(tmp_path / "run-1")
        result, _ = self._run(tmp_path, runner, publish_pr=False)
        assert result.status == "green"
        assert result.pr_url == ""

    def test_pr_url_captured_against_faithful_subprocess(self, tmp_path) -> None:
        """Regression guard: the PR URL must survive against a runner that only
        exposes stdout when ``capture_output=True`` was passed (real subprocess
        behavior). Before the fix, ``_publish_green`` ran ``gh pr create`` without
        capturing, so the PR opened but pr_url came back empty in production while
        the stdout-supplying fake hid it."""
        run_dir = tmp_path / "run-1"

        def _do_run(cmd, cwd, env):
            log_dir = _extract_log_dir(cmd, run_dir)
            run_id = _extract_run_id(cmd) or "host-run"
            _write_run_json(Path(log_dir) / run_id, _green_run_json())
            return _Completed(0, stdout="ran")

        runner = CaptureFaithfulRunner([
            _Completed(0, stdout="cloned"),                 # git clone
            _do_run,                                        # agentrail run issue
            _Completed(0, stdout="main"),                   # rev-parse (branch)
            _Completed(0),                                  # checkout -B
            _Completed(0),                                  # add -A
            _Completed(0),                                  # commit
            _Completed(0),                                  # push
            _Completed(0, stdout="https://github.com/acme/widgets/pull/42"),  # gh pr create
        ])
        result, _ = self._run(tmp_path, runner, pr_title="Add a thing")
        assert result.status == "green"
        # The fix makes _publish_green capture stdout, so the URL is read back.
        assert result.pr_url == "https://github.com/acme/widgets/pull/42"
        # And the gh pr create call WAS made with capture_output=True.
        create_call = next(c for c in runner.calls if "create" in c["cmd"])
        assert create_call["kwargs"].get("capture_output") is True


# ---------------------------------------------------------------------------
# AC2 — timeout / non-zero run → status='error', temp dir still cleaned.
# ---------------------------------------------------------------------------

class TestErrorAndTimeout:
    def _run(self, tmp_path, runner, **over):
        dirs = _RunDirs(tmp_path)
        kwargs = dict(
            repo_url="r",
            ref="main",
            issue_ref="7",
            workspace_id="w",
            env={},
            run_dir_factory=dirs,
            runner=runner,
            timeout=10,
        )
        kwargs.update(over)
        result = run_issue_on_host(**kwargs)
        return result, dirs

    def test_timeout_returns_error_status(self, tmp_path) -> None:
        runner = FakeRunner([
            _Completed(0, stdout="cloned"),       # git clone
            HostTimeout("run exceeded 10s"),      # agentrail run issue times out
        ])
        result, _ = self._run(tmp_path, runner)
        assert result.status == "error"
        assert "timeout" in result.gate_reason.lower() or "10s" in result.gate_reason

    def test_timeout_preserves_caller_owned_dir(self, tmp_path) -> None:
        # Caller-owned-workdir contract (#997): even on timeout, an injected
        # (caller-owned) run dir is PRESERVED by ``run_issue_on_host`` — the
        # caller's ``finally`` cleans it up, not the runner.
        runner = FakeRunner([
            _Completed(0, stdout="cloned"),
            HostTimeout("boom"),
        ])
        _, dirs = self._run(tmp_path, runner)
        for d in dirs.created:
            assert d.exists()

    def test_clone_failure_is_error(self, tmp_path) -> None:
        runner = FakeRunner([
            _Completed(128, stdout="", stderr="fatal: repository not found"),
        ])
        result, dirs = self._run(tmp_path, runner)
        assert result.status == "error"
        assert result.gate_reason
        # Caller-owned-workdir contract (#997): the injected dir is preserved.
        for d in dirs.created:
            assert d.exists()

    def test_missing_run_json_is_error(self, tmp_path) -> None:
        # clone ok, run "succeeds" but writes no run.json → no trustworthy verdict
        runner = FakeRunner([
            _Completed(0, stdout="cloned"),
            _Completed(1, stdout="agent crashed", stderr="boom"),
        ])
        result, dirs = self._run(tmp_path, runner)
        assert result.status == "error"
        # Caller-owned-workdir contract (#997): the injected dir is preserved.
        for d in dirs.created:
            assert d.exists()

    def test_host_error_is_error_status_and_preserves_caller_dir(self, tmp_path) -> None:
        runner = FakeRunner([
            _Completed(0, stdout="cloned"),
            HostError("agent binary not found"),
        ])
        result, dirs = self._run(tmp_path, runner)
        assert result.status == "error"
        # Caller-owned-workdir contract (#997): the injected dir is preserved.
        for d in dirs.created:
            assert d.exists()


# ---------------------------------------------------------------------------
# Cost fault-tolerance — the per-phase cost ledger is written INCREMENTALLY by
# the pipeline into ``<clone>/.agentrail/run/cost-events.jsonl`` during the run.
# On a SUCCESS the host sums it (already covered indirectly), but on a run-phase
# FAILURE (timeout / HostError) the old code returned cost_usd=0.0, throwing away
# money already spent. These tests prove the failure paths now recover the
# partial ledger — and that a missing/garbled ledger falls back to 0.0 without
# ever raising (it runs on the failure path; it must never mask the real error).
# ---------------------------------------------------------------------------

def _write_ledger(repo_dir: Path, lines: List[str]) -> None:
    """Write raw ledger lines into the clone's cost-events.jsonl (as the pipeline
    would, incrementally). ``lines`` are written verbatim so a test can include a
    truncated/garbled last line."""
    ledger = repo_dir / ".agentrail" / "run" / "cost-events.jsonl"
    ledger.parent.mkdir(parents=True, exist_ok=True)
    ledger.write_text("\n".join(lines))


def _cost_event(cost: float) -> str:
    return json.dumps({"phase": "execute", "cost_usd": cost})


class TestCostRecoveryOnFailure:
    """The run-phase failure paths recover spent cost from the partial ledger."""

    def _run(self, tmp_path, runner, **over):
        dirs = _RunDirs(tmp_path)
        kwargs = dict(
            repo_url="r",
            ref="main",
            issue_ref="7",
            workspace_id="w",
            env={},
            run_dir_factory=dirs,
            runner=runner,
            timeout=10,
        )
        kwargs.update(over)
        return run_issue_on_host(**kwargs), dirs

    def _ledger_writing_run(self, repo_dir: Path, lines: List[str], fail):
        """A scripted 'agentrail run' step that writes a partial ledger to the
        clone (as the pipeline would mid-run) and THEN fails — proving the host
        reads what was already spent before the failure unwound the run."""

        def _do_run(cmd, cwd, env):
            _write_ledger(repo_dir, lines)
            raise fail

        return _do_run

    def test_successful_run_still_reports_summed_cost(self, tmp_path) -> None:
        # A green run sums the full ledger (regression guard for the happy path).
        run_dir = tmp_path / "run-1"
        repo_dir = run_dir / "repo"

        def _do_run(cmd, cwd, env):
            _write_ledger(repo_dir, [_cost_event(0.10), _cost_event(0.25)])
            log_dir = _extract_log_dir(cmd, run_dir)
            run_id = _extract_run_id(cmd) or "host-run"
            _write_run_json(Path(log_dir) / run_id, _green_run_json())
            return _Completed(0, stdout="ran")

        runner = FakeRunner([_Completed(0, stdout="cloned"), _do_run])
        result, _ = self._run(tmp_path, runner, publish_pr=False)
        assert result.status == "green"
        assert result.cost_usd == pytest.approx(0.35)

    def test_timeout_recovers_partial_cost_from_ledger(self, tmp_path) -> None:
        repo_dir = tmp_path / "run-1" / "repo"
        runner = FakeRunner([
            _Completed(0, stdout="cloned"),  # git clone
            self._ledger_writing_run(
                repo_dir,
                [_cost_event(0.10), _cost_event(0.25)],
                HostTimeout("run exceeded 10s"),
            ),
        ])
        result, _ = self._run(tmp_path, runner)
        assert result.status == "error"
        # The run timed out AFTER spending $0.35 — that must be reported, not $0.
        assert result.cost_usd == pytest.approx(0.35)

    def test_host_error_recovers_partial_cost_from_ledger(self, tmp_path) -> None:
        repo_dir = tmp_path / "run-1" / "repo"
        runner = FakeRunner([
            _Completed(0, stdout="cloned"),
            self._ledger_writing_run(
                repo_dir,
                [_cost_event(0.5)],
                HostError("agent crashed mid-run"),
            ),
        ])
        result, _ = self._run(tmp_path, runner)
        assert result.status == "error"
        assert result.cost_usd == pytest.approx(0.5)

    def test_garbled_ledger_on_failure_skips_bad_lines(self, tmp_path) -> None:
        # A truncated/garbled last line (the pipeline was killed mid-write) must
        # be skipped, not raise — the good lines' cost is still recovered.
        repo_dir = tmp_path / "run-1" / "repo"
        runner = FakeRunner([
            _Completed(0, stdout="cloned"),
            self._ledger_writing_run(
                repo_dir,
                [_cost_event(0.07), '{"phase": "execute", "cost_usd": 0.2'],  # truncated
                HostTimeout("killed mid-write"),
            ),
        ])
        result, _ = self._run(tmp_path, runner)
        assert result.status == "error"
        assert result.cost_usd == pytest.approx(0.07)

    def test_missing_ledger_on_failure_reports_zero_without_raising(self, tmp_path) -> None:
        # The run failed before writing any ledger → fall back to 0.0, no raise.
        runner = FakeRunner([
            _Completed(0, stdout="cloned"),
            HostTimeout("died before first phase"),
        ])
        result, _ = self._run(tmp_path, runner)
        assert result.status == "error"
        assert result.cost_usd == 0.0


# ---------------------------------------------------------------------------
# Optional whole-process isolation via AGENTRAIL_SANDBOX_RUNTIME.
# ---------------------------------------------------------------------------

class TestSandboxRuntimeWrap:
    def _ok_runner(self, run_dir: Path) -> FakeRunner:
        def _do_run(cmd, cwd, env):
            log_dir = _extract_log_dir(cmd, run_dir)
            run_id = _extract_run_id(cmd) or "host-run"
            _write_run_json(Path(log_dir) / run_id, _green_run_json())
            return _Completed(0, stdout="ran")

        return FakeRunner([_Completed(0, stdout="cloned"), _do_run])

    def test_off_by_default(self, tmp_path) -> None:
        dirs = _RunDirs(tmp_path)
        runner = self._ok_runner(tmp_path / "run-1")
        run_issue_on_host(
            repo_url="r", ref="main", issue_ref="7", workspace_id="w",
            env={}, run_dir_factory=dirs, runner=runner,
        )
        run_cmd = runner.command_with("issue")
        assert "npx" not in run_cmd
        assert run_cmd[0] == "agentrail"

    def test_wraps_with_sandbox_runtime_when_enabled(self, tmp_path) -> None:
        dirs = _RunDirs(tmp_path)
        runner = self._ok_runner(tmp_path / "run-1")
        run_issue_on_host(
            repo_url="r", ref="main", issue_ref="7", workspace_id="w",
            env={"AGENTRAIL_SANDBOX_RUNTIME": "1"},
            run_dir_factory=dirs, runner=runner,
        )
        run_cmd = runner.command_with("issue")
        assert run_cmd[0] == "npx"
        assert "@anthropic-ai/sandbox-runtime" in run_cmd
        # the real agentrail command still follows the wrapper
        assert "agentrail" in run_cmd
        assert "issue" in run_cmd


# ---------------------------------------------------------------------------
# #968 — prompt mode: a corpus task is a PROMPT, not a numbered issue. When a
# ``prompt`` is given, the in-clone command must drive ``agentrail run prompt``
# carrying the prompt (NOT ``run issue``); when it is absent, the issue path is
# byte-identical.
# ---------------------------------------------------------------------------

class TestPromptMode:
    def _ok_runner(self, run_dir: Path) -> FakeRunner:
        def _do_run(cmd, cwd, env):
            log_dir = _extract_log_dir(cmd, run_dir)
            run_id = _extract_run_id(cmd) or "host-run"
            _write_run_json(Path(log_dir) / run_id, _green_run_json())
            return _Completed(0, stdout="ran")

        # ref is a branch NAME here (not a SHA) so there is no extra checkout
        # step — clone (--branch) then the agentrail run command.
        return FakeRunner([_Completed(0, stdout="cloned"), _do_run])

    def _run(self, tmp_path, runner, **over):
        dirs = _RunDirs(tmp_path)
        kwargs = dict(
            repo_url="https://github.com/acme/widgets.git",
            ref="main",
            issue_ref="afk-objective-gate",
            workspace_id="eval",
            env={},
            run_dir_factory=dirs,
            runner=runner,
            publish_pr=False,
        )
        kwargs.update(over)
        return run_issue_on_host(**kwargs), dirs

    def test_prompt_drives_run_prompt_not_run_issue(self, tmp_path) -> None:
        runner = self._ok_runner(tmp_path / "run-1")
        prompt = "Realign the review gate to ADR 0007 and add a test."
        self._run(tmp_path, runner, prompt=prompt)

        run_cmd = runner.command_with("prompt")
        assert "agentrail" in run_cmd
        assert "run" in run_cmd
        assert run_cmd[run_cmd.index("run") + 1] == "prompt"
        # The actual prompt text is carried on argv (the agent works on it).
        assert prompt in run_cmd
        # The issue path is NOT taken in prompt mode.
        assert "issue" not in run_cmd
        # The task name is passed as the run label.
        assert "--label" in run_cmd
        assert run_cmd[run_cmd.index("--label") + 1] == "afk-objective-gate"

    def test_no_prompt_keeps_byte_identical_issue_command(self, tmp_path) -> None:
        runner = self._ok_runner(tmp_path / "run-1")
        # No prompt → the existing issue path, unchanged.
        self._run(tmp_path, runner, issue_ref="7")
        run_cmd = runner.command_with("issue")
        assert run_cmd[run_cmd.index("run") + 1] == "issue"
        assert "7" in run_cmd
        assert "prompt" not in run_cmd
        assert "--label" not in run_cmd

    def test_prompt_mode_carries_model_and_run_id(self, tmp_path) -> None:
        runner = self._ok_runner(tmp_path / "run-1")
        self._run(tmp_path, runner, prompt="do the thing",
                  model="claude-opus-4-8", run_id="host-run")
        run_cmd = runner.command_with("prompt")
        assert run_cmd[run_cmd.index("--model") + 1] == "claude-opus-4-8"
        assert run_cmd[run_cmd.index("--run-id") + 1] == "host-run"


# ---------------------------------------------------------------------------
# #970 — injectable launcher: the eval must drive the CURRENT source under test
# (which has ``run prompt``), not the npm-published ``agentrail`` on PATH. When
# ``agentrail_cmd`` is injected, the command runs the source module + names the
# clone via ``--target``, and the run is invoked with the eval's ``run_cwd`` /
# ``run_env``. When NOT injected, the command is byte-identical to before — the
# real autonomous loop's sandbox path is unchanged.
# ---------------------------------------------------------------------------

class TestInjectableLauncherCommand:
    """Unit tests on ``_build_run_command`` directly (no clone, no agent)."""

    def test_default_issue_command_is_byte_identical(self) -> None:
        # No injected launcher → exactly the old loop command.
        cmd = _build_run_command(
            issue_ref="42", agent="claude", model=None,
            log_dir="/logs", sandbox_runtime=False, run_id="host-run",
        )
        assert cmd == [
            "agentrail", "run", "issue", "42",
            "--agent", "claude",
            "--run-id", "host-run",
            "--log-dir", "/logs",
        ]
        # No --target leaks into the default loop command.
        assert "--target" not in cmd

    def test_injected_launcher_runs_source_module_with_target(self) -> None:
        cmd = _build_run_command(
            issue_ref="afk-objective-gate", agent="claude", model="claude-opus-4-8",
            log_dir="/logs", sandbox_runtime=False, run_id="host-run",
            prompt="do the task",
            agentrail_cmd=["/usr/bin/python3", "-m", "agentrail.cli.main"],
            target="/clone/repo",
        )
        # Launches the SOURCE module, NOT a bare ``agentrail`` binary.
        assert cmd[:3] == ["/usr/bin/python3", "-m", "agentrail.cli.main"]
        assert "agentrail" not in cmd  # the bare PATH binary is never invoked
        assert cmd[3:5] == ["run", "prompt"]
        assert "do the task" in cmd
        # The clone is named explicitly so the agent edits it (not the source).
        assert "--target" in cmd
        assert cmd[cmd.index("--target") + 1] == "/clone/repo"


class TestInjectableLauncherRun:
    """End-to-end (faked subprocess) — verify cwd/env routing for injection."""

    def _ok_runner(self, run_dir: Path) -> FakeRunner:
        def _do_run(cmd, cwd, env):
            log_dir = _extract_log_dir(cmd, run_dir)
            run_id = _extract_run_id(cmd) or "host-run"
            _write_run_json(Path(log_dir) / run_id, _green_run_json())
            return _Completed(0, stdout="ran")

        return FakeRunner([_Completed(0, stdout="cloned"), _do_run])

    def test_injected_run_uses_source_cwd_and_env(self, tmp_path) -> None:
        runner = self._ok_runner(tmp_path / "run-1")
        dirs = _RunDirs(tmp_path)
        run_issue_on_host(
            repo_url="https://github.com/acme/widgets.git",
            ref="main",
            issue_ref="afk-objective-gate",
            workspace_id="eval",
            env={},
            prompt="do the task",
            agentrail_cmd=["py", "-m", "agentrail.cli.main"],
            run_cwd="/src/root",
            run_env={"PYTHONPATH": "/src/root", "AGENTRAIL_ALLOW_SOURCE_RUN": "1"},
            run_dir_factory=dirs,
            runner=runner,
            publish_pr=False,
        )
        # The clone still happens in the per-run work dir (not the source).
        clone_call = next(c for c in runner.calls if "clone" in c["cmd"])
        assert clone_call["cwd"] != "/src/root"
        # The agentrail run is invoked with cwd == the SOURCE tree (so import
        # agentrail resolves to source, not the clone which would shadow it).
        run_call = next(c for c in runner.calls if "prompt" in c["cmd"])
        assert run_call["cwd"] == "/src/root"
        assert run_call["env"].get("PYTHONPATH") == "/src/root"
        assert run_call["env"].get("AGENTRAIL_ALLOW_SOURCE_RUN") == "1"
        # The clone is named via --target so the agent edits it.
        assert "--target" in run_call["cmd"]

    def test_default_run_unchanged_cwd_is_clone(self, tmp_path) -> None:
        # No injection → run command's cwd is the clone (the real loop path).
        runner = self._ok_runner(tmp_path / "run-1")
        dirs = _RunDirs(tmp_path)
        run_issue_on_host(
            repo_url="https://github.com/acme/widgets.git",
            ref="main",
            issue_ref="7",
            workspace_id="ws",
            env={},
            run_dir_factory=dirs,
            runner=runner,
        )
        run_call = next(c for c in runner.calls if "issue" in c["cmd"])
        # cwd is the clone's repo dir, NOT a source tree; no --target injected.
        assert run_call["cwd"].endswith("repo")
        assert "--target" not in run_call["cmd"]
        assert run_call["cmd"][0] == "agentrail"


# ---------------------------------------------------------------------------
# Helpers shared by the fakes: pull --log-dir / --run-id out of a run command.
# ---------------------------------------------------------------------------

def _extract_log_dir(cmd: List[str], default: Path) -> str:
    if "--log-dir" in cmd:
        return cmd[cmd.index("--log-dir") + 1]
    return str(default)


def _extract_run_id(cmd: List[str]) -> Optional[str]:
    if "--run-id" in cmd:
        return cmd[cmd.index("--run-id") + 1]
    return None
