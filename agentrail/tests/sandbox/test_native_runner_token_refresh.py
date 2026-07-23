"""Mid-run GitHub-token refresh recovery for the host runner (issue #1391).

A run that outlives its GitHub OAuth token fails at PUSH time, after all the
compute is already spent. ``run_issue_on_host`` now takes a
``github_token_refresher`` callback: when the publish push 401s because the
token expired mid-run, it refreshes the token ONCE and retries the push, so an
in-flight run survives token expiry (AC1). If the refresh (or the retried push)
still fails, the run records a DISTINCT infra-error classification instead of a
generic red (AC3).

These exercise the real ``run_issue_on_host`` → ``_publish_green`` seam with a
scripted fake runner (no real git/clone/network — the fetch/refresh boundary is
the injected callback), mirroring ``test_native_runner.py``'s harness.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import List, Optional

from agentrail.sandbox.native_runner import (
    GITHUB_TOKEN_REFRESH_FAILED,
    _looks_like_git_auth_failure,
    run_issue_on_host,
)


class _Completed:
    def __init__(self, returncode: int, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class FakeRunner:
    def __init__(self, results: List[object]) -> None:
        self._results = list(results)
        self.calls: List[dict] = []

    def run(self, cmd, *, cwd=None, env=None, timeout=None, **kwargs):
        self.calls.append({"cmd": list(cmd), "env": dict(env or {}), "kwargs": dict(kwargs)})
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

    def commands_with(self, token: str) -> List[List[str]]:
        return [c for c in self.commands if token in c]


def _write_run_json(run_dir: Path) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "run.json").write_text(json.dumps({"objectiveGate": {"verdict": "green"}}))


def _extract_log_dir(cmd: list, fallback: Path) -> str:
    for i, tok in enumerate(cmd):
        if tok == "--log-dir" and i + 1 < len(cmd):
            return cmd[i + 1]
    return str(fallback / ".agentrail-runs")


def _extract_run_id(cmd: list) -> str:
    for i, tok in enumerate(cmd):
        if tok == "--run-id" and i + 1 < len(cmd):
            return cmd[i + 1]
    return "host-run"


class _RunDirs:
    def __init__(self, tmp_path: Path) -> None:
        self._base = tmp_path
        self._n = 0

    def __call__(self) -> Path:
        self._n += 1
        d = self._base / f"run-{self._n}"
        d.mkdir(parents=True, exist_ok=True)
        return d


def _agent_run(run_dir: Path):
    def _do_run(cmd, cwd, env):
        log_dir = _extract_log_dir(cmd, run_dir)
        run_id = _extract_run_id(cmd) or "host-run"
        _write_run_json(Path(log_dir) / run_id)
        return _Completed(0, stdout="ran")
    return _do_run


_AUTH_FAIL = _Completed(
    128, stdout="",
    stderr="remote: Invalid username or token. Password authentication is not supported.\n"
           "fatal: Authentication failed for 'https://github.com/acme/widgets/'",
)


def _run(tmp_path, runner, **over):
    kwargs = dict(
        repo_url="https://github.com/acme/widgets.git",
        ref="main",
        issue_ref="7",
        workspace_id="ws-123",
        env={"GIT_TOKEN": "stale-token"},
        run_dir_factory=_RunDirs(tmp_path),
        runner=runner,
        pr_title="Add a thing",
    )
    kwargs.update(over)
    return run_issue_on_host(**kwargs)


# --- the auth-failure detector -----------------------------------------------


def test_looks_like_git_auth_failure_matches_known_markers():
    assert _looks_like_git_auth_failure(_AUTH_FAIL) is True
    assert _looks_like_git_auth_failure(
        _Completed(1, stderr="The requested URL returned error: 403")
    ) is True


def test_looks_like_git_auth_failure_ignores_non_auth_and_none():
    assert _looks_like_git_auth_failure(
        _Completed(1, stderr="fatal: unable to access: Could not resolve host")
    ) is False
    assert _looks_like_git_auth_failure(None) is False


# --- AC1: push 401 → refresh → retry → green ---------------------------------


def test_push_auth_failure_refreshes_and_retries_then_goes_green(tmp_path):
    run_dir = tmp_path / "run-1"
    runner = FakeRunner([
        _Completed(0, stdout="cloned"),   # git clone
        _agent_run(run_dir),              # agentrail run issue → green
        _Completed(0, stdout="main"),     # rev-parse (branch, in result parsing)
        _Completed(0),                    # checkout -B
        _Completed(0),                    # add -A
        _Completed(0),                    # commit
        _AUTH_FAIL,                       # push #1 → 401
        _Completed(0),                    # git remote set-url origin (fresh token)
        _Completed(0),                    # push #2 (retry) → ok
        _Completed(0, stdout="https://github.com/acme/widgets/pull/42"),  # gh pr create
    ])
    refreshed: List[int] = []

    def refresher() -> Optional[str]:
        refreshed.append(1)
        return "ghu_fresh"

    result = _run(tmp_path, runner, github_token_refresher=refresher)

    assert result.status == "green"
    assert result.pr_url == "https://github.com/acme/widgets/pull/42"
    assert len(refreshed) == 1  # refreshed exactly once
    # Two push attempts were made; the second used the fresh token.
    pushes = runner.commands_with("push")
    assert len(pushes) == 2
    # origin was re-pointed at a URL carrying the fresh token.
    set_url = runner.commands_with("set-url")
    assert set_url and any("ghu_fresh" in tok for tok in set_url[0])
    # The retried push + gh pr create ran under the fresh token in env.
    push2_call = [c for c in runner.calls if "push" in c["cmd"]][1]
    assert push2_call["env"].get("GIT_TOKEN") == "ghu_fresh"
    create_call = next(c for c in runner.calls if "create" in c["cmd"])
    assert create_call["env"].get("GH_TOKEN") == "ghu_fresh"


# --- AC3: refresh fails → distinct infra-error classification ----------------


def test_refresh_failure_records_distinct_infra_error(tmp_path):
    run_dir = tmp_path / "run-1"
    runner = FakeRunner([
        _Completed(0, stdout="cloned"),   # clone
        _agent_run(run_dir),              # agentrail run → green
        _Completed(0, stdout="main"),     # rev-parse
        _Completed(0),                    # checkout -B
        _Completed(0),                    # add -A
        _Completed(0),                    # commit
        _AUTH_FAIL,                       # push #1 → 401
    ])

    def refresher() -> Optional[str]:
        return None  # unrecoverable (bad_refresh_token / no refresh token)

    result = _run(tmp_path, runner, github_token_refresher=refresher)

    assert result.status == "error"          # NOT a generic red
    assert result.gate_reason == GITHUB_TOKEN_REFRESH_FAILED
    assert result.pr_url == ""
    # No retry push was attempted (refresh returned nothing to retry with).
    assert len(runner.commands_with("push")) == 1


def test_retry_exhausted_after_refresh_records_distinct_infra_error(tmp_path):
    run_dir = tmp_path / "run-1"
    runner = FakeRunner([
        _Completed(0, stdout="cloned"),   # clone
        _agent_run(run_dir),              # green
        _Completed(0, stdout="main"),     # rev-parse
        _Completed(0),                    # checkout -B
        _Completed(0),                    # add -A
        _Completed(0),                    # commit
        _AUTH_FAIL,                       # push #1 → 401
        _Completed(0),                    # set-url
        _AUTH_FAIL,                       # push #2 (retry) → still 401
    ])

    def refresher() -> Optional[str]:
        return "ghu_fresh"

    result = _run(tmp_path, runner, github_token_refresher=refresher)

    assert result.status == "error"
    assert result.gate_reason == GITHUB_TOKEN_REFRESH_FAILED
    # Exactly ONE retry — never an infinite loop.
    assert len(runner.commands_with("push")) == 2


# --- loop-not-broken: no refresher / non-auth failure = prior behavior --------


def test_no_refresher_keeps_prior_best_effort_behavior(tmp_path):
    """Without a refresher (single-workspace runner / no OAuth token), an auth
    push failure keeps today's behavior byte-for-byte: green, no PR, no error."""
    run_dir = tmp_path / "run-1"
    runner = FakeRunner([
        _Completed(0, stdout="cloned"),
        _agent_run(run_dir),
        _Completed(0, stdout="main"),
        _Completed(0),                    # checkout -B
        _Completed(0),                    # add -A
        _Completed(0),                    # commit
        _AUTH_FAIL,                       # push → 401, no recovery attempted
    ])
    result = _run(tmp_path, runner)  # no github_token_refresher
    assert result.status == "green"
    assert result.pr_url == ""
    assert len(runner.commands_with("push")) == 1


def test_non_auth_push_failure_does_not_refresh(tmp_path):
    """A NON-auth push failure never triggers a refresh even when a refresher is
    available — the refresh is reserved for credential rejections."""
    run_dir = tmp_path / "run-1"
    runner = FakeRunner([
        _Completed(0, stdout="cloned"),
        _agent_run(run_dir),
        _Completed(0, stdout="main"),
        _Completed(0),                    # checkout -B
        _Completed(0),                    # add -A
        _Completed(0),                    # commit
        _Completed(1, stderr="fatal: unable to access: Could not resolve host"),  # push → network
    ])
    called: List[int] = []

    def refresher() -> Optional[str]:
        called.append(1)
        return "ghu_fresh"

    result = _run(tmp_path, runner, github_token_refresher=refresher)
    assert result.status == "green"       # prior best-effort: green, no PR
    assert result.pr_url == ""
    assert called == []                    # refresh NOT attempted
    assert len(runner.commands_with("push")) == 1


def test_ample_token_green_run_never_calls_refresher(tmp_path):
    """The common case: a healthy push opens the PR and the refresher is never
    invoked — the working loop is untouched."""
    run_dir = tmp_path / "run-1"
    runner = FakeRunner([
        _Completed(0, stdout="cloned"),
        _agent_run(run_dir),
        _Completed(0, stdout="main"),
        _Completed(0),                    # checkout -B
        _Completed(0),                    # add -A
        _Completed(0),                    # commit
        _Completed(0),                    # push → ok
        _Completed(0, stdout="https://github.com/acme/widgets/pull/9"),  # gh pr create
    ])
    called: List[int] = []

    def refresher() -> Optional[str]:
        called.append(1)
        return "ghu_fresh"

    result = _run(tmp_path, runner, github_token_refresher=refresher)
    assert result.status == "green"
    assert result.pr_url == "https://github.com/acme/widgets/pull/9"
    assert called == []
