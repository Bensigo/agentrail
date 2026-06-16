"""Docker-per-run sandbox executor (MVP).

Today AgentRail runs a dispatched issue via worktree + subprocess — no isolation.
This module is the seam a dispatcher consumes to run each issue in a fresh,
disposable container instead:

    result = run_issue_in_sandbox(
        repo_url="https://github.com/acme/widgets.git",
        ref="main",
        issue_ref="7",
        workspace_id="ws-123",
        env={"AGENT_API_KEY": "...", "GIT_TOKEN": "..."},
    )
    # result: RunResult(status, cost_usd, branch, gate_reason, logs_tail)

The container is launched from the runner image (see ``docker/runner/Dockerfile``),
which clones ``repo_url`` at ``ref``, runs ``agentrail run issue <issue_ref>``
(the spine — ``agentrail/run/pipeline.py:run_issue``), and prints a sentinel-fenced
result JSON to stdout. We parse that into a :class:`RunResult`, then ALWAYS remove
the container — even on error or timeout. Agent API key + git token are passed in
``env`` and forwarded to the container by NAME (``docker run -e KEY``), so secret
VALUES never appear on the process command line.

Docker is driven purely via ``subprocess`` (no new deps). All daemon interaction
goes through a single injectable ``run_container`` callable so unit tests can fake
it; the default is :func:`subprocess_run_container`.
"""
from __future__ import annotations

import json
import subprocess
import uuid
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence

# Sentinel fence the container's entrypoint prints around the result JSON. Using
# an explicit fence (rather than "last line") keeps parsing robust even when the
# agentrail run emits trailing log lines after the result is computed.
RESULT_BEGIN = "===AGENTRAIL_RESULT_BEGIN==="
RESULT_END = "===AGENTRAIL_RESULT_END==="

# Default disposable-run resource envelope. Conservative so a runaway agent can
# never starve the host; the dispatcher can override per-run.
DEFAULT_CPUS = "2"
DEFAULT_MEMORY = "4g"
DEFAULT_TIMEOUT = 3600  # seconds — hard ceiling on the whole sandboxed run.
DEFAULT_IMAGE = "agentrail/runner:latest"

_LOGS_TAIL_LINES = 40


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------

@dataclass
class RunResult:
    """Outcome of a sandboxed run — the shape the dispatcher consumes.

    status     : 'green' (gate passed) | 'red' (gate failed) | 'error'
                 (the sandbox itself failed: timeout, daemon error, or an
                 unparseable result — i.e. we never got a trustworthy verdict).
    cost_usd   : real-dollar cost of the run as reported by the pipeline.
    branch     : the branch the run produced (may be '' on error).
    gate_reason: human-readable reason for a red/error outcome ('' when green).
    logs_tail  : last lines of the container output, for triage.
    """

    status: str
    cost_usd: float = 0.0
    branch: str = ""
    gate_reason: str = ""
    logs_tail: str = ""


@dataclass
class ContainerResult:
    """What a container invocation returned. The fakeable boundary's value type."""

    exit_code: int
    stdout: str = ""
    stderr: str = ""


class DockerError(RuntimeError):
    """A container command failed to run (daemon unreachable, build/run error)."""


class DockerTimeout(DockerError):
    """A container command exceeded its timeout."""


# The injectable seam: run a docker command and return a ContainerResult.
RunContainer = Callable[..., ContainerResult]


# ---------------------------------------------------------------------------
# Default runner (real subprocess → docker)
# ---------------------------------------------------------------------------

def subprocess_run_container(
    cmd: Sequence[str],
    *,
    env: Optional[Dict[str, str]] = None,
    timeout: Optional[int] = None,
) -> ContainerResult:
    """Run a docker command via subprocess.

    ``env`` supplies the values for any ``-e KEY`` forwarded to the container
    (Docker reads them from this process's environment). Raises
    :class:`DockerTimeout` on timeout and :class:`DockerError` if the docker
    binary cannot be executed at all; a non-zero exit from docker itself is
    returned as a ``ContainerResult`` so callers can inspect output.
    """
    import os

    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    try:
        proc = subprocess.run(
            list(cmd),
            capture_output=True,
            text=True,
            timeout=timeout,
            env=full_env,
        )
    except subprocess.TimeoutExpired as exc:  # pragma: no cover - real-daemon path
        raise DockerTimeout(f"container exceeded {timeout}s") from exc
    except (OSError, ValueError) as exc:  # pragma: no cover - real-daemon path
        raise DockerError(str(exc)) from exc
    return ContainerResult(exit_code=proc.returncode, stdout=proc.stdout or "", stderr=proc.stderr or "")


# ---------------------------------------------------------------------------
# Command building (pure — easy to assert in tests)
# ---------------------------------------------------------------------------

def _container_name(workspace_id: str, issue_ref: str) -> str:
    # Unique per invocation so concurrent runs never collide and teardown is
    # deterministic. Kept DNS/Docker-name safe.
    safe_ws = "".join(c if c.isalnum() else "-" for c in workspace_id)[:32] or "ws"
    short = uuid.uuid4().hex[:8]
    return f"agentrail-run-{safe_ws}-{issue_ref}-{short}"


def build_run_command(
    *,
    name: str,
    image: str,
    repo_url: str,
    ref: str,
    issue_ref: str,
    env_keys: Sequence[str],
    cpus: str,
    memory: str,
) -> List[str]:
    """Build the ``docker run`` argv.

    Secrets are forwarded by NAME (``-e KEY``) so their values never land on the
    command line. The repo/ref/issue are passed as explicit positional args to
    the image entrypoint, which clones and drives the agentrail run.
    """
    cmd: List[str] = [
        "docker", "run",
        "--name", name,
        "--rm=false",            # we remove explicitly so teardown is observable
        "--cpus", str(cpus),
        "--memory", str(memory),
        "--pids-limit", "512",   # cheap fork-bomb guard for a disposable run
    ]
    for key in env_keys:
        cmd += ["-e", key]
    cmd += [image, repo_url, ref, str(issue_ref)]
    return cmd


def build_rm_command(name: str) -> List[str]:
    return ["docker", "rm", "-f", name]


# ---------------------------------------------------------------------------
# Result parsing
# ---------------------------------------------------------------------------

def _logs_tail(stdout: str, stderr: str) -> str:
    body = stdout if stdout.strip() else stderr
    lines = body.splitlines()
    return "\n".join(lines[-_LOGS_TAIL_LINES:]).strip()


def parse_result(stdout: str, stderr: str) -> Optional[dict]:
    """Extract the sentinel-fenced result JSON from container output, or None."""
    begin = stdout.rfind(RESULT_BEGIN)
    if begin == -1:
        return None
    end = stdout.find(RESULT_END, begin)
    if end == -1:
        return None
    blob = stdout[begin + len(RESULT_BEGIN):end].strip()
    try:
        data = json.loads(blob)
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def _result_from_payload(payload: dict, logs_tail: str) -> RunResult:
    status = payload.get("status")
    if status not in ("green", "red", "error"):
        status = "error"
    try:
        cost = float(payload.get("cost_usd") or 0.0)
    except (TypeError, ValueError):
        cost = 0.0
    return RunResult(
        status=status,
        cost_usd=cost,
        branch=str(payload.get("branch") or ""),
        gate_reason=str(payload.get("gate_reason") or ""),
        logs_tail=logs_tail,
    )


# ---------------------------------------------------------------------------
# The seam
# ---------------------------------------------------------------------------

def run_issue_in_sandbox(
    *,
    repo_url: str,
    ref: str,
    issue_ref: str,
    workspace_id: str,
    env: Dict[str, str],
    image: str = DEFAULT_IMAGE,
    cpus: str = DEFAULT_CPUS,
    memory: str = DEFAULT_MEMORY,
    timeout: int = DEFAULT_TIMEOUT,
    run_container: RunContainer = subprocess_run_container,
) -> RunResult:
    """Run a single issue in a fresh, disposable Docker container.

    Launches a container from ``image`` that clones ``repo_url`` at ``ref``, runs
    ``agentrail run issue <issue_ref>`` inside, prints a sentinel-fenced result
    JSON, and exits. We parse that into a :class:`RunResult`, then ALWAYS remove
    the container — including on timeout or daemon error (AC1, AC2).

    Resource limits (``cpus``, ``memory``) and a hard ``timeout`` are applied to
    the run. Agent API key + git token are passed via ``env`` and forwarded into
    the container by name; their values never appear on the command line.

    Returns ``status='error'`` (with a populated ``gate_reason``/``logs_tail``)
    for any sandbox-level failure — timeout, daemon error, or unparseable output
    — i.e. whenever we could not obtain a trustworthy gate verdict.
    """
    name = _container_name(workspace_id, issue_ref)
    env = dict(env or {})
    run_cmd = build_run_command(
        name=name,
        image=image,
        repo_url=repo_url,
        ref=ref,
        issue_ref=issue_ref,
        env_keys=sorted(env.keys()),
        cpus=cpus,
        memory=memory,
    )

    result: RunResult
    try:
        container = run_container(run_cmd, env=env, timeout=timeout)
        payload = parse_result(container.stdout, container.stderr)
        logs_tail = _logs_tail(container.stdout, container.stderr)
        if payload is None:
            result = RunResult(
                status="error",
                gate_reason="could not parse run result from container output",
                logs_tail=logs_tail or "(no output)",
            )
        else:
            result = _result_from_payload(payload, logs_tail)
    except DockerTimeout as exc:
        result = RunResult(
            status="error",
            gate_reason=f"sandbox timeout after {timeout}s: {exc}",
            logs_tail="",
        )
    except DockerError as exc:
        result = RunResult(
            status="error",
            gate_reason=f"sandbox error: {exc}",
            logs_tail="",
        )
    finally:
        # Teardown is unconditional and must never mask the run's outcome: a
        # failure to remove the container is swallowed (a disposable container
        # left behind is an ops nuisance, not a wrong verdict).
        try:
            run_container(build_rm_command(name), env=None, timeout=60)
        except DockerError:
            pass

    return result
