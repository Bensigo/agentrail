"""Host-native sandbox runner (provider sandbox).

The Docker runner (:mod:`agentrail.sandbox.docker_runner`) executes a dispatched
issue inside a Linux container. That is correct for the API-key / cloud path, but
on a developer machine logged in with a Claude **subscription**, the container's
``claude`` is unauthenticated: the OAuth token lives in the macOS Keychain, which
a Linux container cannot read.

This module runs the spine on the HOST instead. The agent CLI (``claude`` /
``codex``) uses its existing host login and its OWN native sandbox — codex
sandboxes by default; claude has its bash sandbox. We mirror the in-container
sequence (clone ``repo_url`` at ``ref`` → ``agentrail run issue <issue_ref>`` →
read ``run.json``) on the host, in a fresh disposable temp working dir that is
ALWAYS removed afterwards — even on error or timeout.

The result shape is the SAME :class:`agentrail.sandbox.docker_runner.RunResult`,
and :func:`run_issue_on_host` is a callable with the SAME keyword signature the
heartbeat runtime expects, so it is a drop-in alternative to
``run_issue_in_sandbox``. :func:`select_sandbox_runner` picks between the two.

Like the Docker runner, all shell interaction goes through a single injectable
``runner`` (default :mod:`subprocess`) so unit tests are hermetic — no real
clone, agent, or network.

Optional whole-process isolation: when ``AGENTRAIL_SANDBOX_RUNTIME=1`` is set in
``env``, the run command is wrapped with ``npx @anthropic-ai/sandbox-runtime``
(Anthropic's Seatbelt/bubblewrap wrapper). It is OFF by default so the host path
works out of the box.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Callable, Dict, List, Optional

from agentrail.sandbox.docker_runner import (
    ENV_FAILURE_HANDOFF,
    RunResult,
)

DEFAULT_TIMEOUT = 3600  # seconds — hard ceiling on the whole host run.
DEFAULT_AGENT = "claude"  # host login + claude's native bash sandbox.
ENV_AGENT = "AGENTRAIL_AGENT"
ENV_SANDBOX_RUNTIME = "AGENTRAIL_SANDBOX_RUNTIME"
SANDBOX_RUNTIME_PKG = "@anthropic-ai/sandbox-runtime"

# The run id + log dir we drive ``agentrail run issue`` to write under, so the
# verdict/cost artifacts land at a known path inside the isolated working dir.
RUN_ID = "host-run"
_LOG_SUBDIR = ".agentrail-runs"
_LOGS_TAIL_LINES = 40


class HostError(RuntimeError):
    """A host shell command could not be run (binary missing, OS error)."""


class HostTimeout(HostError):
    """A host shell command exceeded its timeout."""


# The injectable seam: a thing with a ``.run(cmd, *, cwd, env, timeout)`` method
# returning an object with ``returncode``/``stdout``/``stderr`` (subprocess-like).
Runner = object


# ---------------------------------------------------------------------------
# Result parsing — mirrors docker/runner/entrypoint.sh's run.json reader so the
# host path and the container path produce identical verdicts.
# ---------------------------------------------------------------------------

def _result_from_run_json(
    run_dir: Path, *, run_status: int, repo_dir: Path, logs_tail: str, runner
) -> RunResult:
    """Parse ``run_dir/run.json`` → RunResult, mirroring the container parser.

    Verdict comes from ``objectiveGate.verdict``; on a missing gate we fall back
    to the process exit status. Cost is the sum of the per-phase cost ledger
    (``.agentrail/run/cost-events.jsonl``). The branch is the repo's current HEAD.
    A missing/unreadable ``run.json`` is an ``error`` (no trustworthy verdict).
    """
    status = "error"
    cost = 0.0
    branch = ""
    reason = ""

    run_json = run_dir / "run.json"
    try:
        data = json.loads(run_json.read_text())
        gate = data.get("objectiveGate") or {}
        verdict = gate.get("verdict")
        if verdict == "green":
            status = "green"
        elif verdict == "red":
            status = "red"
            reasons = gate.get("failedReasons") or []
            reason = "; ".join(str(r) for r in reasons)
        else:
            # No gate recorded: fall back to the process exit status.
            status = "green" if run_status == 0 else "red"
            if status == "red":
                reason = f"agentrail run exited {run_status}"
    except FileNotFoundError:
        status = "error"
        reason = "run.json not found; agentrail run did not complete"
    except (ValueError, OSError) as exc:
        status = "error"
        reason = f"could not read run result: {exc}"

    # Cost: sum the per-phase cost ledger written by the pipeline.
    ledger = repo_dir / ".agentrail" / "run" / "cost-events.jsonl"
    try:
        for line in ledger.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                cost += float(json.loads(line).get("cost_usd") or 0.0)
            except (ValueError, TypeError):
                pass
    except (FileNotFoundError, OSError):
        pass

    # Current branch the run produced (best-effort; never fatal).
    try:
        proc = runner.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=str(repo_dir), env=None, timeout=30,
        )
        branch = (getattr(proc, "stdout", "") or "").strip()
    except Exception:  # pragma: no cover - branch is best-effort
        pass

    return RunResult(
        status=status, cost_usd=cost, branch=branch,
        gate_reason=reason, logs_tail=logs_tail,
    )


def _logs_tail(stdout: str, stderr: str) -> str:
    body = stdout if (stdout or "").strip() else (stderr or "")
    lines = body.splitlines()
    return "\n".join(lines[-_LOGS_TAIL_LINES:]).strip()


# ---------------------------------------------------------------------------
# Command building
# ---------------------------------------------------------------------------

def _clone_command(repo_url: str, ref: str, dest: str) -> List[str]:
    # --branch checks out ref directly when it is a branch/tag; a bare commit ref
    # is handled by the run pipeline (the host clone keeps shallow history).
    return ["git", "clone", "--depth", "50", "--branch", ref, repo_url, dest]


def _build_run_command(
    *, issue_ref: str, agent: str, model: Optional[str], log_dir: str,
    sandbox_runtime: bool, run_id: str,
) -> List[str]:
    cmd: List[str] = [
        "agentrail", "run", "issue", str(issue_ref),
        "--agent", agent,
        "--run-id", run_id,
        "--log-dir", log_dir,
    ]
    if model:
        cmd += ["--model", model]
    if sandbox_runtime:
        # Wrap the whole run in Anthropic's Seatbelt/bubblewrap sandbox.
        cmd = ["npx", SANDBOX_RUNTIME_PKG, "--"] + cmd
    return cmd


# ---------------------------------------------------------------------------
# The seam
# ---------------------------------------------------------------------------

def run_issue_on_host(
    *,
    repo_url: str,
    ref: str,
    issue_ref: str,
    workspace_id: str,
    env: Dict[str, str],
    model: Optional[str] = None,
    failure_handoff: Optional[str] = None,
    timeout: int = DEFAULT_TIMEOUT,
    run_id: str = RUN_ID,
    pr_title: Optional[str] = None,
    publish_pr: bool = True,
    run_dir_factory: Optional[Callable[[], Path]] = None,
    runner=subprocess,
) -> RunResult:
    """Run a single issue on the HOST (provider sandbox), not in Docker.

    Clones ``repo_url`` at ``ref`` into a fresh, isolated temp working dir, runs
    ``agentrail run issue <issue_ref> --agent <agent> [--model M]`` there (the
    agent CLI uses the host login + its own native sandbox), parses the run's
    ``run.json`` into a :class:`RunResult`, then ALWAYS removes the temp dir —
    even on error or timeout (AC1, AC2).

    ``env`` is forwarded to the run; ``AGENTRAIL_FAILURE_HANDOFF`` is set from
    ``failure_handoff`` (a possibly large/multiline compacted handoff, kept off
    the argv), and any link env (``AGENTRAIL_SERVER_*``) already in ``env`` is
    passed through so the run ingests. The agent defaults to ``claude`` unless
    ``AGENTRAIL_AGENT`` is set in ``env``.

    When ``AGENTRAIL_SANDBOX_RUNTIME=1`` is in ``env``, the run command is wrapped
    with ``npx @anthropic-ai/sandbox-runtime`` for whole-process isolation
    (default OFF).

    Returns ``status='error'`` for any host-level failure — clone failure,
    timeout, missing ``run.json`` — i.e. whenever no trustworthy gate verdict was
    obtained. ``runner`` is injected (default :mod:`subprocess`) so tests never
    clone or run a real agent.
    """
    env = dict(env or {})
    agent = env.get(ENV_AGENT) or DEFAULT_AGENT
    sandbox_runtime = env.get(ENV_SANDBOX_RUNTIME) == "1"

    # Child-process env: inherit our environment, layer the caller's env, and set
    # the compacted handoff (the execute phase reads it from this var).
    child_env = dict(os.environ)
    child_env.update(env)
    if failure_handoff is not None:
        child_env[ENV_FAILURE_HANDOFF] = failure_handoff

    # Fresh isolated working dir per run (injectable for hermetic tests).
    if run_dir_factory is not None:
        work_dir = Path(run_dir_factory())
        _own_work_dir = True
    else:
        work_dir = Path(tempfile.mkdtemp(prefix="agentrail-host-run-"))
        _own_work_dir = True

    repo_dir = work_dir / "repo"
    log_dir = work_dir / _LOG_SUBDIR

    try:
        # 1. Clone at ref.
        try:
            clone = runner.run(
                _clone_command(repo_url, ref, str(repo_dir)),
                cwd=str(work_dir), env=child_env, timeout=timeout,
            )
        except HostTimeout as exc:
            return RunResult(status="error",
                             gate_reason=f"clone timeout after {timeout}s: {exc}")
        except (HostError, OSError, ValueError) as exc:
            return RunResult(status="error", gate_reason=f"clone error: {exc}")
        if getattr(clone, "returncode", 0) != 0:
            tail = _logs_tail(getattr(clone, "stdout", ""), getattr(clone, "stderr", ""))
            return RunResult(status="error",
                             gate_reason="git clone failed",
                             logs_tail=tail or "(no output)")

        # 2. Run the spine on the host.
        run_cmd = _build_run_command(
            issue_ref=issue_ref, agent=agent, model=model,
            log_dir=str(log_dir), sandbox_runtime=sandbox_runtime,
            run_id=run_id,
        )
        try:
            proc = runner.run(
                run_cmd, cwd=str(repo_dir), env=child_env, timeout=timeout,
            )
        except HostTimeout as exc:
            return RunResult(status="error",
                             gate_reason=f"host run timeout after {timeout}s: {exc}")
        except subprocess.TimeoutExpired as exc:  # pragma: no cover - real path
            return RunResult(status="error",
                             gate_reason=f"host run timeout after {timeout}s: {exc}")
        except (HostError, OSError, ValueError) as exc:
            return RunResult(status="error", gate_reason=f"host run error: {exc}")

        # 3. Parse run.json → RunResult (mirrors the container parser).
        logs_tail = _logs_tail(getattr(proc, "stdout", ""), getattr(proc, "stderr", ""))
        result = _result_from_run_json(
            log_dir / run_id,
            run_status=getattr(proc, "returncode", 1),
            repo_dir=repo_dir,
            logs_tail=logs_tail,
            runner=runner,
        )
        # 4. Publish on GREEN — commit the agent's (uncommitted) work to a feature
        # branch, push it, and open a PR, BEFORE the clone is torn down. Without
        # this the gate goes green but the work vanishes with the temp dir (no
        # PR). Best-effort: a publish failure downgrades to a gate_reason, never
        # crashes the run.
        if result.status == "green" and publish_pr:
            branch, pr_url = _publish_green(
                runner, repo_dir, issue_ref, pr_title, base_ref=ref, env=child_env
            )
            from dataclasses import replace

            result = replace(result, pr_url=pr_url, branch=branch or result.branch)
        return result
    finally:
        # Teardown is unconditional; a failure to clean up is swallowed (a leftover
        # temp dir is an ops nuisance, not a wrong verdict).
        if _own_work_dir:
            shutil.rmtree(work_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Publish-on-green (push branch + open PR)
# ---------------------------------------------------------------------------

# A neutral commit identity for the runner's commit (the agent leaves changes
# uncommitted so the objective gate can see them via `git status`).
_GIT_IDENTITY = [
    "-c", "user.email=runner@agentrail.dev",
    "-c", "user.name=AgentRail Runner",
]


def _publish_green(
    runner, repo_dir: Path, issue_ref: str, pr_title: Optional[str],
    *, base_ref: str, env: Dict[str, str],
) -> tuple[str, str]:
    """Commit the agent's work to a feature branch, push it, open a PR.

    Returns ``(branch, pr_url)``; either may be ``""`` on failure. Best-effort:
    every step is guarded so a publish failure never raises into the run. Uses
    the host's git/gh auth (the same that the agent's own pushes use). The branch
    matches the dashboard run's ``afk/github-<n>`` convention is NOT used here —
    we use ``agentrail/issue-<n>`` so the PR branch is self-describing.
    """
    number = re.search(r"(\d+)\s*$", str(issue_ref))
    n = number.group(1) if number else str(issue_ref)
    branch = f"agentrail/issue-{n}"
    title = pr_title or f"agentrail: resolve #{n}"

    def _run(cmd: list) -> Optional[object]:
        try:
            return runner.run(cmd, cwd=str(repo_dir), env=env, timeout=120)
        except Exception:  # noqa: BLE001 — publish is best-effort
            return None

    # Move the uncommitted work onto a fresh feature branch and commit it.
    if _run(["git", *_GIT_IDENTITY, "checkout", "-B", branch]) is None:
        return "", ""
    _run(["git", "add", "-A"])
    commit = _run(["git", *_GIT_IDENTITY, "commit", "-m", f"{title} (#{n})"])
    if commit is None or getattr(commit, "returncode", 1) != 0:
        return branch, ""  # nothing to commit / commit failed

    push = _run(["git", "push", "--force", "-u", "origin", f"HEAD:{branch}"])
    if push is None or getattr(push, "returncode", 1) != 0:
        return branch, ""

    pr = _run([
        "gh", "pr", "create",
        "--head", branch, "--base", base_ref,
        "--title", title,
        "--body", f"Resolves #{n}\n\nOpened by the AgentRail runner after a green objective gate.",
    ])
    if pr is None or getattr(pr, "returncode", 1) != 0:
        # Branch is pushed; a PR may already exist — try to surface its URL.
        view = _run(["gh", "pr", "view", branch, "--json", "url", "-q", ".url"])
        url = (getattr(view, "stdout", "") or "").strip() if view else ""
        return branch, url
    url = (getattr(pr, "stdout", "") or "").strip().splitlines()[-1:] or [""]
    return branch, url[0]


# ---------------------------------------------------------------------------
# Backend selector (AC3)
# ---------------------------------------------------------------------------

def select_sandbox_runner(env: Dict[str, str]) -> Callable[..., RunResult]:
    """Choose the sandbox backend from ``env``.

    Host-native by default (local dev: the agent CLI uses the host login + its
    own native sandbox). Docker when ``ANTHROPIC_API_KEY`` is set (CI / cloud:
    API-key auth works fine inside a container).
    """
    from agentrail.sandbox.docker_runner import run_issue_in_sandbox

    if (env.get("ANTHROPIC_API_KEY") or "").strip():
        return run_issue_in_sandbox
    return run_issue_on_host
