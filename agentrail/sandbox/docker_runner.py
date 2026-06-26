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
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path
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

# Env var names the escalation loop forwards into the container. ``AGENTRAIL_MODEL``
# selects the model the in-container ``agentrail run issue`` runs on (cheap on the
# first attempt, strong on an escalation); ``AGENTRAIL_FAILURE_HANDOFF`` carries the
# compacted failure handoff (goal + attempt diff + gate error) the execute phase
# injects as extra context. Both are forwarded by NAME (``docker run -e KEY``) so a
# large/multiline handoff never lands on the process command line.
ENV_MODEL = "AGENTRAIL_MODEL"
ENV_FAILURE_HANDOFF = "AGENTRAIL_FAILURE_HANDOFF"

# Where the pipeline writes its incremental per-phase cost ledger, relative to
# the repo it runs in. The host learns the run's cost AFTER the subprocess exits
# by summing this file (each line carries a ``cost_usd``). On a sandbox-level
# FAILURE we must recover the partial ledger too, or the money already spent is
# reported as $0. Inside the container the repo is cloned at ``/workspace/repo``
# (see ``docker/runner/entrypoint.sh``), so the ledger lives at the path below.
_LEDGER_RELPATH = ".agentrail/run/cost-events.jsonl"
_CONTAINER_LEDGER_PATH = "/workspace/repo/" + _LEDGER_RELPATH


# ---------------------------------------------------------------------------
# Cost recovery — sum a (possibly partial) per-phase cost ledger
# ---------------------------------------------------------------------------

def sum_cost_ledger(ledger_path) -> float:
    """Sum ``cost_usd`` across the lines of a ``cost-events.jsonl`` ledger.

    Best-effort and TOTALLY non-raising: this runs on the FAILURE path and must
    never mask the original error. A missing file, a truncated/partial last
    line, or a malformed JSON line is tolerated — bad lines are skipped, and any
    unexpected error falls back to ``0.0``. Each ledger line is one phase's JSON
    object carrying a ``cost_usd`` field.
    """
    total = 0.0
    try:
        text = Path(ledger_path).read_text()
    except (FileNotFoundError, OSError, ValueError):
        return 0.0
    try:
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                total += float(json.loads(line).get("cost_usd") or 0.0)
            except (ValueError, TypeError, AttributeError):
                # Truncated final line, non-dict JSON, or missing field — skip.
                pass
    except Exception:  # noqa: BLE001 - recovery must never raise on the failure path
        return total
    return total


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
    pr_url     : the pull request opened for a green run ('' when none/not green).
    """

    status: str
    cost_usd: float = 0.0
    branch: str = ""
    gate_reason: str = ""
    logs_tail: str = ""
    pr_url: str = ""


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


def build_cp_command(name: str, src: str, dest: str) -> List[str]:
    """Build a ``docker cp`` argv to copy a path out of a (stopped) container.

    Used on the FAILURE path to extract the partial cost ledger from the
    container before the unconditional ``docker rm`` teardown destroys it.
    Because the container is created with ``--rm=false`` and a fixed name, it
    still exists (stopped) when a run fails, so ``docker cp`` can reach inside.
    """
    return ["docker", "cp", f"{name}:{src}", dest]


def _recover_cost_from_container(
    name: str,
    run_container: RunContainer,
) -> float:
    """Best-effort: copy the partial cost ledger out of ``name`` and sum it.

    Runs on the FAILURE path (timeout, daemon error, unparseable output) BEFORE
    teardown, so spend already incurred isn't reported as $0. Any problem —
    ``docker cp`` failing because the ledger was never written, a daemon error,
    a teardown race — falls back to ``0.0`` and is swallowed: cost recovery must
    never raise or mask the original run failure.
    """
    try:
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "cost-events.jsonl"
            res = run_container(
                build_cp_command(name, _CONTAINER_LEDGER_PATH, str(dest)),
                env=None,
                timeout=60,
            )
            if getattr(res, "exit_code", 1) != 0:
                return 0.0
            return sum_cost_ledger(dest)
    except Exception:  # noqa: BLE001 - recovery must never raise on the failure path
        return 0.0


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
    model: Optional[str] = None,
    failure_handoff: Optional[str] = None,
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

    ``model`` selects which model the in-container run executes on (the escalation
    loop passes the cheap model first, the strong model on a retry);
    ``failure_handoff`` is the compacted handoff (goal + attempt diff + gate error)
    the execute phase injects as extra context on a re-attempt. Both are forwarded
    into the container by NAME (``-e AGENTRAIL_MODEL`` / ``-e AGENTRAIL_FAILURE_HANDOFF``)
    so a large/multiline handoff never appears on the command line. When ``None``
    they are not forwarded at all (a first cheap attempt with the image default).

    Returns ``status='error'`` (with a populated ``gate_reason``/``logs_tail``)
    for any sandbox-level failure — timeout, daemon error, or unparseable output
    — i.e. whenever we could not obtain a trustworthy gate verdict.
    """
    name = _container_name(workspace_id, issue_ref)
    env = dict(env or {})
    # Forward the model + compacted handoff into the container by NAME, alongside
    # the caller's secrets. Only set when present so an unescalated first attempt
    # runs on the image's default model with no handoff.
    if model is not None:
        env[ENV_MODEL] = model
    if failure_handoff is not None:
        env[ENV_FAILURE_HANDOFF] = failure_handoff
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
            # Output was unparseable, so we never saw a cost field. The run may
            # still have spent money before it crashed — recover the partial
            # ledger from the container before teardown destroys it.
            result = RunResult(
                status="error",
                cost_usd=_recover_cost_from_container(name, run_container),
                gate_reason="could not parse run result from container output",
                logs_tail=logs_tail or "(no output)",
            )
        else:
            result = _result_from_payload(payload, logs_tail)
    except DockerTimeout as exc:
        result = RunResult(
            status="error",
            cost_usd=_recover_cost_from_container(name, run_container),
            gate_reason=f"sandbox timeout after {timeout}s: {exc}",
            logs_tail="",
        )
    except DockerError as exc:
        result = RunResult(
            status="error",
            cost_usd=_recover_cost_from_container(name, run_container),
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
