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
    ENV_HOSTED,
    ENV_HOSTED_CONFIG,
    HOSTED_REFUSAL_PREFIX,
    HostError,
    HostTimeout,
    _authenticated_clone_url,
    _build_run_command,
    _inject_hosted_config,
    _redact_token,
    _result_from_run_json,
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

    def test_budget_and_source_passed_when_given(self, tmp_path) -> None:
        """#1275: budget_usd/budget_source mirror model/--model exactly."""
        runner = self._ok_runner(tmp_path / "run-1")
        self._run(tmp_path, runner, budget_usd=12.5, budget_source="brief")
        run_cmd = runner.command_with("issue")
        assert "--budget-usd" in run_cmd
        assert run_cmd[run_cmd.index("--budget-usd") + 1] == "12.5"
        assert "--budget-source" in run_cmd
        assert run_cmd[run_cmd.index("--budget-source") + 1] == "brief"

    def test_no_budget_flags_when_absent(self, tmp_path) -> None:
        """Regression pin: budget_usd/budget_source both default to None ->
        byte-identical argv (neither flag appears at all)."""
        runner = self._ok_runner(tmp_path / "run-1")
        self._run(tmp_path, runner)
        run_cmd = runner.command_with("issue")
        assert "--budget-usd" not in run_cmd
        assert "--budget-source" not in run_cmd

    def test_budget_source_omitted_when_only_budget_usd_given(self, tmp_path) -> None:
        runner = self._ok_runner(tmp_path / "run-1")
        self._run(tmp_path, runner, budget_usd=3.0)
        run_cmd = runner.command_with("issue")
        assert "--budget-usd" in run_cmd
        assert "--budget-source" not in run_cmd

    def test_zero_budget_still_passes_the_flag(self, tmp_path) -> None:
        """0 is a deliberate, real "uncapped" choice (same convention as
        --budget-usd 0 downstream) — it must not be dropped as falsy."""
        runner = self._ok_runner(tmp_path / "run-1")
        self._run(tmp_path, runner, budget_usd=0.0, budget_source="brief")
        run_cmd = runner.command_with("issue")
        assert "--budget-usd" in run_cmd
        assert run_cmd[run_cmd.index("--budget-usd") + 1] == "0.0"

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
# GitHub auth (per-workspace OAuth token / PAT) — clone/push/gh authenticate
# off ``env["GIT_TOKEN"]`` without the token ever landing on argv or in
# anything this runner reports back as telemetry.
# ---------------------------------------------------------------------------

class TestAuthenticatedCloneUrl:
    def test_embeds_token_in_https_url(self) -> None:
        url = _authenticated_clone_url("https://github.com/acme/widgets.git", "ght-secret")
        assert url == "https://x-access-token:ght-secret@github.com/acme/widgets.git"

    def test_no_token_leaves_url_unchanged(self) -> None:
        url = _authenticated_clone_url("https://github.com/acme/widgets.git", "")
        assert url == "https://github.com/acme/widgets.git"

    def test_ssh_url_is_never_modified_even_with_a_token(self) -> None:
        url = _authenticated_clone_url("git@github.com:acme/widgets.git", "ght-secret")
        assert url == "git@github.com:acme/widgets.git"


class TestRedactToken:
    def test_strips_every_occurrence(self) -> None:
        text = "fatal: unable to access 'https://x-access-token:ght-secret@github.com/x'\nght-secret again"
        out = _redact_token(text, "ght-secret")
        assert "ght-secret" not in out
        assert out.count("***") == 2

    def test_no_token_is_a_no_op(self) -> None:
        assert _redact_token("some log text", "") == "some log text"


class TestGitTokenThreadedIntoRun:
    """End-to-end (faked subprocess): GIT_TOKEN drives the clone URL + GH_TOKEN,
    and is scrubbed from anything the run reports back on failure.
    """

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
        return run_issue_on_host(**kwargs), dirs

    def test_clone_url_carries_the_token(self, tmp_path) -> None:
        runner = FakeRunner([_Completed(128, stdout="", stderr="fatal: not found")])
        self._run(tmp_path, runner)
        clone_cmd = runner.command_with("clone")
        joined = " ".join(clone_cmd)
        assert "x-access-token:ght-secret@github.com" in joined
        # ...but never the plain, unauthenticated URL — the token IS embedded.
        assert "https://github.com/acme/widgets.git" not in clone_cmd

    def test_no_token_clones_the_plain_url(self, tmp_path) -> None:
        runner = FakeRunner([_Completed(128, stdout="", stderr="fatal: not found")])
        self._run(tmp_path, runner, env={})
        clone_cmd = runner.command_with("clone")
        assert "https://github.com/acme/widgets.git" in clone_cmd
        assert "x-access-token" not in " ".join(clone_cmd)

    def test_clone_failure_never_leaks_the_token_in_logs_tail(self, tmp_path) -> None:
        # Simulate git itself echoing the authenticated URL back on a 403 — the
        # runner's own redaction must catch it regardless of git's behaviour.
        leaking_stderr = (
            "fatal: unable to access "
            "'https://x-access-token:ght-secret@github.com/acme/widgets.git/': "
            "The requested URL returned error: 403"
        )
        runner = FakeRunner([_Completed(128, stdout="", stderr=leaking_stderr)])
        result, _ = self._run(tmp_path, runner)
        assert result.status == "error"
        assert "ght-secret" not in result.logs_tail
        assert "***" in result.logs_tail

    def test_gh_token_exported_for_publish_step(self, tmp_path) -> None:
        run_dir = tmp_path / "run-1"

        def _do_run(cmd, cwd, env):
            log_dir = _extract_log_dir(cmd, run_dir)
            run_id = _extract_run_id(cmd) or "host-run"
            _write_run_json(Path(log_dir) / run_id, _green_run_json())
            return _Completed(0, stdout="ran")

        runner = FakeRunner([
            _Completed(0, stdout="cloned"),
            _do_run,
            _Completed(0, stdout="main"),   # rev-parse
            _Completed(0),                  # checkout -B
            _Completed(0),                  # add -A
            _Completed(0),                  # commit
            _Completed(0),                  # push
            _Completed(0, stdout="https://github.com/acme/widgets/pull/9"),  # gh pr create
        ])
        self._run(tmp_path, runner, pr_title="Add a thing")
        pr_call = next(c for c in runner.calls if "create" in c["cmd"])
        assert pr_call["env"].get("GH_TOKEN") == "ght-secret"

    def test_gh_token_does_not_override_an_existing_gh_auth(self, tmp_path) -> None:
        run_dir = tmp_path / "run-1"

        def _do_run(cmd, cwd, env):
            log_dir = _extract_log_dir(cmd, run_dir)
            run_id = _extract_run_id(cmd) or "host-run"
            _write_run_json(Path(log_dir) / run_id, _green_run_json())
            return _Completed(0, stdout="ran")

        runner = FakeRunner([
            _Completed(0, stdout="cloned"),
            _do_run,
            _Completed(0, stdout="main"),
            _Completed(0),
            _Completed(0),
            _Completed(0),
            _Completed(0),
            _Completed(0, stdout="https://github.com/acme/widgets/pull/9"),
        ])
        self._run(
            tmp_path, runner, pr_title="Add a thing",
            env={"GIT_TOKEN": "ght-secret", "GH_TOKEN": "already-configured"},
        )
        pr_call = next(c for c in runner.calls if "create" in c["cmd"])
        assert pr_call["env"].get("GH_TOKEN") == "already-configured"


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
# #1267 PR③ — a hosted startup refusal (marked by a top-level `refusal` object
# in run.json, written by pipeline.py's #1270 assert BEFORE any phase runs)
# must map to status="error" with a gate_reason carrying the deterministic
# HOSTED_REFUSAL_PREFIX — never "red" (red means "worth retrying / escalating
# tier", which a static per-repo config gap never is). The no-marker exit-1
# fallback (today's pre-existing behavior) must stay byte-identical.
# ---------------------------------------------------------------------------

class _BranchRunner:
    """Minimal runner stub for the post-parse `git rev-parse` branch lookup
    (best-effort — _result_from_run_json swallows any failure here)."""

    def run(self, cmd, *, cwd=None, env=None, timeout=None, **kwargs):
        return _Completed(0, stdout="main\n")


class TestResultFromRunJsonRefusalMarker:
    """Direct unit tests on `_result_from_run_json` (no clone, no subprocess)."""

    def test_refusal_marker_maps_to_error_with_prefixed_reason(self, tmp_path) -> None:
        run_dir = tmp_path / "run-1"
        _write_run_json(run_dir, {
            "refusal": {
                "kind": "independent_review",
                "status": "skipped_no_distinct_model",
                "message": "FATAL: hosted run refused",
            }
        })
        result = _result_from_run_json(
            run_dir, run_status=1, repo_dir=tmp_path, logs_tail="",
            runner=_BranchRunner(),
        )
        assert result.status == "error"
        assert result.gate_reason == f"{HOSTED_REFUSAL_PREFIX}FATAL: hosted run refused"

    def test_refusal_marker_never_maps_to_red(self, tmp_path) -> None:
        run_dir = tmp_path / "run-1"
        _write_run_json(run_dir, {"refusal": {"message": "no reviewer configured"}})
        result = _result_from_run_json(
            run_dir, run_status=1, repo_dir=tmp_path, logs_tail="",
            runner=_BranchRunner(),
        )
        assert result.status != "red"
        assert result.status == "error"

    def test_refusal_marker_takes_priority_over_objective_gate(self, tmp_path) -> None:
        """Belt-and-suspenders: a refusal exits before any phase runs, so a
        real run.json never carries both keys — but if it somehow did, the
        refusal must win (it is the more specific, more recent fact)."""
        run_dir = tmp_path / "run-1"
        _write_run_json(run_dir, {
            "refusal": {"message": "no reviewer configured"},
            "objectiveGate": {"verdict": "green"},
        })
        result = _result_from_run_json(
            run_dir, run_status=1, repo_dir=tmp_path, logs_tail="",
            runner=_BranchRunner(),
        )
        assert result.status == "error"

    def test_missing_message_falls_back_to_a_generic_reason(self, tmp_path) -> None:
        run_dir = tmp_path / "run-1"
        _write_run_json(run_dir, {"refusal": {}})
        result = _result_from_run_json(
            run_dir, run_status=1, repo_dir=tmp_path, logs_tail="",
            runner=_BranchRunner(),
        )
        assert result.status == "error"
        assert result.gate_reason.startswith(HOSTED_REFUSAL_PREFIX)

    def test_no_marker_exit_1_still_maps_to_red_exactly_as_before(self, tmp_path) -> None:
        """Regression: the pre-#1267-PR③ fallback (no gate, no marker, nonzero
        exit) is untouched — byte-identical reason string."""
        run_dir = tmp_path / "run-1"
        _write_run_json(run_dir, {})
        result = _result_from_run_json(
            run_dir, run_status=1, repo_dir=tmp_path, logs_tail="",
            runner=_BranchRunner(),
        )
        assert result.status == "red"
        assert result.gate_reason == "agentrail run exited 1"

    def test_no_marker_exit_0_still_maps_to_green_exactly_as_before(self, tmp_path) -> None:
        run_dir = tmp_path / "run-1"
        _write_run_json(run_dir, {})
        result = _result_from_run_json(
            run_dir, run_status=0, repo_dir=tmp_path, logs_tail="",
            runner=_BranchRunner(),
        )
        assert result.status == "green"
        assert result.gate_reason == ""

    def test_real_objective_gate_verdicts_still_parse_exactly_as_before(self, tmp_path) -> None:
        """Regression: a run.json with no `refusal` key still reads
        objectiveGate.verdict exactly as it did pre-#1267-PR③."""
        run_dir = tmp_path / "run-1"
        _write_run_json(run_dir, {
            "objectiveGate": {"verdict": "red", "failedReasons": ["AC2 unverified"]},
        })
        result = _result_from_run_json(
            run_dir, run_status=1, repo_dir=tmp_path, logs_tail="",
            runner=_BranchRunner(),
        )
        assert result.status == "red"
        assert "AC2 unverified" in result.gate_reason


class TestHostedRefusalEndToEnd:
    """Full stack (faked subprocess): the 'agentrail run issue' step exits 1
    AND writes a run.json carrying the refusal marker — exactly what a real
    hosted refusal does (pipeline.py writes the marker, then `return 1`).
    `run_issue_on_host` must report status="error" with the prefixed reason.
    """

    def _refusal_runner(
        self, run_dir: Path, message: str = "FATAL: hosted run refused"
    ) -> FakeRunner:
        def _do_run(cmd, cwd, env):
            log_dir = _extract_log_dir(cmd, run_dir)
            run_id = _extract_run_id(cmd) or "host-run"
            _write_run_json(Path(log_dir) / run_id, {
                "refusal": {
                    "kind": "independent_review",
                    "status": "skipped_no_distinct_model",
                    "message": message,
                }
            })
            # A refused run exits 1 — same as agentrail/run/pipeline.py's
            # `return 1` at the #1270 startup assert.
            return _Completed(1, stdout="", stderr=message)

        return FakeRunner([
            _Completed(0, stdout="cloned"),  # git clone
            _do_run,                          # agentrail run issue (refuses)
        ])

    def _run(self, tmp_path, runner, **over):
        dirs = _RunDirs(tmp_path)
        kwargs = dict(
            repo_url="https://github.com/acme/widgets.git",
            ref="main", issue_ref="7", workspace_id="ws-123",
            env={}, run_dir_factory=dirs, runner=runner,
        )
        kwargs.update(over)
        return run_issue_on_host(**kwargs), dirs

    def test_refused_run_reports_error_with_hosted_refusal_reason(self, tmp_path) -> None:
        runner = self._refusal_runner(tmp_path / "run-1")
        result, _ = self._run(tmp_path, runner)
        assert result.status == "error"
        assert result.gate_reason == f"{HOSTED_REFUSAL_PREFIX}FATAL: hosted run refused"

    def test_refused_run_never_reports_red(self, tmp_path) -> None:
        runner = self._refusal_runner(tmp_path / "run-1")
        result, _ = self._run(tmp_path, runner)
        assert result.status != "red"

    def test_refused_run_never_publishes_a_pr(self, tmp_path) -> None:
        """Only a green gate publishes (commit/push/PR) — a refusal must never
        trigger that path even though publish_pr defaults to True."""
        runner = self._refusal_runner(tmp_path / "run-1")
        result, _ = self._run(tmp_path, runner)
        assert result.pr_url == ""
        # No `gh pr create` (or push-to-feature-branch) command ever issued.
        assert not any("create" in c and "gh" in c for c in runner.commands)
        assert not any("push" in c for c in runner.commands)

    def test_refused_run_preserves_caller_owned_dir(self, tmp_path) -> None:
        # Caller-owned-workdir contract (#997), same as the error/timeout paths.
        runner = self._refusal_runner(tmp_path / "run-1")
        _, dirs = self._run(tmp_path, runner)
        for d in dirs.created:
            assert d.exists()


class TestHostedRefusalPrefixCrossLanguageLockstep:
    """Drift guard for the cross-process contract: the TS queue-transition side
    (packages/db-postgres/src/queries/runner.ts) keys on the byte-identical
    ``HOSTED_REFUSAL_PREFIX`` constant. A silent mismatch would turn every
    refusal back into an ordinary retried gate failure — so this regex-over-
    source test (same style as apps/jace/test's source-scanning tests) reads
    the TS definition line and pins it to the Python constant BY CONSTRUCTION:
    change either side alone and this fails.
    """

    def test_ts_constant_definition_matches_python_constant(self) -> None:
        import re

        repo_root = Path(__file__).resolve().parents[3]
        ts_source = (
            repo_root / "packages" / "db-postgres" / "src" / "queries" / "runner.ts"
        ).read_text(encoding="utf-8")
        # Whitespace-tolerant on the declaration, exact on the VALUE (built
        # from the Python constant, double-quoted like the TS source).
        pattern = (
            r"export\s+const\s+HOSTED_REFUSAL_PREFIX\s*=\s*"
            + re.escape(f'"{HOSTED_REFUSAL_PREFIX}"')
        )
        assert re.search(pattern, ts_source), (
            "packages/db-postgres/src/queries/runner.ts must define "
            f"HOSTED_REFUSAL_PREFIX = \"{HOSTED_REFUSAL_PREFIX}\" byte-identically "
            "to agentrail.sandbox.native_runner.HOSTED_REFUSAL_PREFIX — a "
            "mismatch silently turns every hosted refusal back into an "
            "ordinary retried gate failure (#1267 PR3)."
        )


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

    def test_budget_usd_and_source_appended_when_given(self) -> None:
        cmd = _build_run_command(
            issue_ref="42", agent="claude", model=None,
            log_dir="/logs", sandbox_runtime=False, run_id="host-run",
            budget_usd=12.5, budget_source="brief",
        )
        assert cmd == [
            "agentrail", "run", "issue", "42",
            "--agent", "claude",
            "--run-id", "host-run",
            "--log-dir", "/logs",
            "--budget-usd", "12.5",
            "--budget-source", "brief",
        ]

    def test_budget_source_omitted_without_a_label(self) -> None:
        cmd = _build_run_command(
            issue_ref="42", agent="claude", model=None,
            log_dir="/logs", sandbox_runtime=False, run_id="host-run",
            budget_usd=3.0,
        )
        assert "--budget-usd" in cmd
        assert "--budget-source" not in cmd

    def test_no_budget_flags_when_both_absent_byte_identical(self) -> None:
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
        assert "--budget-usd" not in cmd
        assert "--budget-source" not in cmd


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


# ---------------------------------------------------------------------------
# #1267 PR② — hosted default config injection: closes the AC1 gap where a
# fleet-claimed customer repo with no .agentrail/config.json of its own gets
# permanently refused by #1270's independent-review assert. Unit tests on
# _inject_hosted_config directly (no clone, no subprocess), plus one
# end-to-end test proving it runs at the right point in run_issue_on_host
# (after checkout, before the agent command executes).
# ---------------------------------------------------------------------------

_TEMPLATE_TEXT = (
    '{"schemaVersion": 1, "runners": {"claude": '
    '{"models": {"execute": "anthropic/claude-sonnet-5", "verify": "z-ai/glm-5.2"}}}}'
)


class TestInjectHostedConfigUnit:
    def _hosted_env(self, template_path) -> dict:
        return {ENV_HOSTED: "1", ENV_HOSTED_CONFIG: str(template_path)}

    def _write_template(self, tmp_path: Path, text: str = _TEMPLATE_TEXT) -> Path:
        template = tmp_path / "agentrail-config.hosted.json"
        template.write_text(text)
        return template

    def test_not_hosted_never_injects(self, tmp_path: Path) -> None:
        template = self._write_template(tmp_path)
        repo_dir = tmp_path / "repo"
        repo_dir.mkdir()
        _inject_hosted_config(repo_dir, {ENV_HOSTED_CONFIG: str(template)})  # AGENTRAIL_HOSTED absent
        assert not (repo_dir / ".agentrail" / "config.json").exists()

    def test_hosted_flag_value_other_than_one_is_not_hosted(self, tmp_path: Path) -> None:
        template = self._write_template(tmp_path)
        repo_dir = tmp_path / "repo"
        repo_dir.mkdir()
        _inject_hosted_config(
            repo_dir, {ENV_HOSTED: "true", ENV_HOSTED_CONFIG: str(template)}
        )
        assert not (repo_dir / ".agentrail" / "config.json").exists()

    def test_hosted_with_no_existing_config_injects_byte_identically(self, tmp_path: Path) -> None:
        template = self._write_template(tmp_path)
        repo_dir = tmp_path / "repo"
        repo_dir.mkdir()
        _inject_hosted_config(repo_dir, self._hosted_env(template))
        written = (repo_dir / ".agentrail" / "config.json").read_text()
        assert written == _TEMPLATE_TEXT

    def test_hosted_with_existing_config_leaves_it_untouched(self, tmp_path: Path) -> None:
        template = self._write_template(tmp_path)
        repo_dir = tmp_path / "repo"
        existing_dir = repo_dir / ".agentrail"
        existing_dir.mkdir(parents=True)
        own_config = '{"runners": {"claude": {"models": {"execute": "x", "verify": "y"}}}}'
        (existing_dir / "config.json").write_text(own_config)

        _inject_hosted_config(repo_dir, self._hosted_env(template))

        assert (existing_dir / "config.json").read_text() == own_config

    def test_hosted_but_template_path_unset_warns_and_does_not_inject(
        self, tmp_path: Path, capsys
    ) -> None:
        repo_dir = tmp_path / "repo"
        repo_dir.mkdir()
        _inject_hosted_config(repo_dir, {ENV_HOSTED: "1"})  # no AGENTRAIL_HOSTED_CONFIG
        assert not (repo_dir / ".agentrail" / "config.json").exists()
        err = capsys.readouterr().err
        assert "AGENTRAIL_HOSTED_CONFIG" in err

    def test_hosted_but_template_unreadable_warns_and_does_not_inject(
        self, tmp_path: Path, capsys
    ) -> None:
        repo_dir = tmp_path / "repo"
        repo_dir.mkdir()
        missing_template = tmp_path / "does-not-exist.json"
        _inject_hosted_config(
            repo_dir, {ENV_HOSTED: "1", ENV_HOSTED_CONFIG: str(missing_template)}
        )
        assert not (repo_dir / ".agentrail" / "config.json").exists()
        err = capsys.readouterr().err
        assert str(missing_template) in err

    def test_missing_template_never_raises_and_run_proceeds(self, tmp_path: Path, capsys) -> None:
        # The honest-refusal contract: this must never crash the run — it
        # degrades to a warning so the run proceeds to whatever verdict it
        # would have reached anyway (possibly the independent-review refusal).
        repo_dir = tmp_path / "repo"
        repo_dir.mkdir()
        _inject_hosted_config(
            repo_dir, {ENV_HOSTED: "1", ENV_HOSTED_CONFIG: str(tmp_path / "nope.json")}
        )  # must not raise


class TestInjectHostedConfigEndToEnd:
    """Proves the injection actually runs inside run_issue_on_host, after
    checkout and before the agent command executes."""

    def _run(self, tmp_path, runner, template_path, **over):
        dirs = _RunDirs(tmp_path)
        kwargs = dict(
            repo_url="https://github.com/acme/widgets.git",
            ref="main",
            issue_ref="7",
            workspace_id="ws-123",
            env={ENV_HOSTED: "1", ENV_HOSTED_CONFIG: str(template_path)},
            run_dir_factory=dirs,
            runner=runner,
        )
        kwargs.update(over)
        return run_issue_on_host(**kwargs), dirs

    def test_config_exists_by_the_time_the_agent_command_runs(self, tmp_path: Path) -> None:
        template = tmp_path / "agentrail-config.hosted.json"
        template.write_text(_TEMPLATE_TEXT)
        run_dir = tmp_path / "run-1"
        seen_config_at_run_time = {}

        def _do_run(cmd, cwd, env):
            # By the time "agentrail run issue" would execute, the clone must
            # already carry the injected config.
            config_path = Path(cwd) / ".agentrail" / "config.json"
            seen_config_at_run_time["exists"] = config_path.exists()
            seen_config_at_run_time["text"] = (
                config_path.read_text() if config_path.exists() else None
            )
            log_dir = _extract_log_dir(cmd, run_dir)
            run_id = _extract_run_id(cmd) or "host-run"
            _write_run_json(Path(log_dir) / run_id, _green_run_json())
            return _Completed(0, stdout="ran")

        runner = FakeRunner([_Completed(0, stdout="cloned"), _do_run])
        self._run(tmp_path, runner, template, publish_pr=False)

        assert seen_config_at_run_time["exists"] is True
        assert seen_config_at_run_time["text"] == _TEMPLATE_TEXT

    def test_not_hosted_end_to_end_never_injects(self, tmp_path: Path) -> None:
        template = tmp_path / "agentrail-config.hosted.json"
        template.write_text(_TEMPLATE_TEXT)
        run_dir = tmp_path / "run-1"

        def _do_run(cmd, cwd, env):
            assert not (Path(cwd) / ".agentrail" / "config.json").exists()
            log_dir = _extract_log_dir(cmd, run_dir)
            run_id = _extract_run_id(cmd) or "host-run"
            _write_run_json(Path(log_dir) / run_id, _green_run_json())
            return _Completed(0, stdout="ran")

        runner = FakeRunner([_Completed(0, stdout="cloned"), _do_run])
        dirs = _RunDirs(tmp_path)
        run_issue_on_host(
            repo_url="https://github.com/acme/widgets.git", ref="main", issue_ref="7",
            workspace_id="ws-123", env={}, run_dir_factory=dirs, runner=runner,
            publish_pr=False,
        )


class TestHostedConfigTemplateShape:
    """Ties the SHIPPED template to #1270's assert: the run.py verifier-skip
    logic (see annex-factory-recon.md §2) resolves NO verify phase when every
    candidate model equals the implementer's — so if this template's
    verify/execute models ever collapsed to the same value, a hosted fleet
    would silently regress into refusing every single run again."""

    def test_shipped_template_verify_model_is_distinct_from_execute(self) -> None:
        template_path = (
            Path(__file__).resolve().parents[3]
            / "deploy" / "runner" / "agentrail-config.hosted.json"
        )
        data = json.loads(template_path.read_text())
        models = data["runners"]["claude"]["models"]
        assert models["execute"]
        assert models["verify"]
        assert models["execute"] != models["verify"]
