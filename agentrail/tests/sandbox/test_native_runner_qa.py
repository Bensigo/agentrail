"""QA-phase publish/comment behaviour in the host-native runner (#1148).

The native parser trusts ``objectiveGate.verdict`` over the process exit code, so
a QA red must be caught by consulting ``run.json["qa"]`` — otherwise a green gate
with a broken build would still publish a PR. These tests drive the real
``run_issue_on_host`` with a faked shell boundary (the same injectable ``runner``
seam the sibling test uses) and assert:

* QA red on a green gate → ``result.status == "red"``, reason carries ``qa:``, and
  NOTHING is published or commented (the scripted runner would raise on any extra
  call).
* QA passed on a green gate → the normal publish path runs AND a ``gh pr comment``
  fires carrying the QA verdict.
* QA skipped / absent → publish runs, but NO comment (a skip is not a verdict).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import List, Optional

from agentrail.sandbox.native_runner import run_issue_on_host


# ---------------------------------------------------------------------------
# Self-contained fakes (mirrors test_native_runner.py; kept local so this file
# stands alone).
# ---------------------------------------------------------------------------


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
        self.calls.append({"cmd": list(cmd), "cwd": cwd, "kwargs": dict(kwargs)})
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

    def has_command_with(self, token: str) -> bool:
        return any(token in c for c in self.commands)

    def command_with(self, token: str) -> List[str]:
        for c in self.commands:
            if token in c:
                return c
        raise AssertionError(f"no command containing {token!r} in {self.commands}")


class _RunDirs:
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


def _write_run_json(run_dir: Path, payload: dict) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "run.json").write_text(json.dumps(payload))


def _extract_log_dir(cmd: List[str], default: Path) -> str:
    if "--log-dir" in cmd:
        return cmd[cmd.index("--log-dir") + 1]
    return str(default)


def _extract_run_id(cmd: List[str]) -> Optional[str]:
    if "--run-id" in cmd:
        return cmd[cmd.index("--run-id") + 1]
    return None


def _do_run_writing(run_dir: Path, payload: dict):
    """A scripted 'agentrail run' step that lays down run.json, mirroring the
    pipeline writing its verdict + qa block."""

    def _do_run(cmd, cwd, env):
        log_dir = _extract_log_dir(cmd, run_dir)
        run_id = _extract_run_id(cmd) or "host-run"
        _write_run_json(Path(log_dir) / run_id, payload)
        return _Completed(0, stdout="ran")

    return _do_run


def _run_on_host(tmp_path, runner, **over):
    dirs = _RunDirs(tmp_path)
    kwargs = dict(
        repo_url="https://github.com/acme/widgets.git",
        ref="main",
        issue_ref="7",
        workspace_id="ws-123",
        env={},
        run_dir_factory=dirs,
        runner=runner,
    )
    kwargs.update(over)
    return run_issue_on_host(**kwargs), dirs


# ---------------------------------------------------------------------------
# QA red on a green gate → red result, no publish, no comment
# ---------------------------------------------------------------------------


def test_qa_failed_reds_the_run_and_blocks_publish(tmp_path) -> None:
    run_dir = tmp_path / "run-1"
    payload = {
        "objectiveGate": {"verdict": "green"},
        "qa": {"verdict": "failed", "reason": "qa.sh exited 1"},
    }
    # Only clone, run, and the best-effort rev-parse are scripted. If the runner
    # tried to publish or comment, FakeRunner would raise on the extra call.
    runner = FakeRunner([
        _Completed(0, stdout="cloned"),          # git clone
        _do_run_writing(run_dir, payload),       # agentrail run issue
        _Completed(0, stdout="main"),            # rev-parse (branch)
    ])
    result, _ = _run_on_host(tmp_path, runner, pr_title="Add a thing")

    assert result.status == "red"
    assert "qa:" in result.gate_reason
    assert "qa.sh exited 1" in result.gate_reason
    # No publish, no PR comment.
    assert not runner.has_command_with("create")
    assert not runner.has_command_with("commit")
    assert not runner.has_command_with("comment")
    assert result.pr_url == ""


# ---------------------------------------------------------------------------
# QA passed on a green gate → publish path runs AND a PR comment fires
# ---------------------------------------------------------------------------


def test_qa_passed_publishes_and_comments_on_pr(tmp_path) -> None:
    run_dir = tmp_path / "run-1"
    payload = {
        "objectiveGate": {"verdict": "green"},
        "qa": {
            "verdict": "passed",
            "reason": "qa.sh exited 0",
            "artifactNames": ["dashboard.html", "notes.md"],
            "logTail": "✅ QA PASSED: dashboard rendered 'Dev Workspace'",
        },
    }
    pr_url = "https://github.com/acme/widgets/pull/42"
    runner = FakeRunner([
        _Completed(0, stdout="cloned"),          # git clone
        _do_run_writing(run_dir, payload),       # agentrail run issue
        _Completed(0, stdout="main"),            # rev-parse (branch)
        _Completed(0),                           # checkout -B
        _Completed(0),                           # add -A
        _Completed(0),                           # commit
        _Completed(0),                           # push
        _Completed(0, stdout=pr_url),            # gh pr create
        _Completed(0),                           # gh pr comment
    ])
    result, _ = _run_on_host(tmp_path, runner, pr_title="Add a thing")

    assert result.status == "green"
    assert result.pr_url == pr_url
    # The QA verdict was commented onto the PR.
    comment = runner.command_with("comment")
    assert comment[:3] == ["gh", "pr", "comment"]
    assert pr_url in comment
    body = comment[comment.index("--body") + 1]
    assert "QA phase" in body
    assert "dashboard.html" in body  # artifacts surfaced


# ---------------------------------------------------------------------------
# QA skipped on a green gate → publish runs, but NO comment
# ---------------------------------------------------------------------------


def test_qa_skipped_publishes_without_comment(tmp_path) -> None:
    run_dir = tmp_path / "run-1"
    payload = {
        "objectiveGate": {"verdict": "green"},
        "qa": {"verdict": "skipped", "reason": "no UI/runtime surface"},
    }
    # 8 scripted calls: clone, run, rev-parse, checkout, add, commit, push,
    # gh pr create. NO comment scripted → if the runner tried to comment,
    # FakeRunner would raise.
    runner = FakeRunner([
        _Completed(0, stdout="cloned"),
        _do_run_writing(run_dir, payload),
        _Completed(0, stdout="main"),
        _Completed(0),
        _Completed(0),
        _Completed(0),
        _Completed(0),
        _Completed(0, stdout="https://github.com/acme/widgets/pull/42"),
    ])
    result, _ = _run_on_host(tmp_path, runner)

    assert result.status == "green"
    assert not runner.has_command_with("comment")


# ---------------------------------------------------------------------------
# QA absent (flag was OFF / non-UI never recorded) → publish runs, no comment
# ---------------------------------------------------------------------------


def test_qa_absent_publishes_without_comment(tmp_path) -> None:
    run_dir = tmp_path / "run-1"
    payload = {"objectiveGate": {"verdict": "green"}}  # no qa block at all
    runner = FakeRunner([
        _Completed(0, stdout="cloned"),
        _do_run_writing(run_dir, payload),
        _Completed(0, stdout="main"),
        _Completed(0),
        _Completed(0),
        _Completed(0),
        _Completed(0),
        _Completed(0, stdout="https://github.com/acme/widgets/pull/42"),
    ])
    result, _ = _run_on_host(tmp_path, runner)

    assert result.status == "green"
    assert not runner.has_command_with("comment")
