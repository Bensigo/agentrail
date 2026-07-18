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
import sys
import tempfile
from pathlib import Path
from typing import Callable, Dict, List, Optional

from agentrail.sandbox.docker_runner import (
    ENV_FAILURE_HANDOFF,
    RunResult,
    sum_cost_ledger,
)

DEFAULT_TIMEOUT = 3600  # seconds — hard ceiling on the whole host run.
DEFAULT_AGENT = "claude"  # host login + claude's native bash sandbox.
ENV_AGENT = "AGENTRAIL_AGENT"
ENV_SANDBOX_RUNTIME = "AGENTRAIL_SANDBOX_RUNTIME"
# Hosted default config injection (#1267 PR②) — see _inject_hosted_config below.
ENV_HOSTED = "AGENTRAIL_HOSTED"  # same marker agentrail.run.pipeline.is_hosted_run() checks.
ENV_HOSTED_CONFIG = "AGENTRAIL_HOSTED_CONFIG"  # path to the baked default-config template.
SANDBOX_RUNTIME_PKG = "@anthropic-ai/sandbox-runtime"

# Deliberate sandbox-mode selection (#1267 PR④ item 1) — see
# select_sandbox_runner below for the full selection contract.
ENV_SANDBOX_MODE = "AGENTRAIL_SANDBOX"
SANDBOX_MODE_HOST = "host"
SANDBOX_MODE_DOCKER = "docker"

# #1267 PR③: the deterministic prefix a hosted-refusal ``gate_reason`` always
# starts with. This is the cross-process CONTRACT the TS queue-transition side
# keys on (packages/db-postgres/src/queries/runner.ts defines the byte-identical
# ``HOSTED_REFUSAL_PREFIX`` constant) to route a refusal straight to a human —
# spending NO retry budget and bumping NO tier — instead of retrying it like an
# ordinary gate failure. Keep the two constants in lockstep if you ever change
# one; a mismatch silently turns every refusal back into a normal retry.
HOSTED_REFUSAL_PREFIX = "hosted-refusal: "

# The run id + log dir we drive ``agentrail run issue`` to write under, so the
# verdict/cost artifacts land at a known path inside the isolated working dir.
RUN_ID = "host-run"
_LOG_SUBDIR = ".agentrail-runs"
_LOGS_TAIL_LINES = 40


def _ledger_path(repo_dir: Path) -> Path:
    """Path to the per-phase cost ledger inside a cloned repo dir."""
    return repo_dir / ".agentrail" / "run" / "cost-events.jsonl"


class HostError(RuntimeError):
    """A host shell command could not be run (binary missing, OS error)."""


class HostTimeout(HostError):
    """A host shell command exceeded its timeout."""


# The injectable seam: a thing with a ``.run(cmd, *, cwd, env, timeout)`` method
# returning an object with ``returncode``/``stdout``/``stderr`` (subprocess-like).
Runner = object


# ---------------------------------------------------------------------------
# Result parsing — mirrors agentrail/docker/runner/entrypoint.sh's run.json reader so the
# host path and the container path produce identical verdicts.
# ---------------------------------------------------------------------------

def _result_from_run_json(
    run_dir: Path, *, run_status: int, repo_dir: Path, logs_tail: str, runner
) -> RunResult:
    """Parse ``run_dir/run.json`` → RunResult, mirroring the container parser.

    A top-level ``refusal`` marker (#1267 PR③ — written by pipeline.py's hosted
    startup assert, before any phase runs) takes precedence over everything
    else: it always yields ``status="error"`` with ``gate_reason`` prefixed by
    :data:`HOSTED_REFUSAL_PREFIX`, so the queue transition can route it straight
    to a human instead of retrying it like an ordinary gate failure.

    Otherwise verdict comes from ``objectiveGate.verdict``; on a missing gate we
    fall back to the process exit status. Cost is the sum of the per-phase cost
    ledger (``.agentrail/run/cost-events.jsonl``). The branch is the repo's
    current HEAD. A missing/unreadable ``run.json`` is an ``error`` (no
    trustworthy verdict).
    """
    status = "error"
    cost = 0.0
    branch = ""
    reason = ""

    run_json = run_dir / "run.json"
    try:
        data = json.loads(run_json.read_text())
        refusal = data.get("refusal")
        if isinstance(refusal, dict):
            # #1267 PR③: a hosted startup refusal (e.g. no Independent Reviewer
            # configured, #1270) writes this marker BEFORE finalize_objective_gate
            # ever runs — its run.json therefore has no "objectiveGate" key,
            # which the fallback below would otherwise read as "agentrail run
            # exited 1" and treat exactly like a real gate failure (retried up
            # to the full budget, escalating tiers that can never fix a static
            # config gap). Recognize the marker FIRST so a refusal is always
            # "error" with a deterministically-prefixed reason, never "red"
            # (red means "worth retrying/escalating tier"; this never is).
            status = "error"
            message = str(refusal.get("message") or "hosted run refused at startup")
            reason = f"{HOSTED_REFUSAL_PREFIX}{message}"
        else:
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

    # Cost: sum the per-phase cost ledger written by the pipeline (best-effort).
    cost += sum_cost_ledger(_ledger_path(repo_dir))

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

# A full 40-hex (or shortened ≥7-hex) git object name. ``git clone --branch``
# only accepts a branch/tag NAME, never a bare commit SHA, so for a SHA ref we
# clone the default branch then check the commit out explicitly (see
# ``_checkout_command``). The eval harness (#966) pins tasks at bare commit SHAs.
_SHA_RE = re.compile(r"^[0-9a-fA-F]{7,40}$")


def _ref_is_commit_sha(ref: str) -> bool:
    """True when ``ref`` looks like a bare commit SHA (not a branch/tag name)."""
    return bool(_SHA_RE.match(ref))


def _authenticated_clone_url(repo_url: str, token: str) -> str:
    """Embed ``token`` as HTTP Basic auth (``x-access-token``) in an ``https://``
    clone URL, so ``git clone`` (and, since the cloned ``origin`` remote then
    carries it, every later ``git push``) authenticates as the workspace's
    connected GitHub OAuth token / a locally configured PAT — the SAME
    substitution the Docker sandbox's entrypoint already does
    (``agentrail/docker/runner/entrypoint.sh``), so both sandbox paths
    authenticate identically.

    A no-op when there is no token, or the URL isn't ``https://`` (SSH remotes
    are unaffected — git's credential subsystem is HTTP(S)-only, so an SSH clone
    keeps relying on the host's own SSH keys exactly as before this fix).
    """
    if not token or not repo_url.startswith("https://"):
        return repo_url
    return repo_url.replace("https://", f"https://x-access-token:{token}@", 1)


def _redact_token(text: str, token: str) -> str:
    """Strip a raw secret out of captured process output before it can leave this
    host as ``logs_tail``/``gate_reason`` (``report_result``/``report_telemetry``
    upload both to the backend). Defense in depth: git/gh diagnostics don't
    always redact credentials embedded in a URL on their own, and this makes it
    impossible for the token to survive into anything this runner reports back.
    """
    if not token:
        return text
    return text.replace(token, "***")


def _clone_command(repo_url: str, ref: str, dest: str) -> List[str]:
    # ``--branch`` checks out ref directly when it is a branch/tag NAME. A bare
    # commit SHA is NOT a valid ``--branch`` argument (``fatal: Remote branch
    # <sha> not found``), so for a SHA we clone without ``--branch`` and let
    # ``_checkout_command`` detach onto the commit afterwards. (#966)
    if _ref_is_commit_sha(ref):
        return ["git", "clone", "--depth", "50", repo_url, dest]
    return ["git", "clone", "--depth", "50", "--branch", ref, repo_url, dest]


def _checkout_command(ref: str) -> List[str]:
    """Detached checkout of a bare commit SHA after a branchless clone (#966)."""
    return ["git", "checkout", "--quiet", ref]


def _build_run_command(
    *, issue_ref: str, agent: str, model: Optional[str], log_dir: str,
    sandbox_runtime: bool, run_id: str, prompt: Optional[str] = None,
    agentrail_cmd: Optional[List[str]] = None, target: Optional[str] = None,
) -> List[str]:
    """Build the ``agentrail run`` command driven on the host.

    Default (``prompt`` is ``None``): drive ``agentrail run issue <issue_ref>``
    — the existing, byte-identical issue path the autonomous loop uses.

    Prompt mode (#968): when ``prompt`` is given, drive
    ``agentrail run prompt "<prompt>" --label <issue_ref>`` instead, so the eval
    runs the agent on the corpus task's prompt through the SAME pipeline/gate.
    ``issue_ref`` becomes the run label (a non-numeric task name).

    Launcher injection (#970): the program that provides ``agentrail run`` is
    ``["agentrail"]`` by default — the npm-published binary on PATH the
    autonomous loop relies on. When the run command is invoked with ``cwd`` set
    to the CLONE, that PATH binary is the OLD published one (no ``run prompt``).
    The eval therefore injects ``agentrail_cmd`` (e.g.
    ``[sys.executable, "-m", "agentrail.cli.main"]``) so the run drives the
    CURRENT source under test; the run is then invoked with ``cwd``/``env``
    pointing at the source tree (see :func:`run_issue_on_host`) and ``target``
    is set to the clone so the agent still edits the cloned task repo. When
    ``agentrail_cmd`` is ``None`` (the real loop), the command is byte-identical
    to before — bare ``["agentrail", ...]`` with no ``--target`` flag.
    """
    launcher = list(agentrail_cmd) if agentrail_cmd is not None else ["agentrail"]
    if prompt is not None:
        cmd: List[str] = [
            *launcher, "run", "prompt", prompt,
            "--label", str(issue_ref),
            "--agent", agent,
            "--run-id", run_id,
            "--log-dir", log_dir,
        ]
    else:
        cmd = [
            *launcher, "run", "issue", str(issue_ref),
            "--agent", agent,
            "--run-id", run_id,
            "--log-dir", log_dir,
        ]
    if model:
        cmd += ["--model", model]
    # Only the injected-launcher path passes ``--target``: the default loop runs
    # the command with ``cwd`` == the clone, so ``run`` already targets the
    # clone (its default target is the cwd) and adding ``--target`` would change
    # the byte-identical issue command. The injected path runs with ``cwd`` ==
    # the source tree, so it MUST name the clone explicitly via ``--target``.
    if agentrail_cmd is not None and target is not None:
        cmd += ["--target", target]
    if sandbox_runtime:
        # Wrap the whole run in Anthropic's Seatbelt/bubblewrap sandbox.
        cmd = ["npx", SANDBOX_RUNTIME_PKG, "--"] + cmd
    return cmd


# ---------------------------------------------------------------------------
# Hosted default config injection (#1267 PR②) — closes the AC1 gap: a
# fleet-claimed customer repo commonly has NO .agentrail/config.json of its
# own, so the Objective Gate has zero declared verify checks (always red) and
# #1270's independent-review assert refuses the run outright before any phase
# runs — every single claim, forever, silently burning retry budget (see
# annex-1267-recon.md §6). Seeding a distinct-execute/verify-model template
# into the clone (only when hosted, only when the repo has none of its own)
# turns that permanent refusal into a real run for the common case.
# ---------------------------------------------------------------------------

def _inject_hosted_config(repo_dir: Path, env: Dict[str, str]) -> None:
    """Seed the baked hosted-default ``.agentrail/config.json`` into a fresh
    clone that doesn't already commit one of its own — hosted mode only.

    See ``deploy/runner/agentrail-config.hosted.json`` (the shipped template,
    with ``models.verify`` distinct from ``models.execute`` — required by
    #1270's assert) and ``deploy/runner/Dockerfile`` (bakes it into the image
    and sets ``AGENTRAIL_HOSTED_CONFIG`` to its path).

    Reads the hosted marker off ``env`` — the SAME merged dict this
    function's caller already consults for every other feature flag
    (``AGENTRAIL_AGENT``, ``AGENTRAIL_SANDBOX_RUNTIME``) — rather than
    re-reading ``os.environ`` directly the way
    ``agentrail.run.pipeline.is_hosted_run()`` does. Same marker, same
    ``"1"`` convention; reading it off ``env`` just keeps this function
    hermetic in tests and consistent with the rest of this module. In the
    real container ``AGENTRAIL_HOSTED=1`` is baked as an image ENV, so it is
    already present in ``os.environ`` (and therefore in the merged ``env``)
    for every run.

    Three no-op cases, all deliberate — never a silent half-config:

    - Not hosted (``AGENTRAIL_HOSTED`` unset / not ``"1"``) — never touches a
      local developer's own run.
    - The clone ALREADY has ``.agentrail/config.json`` — BYO config always
      wins; a repo that has done its own setup is never overwritten.
    - The template path is unset, or unreadable — a LOUD stderr warning, no
      injection, and the run proceeds to hit the SAME honest refusal it
      would have hit without this function. Writing an empty/partial file
      instead would be worse than the refusal it's trying to avoid, so this
      never happens.
    """
    if (env.get(ENV_HOSTED) or "").strip() != "1":
        return

    config_path = repo_dir / ".agentrail" / "config.json"
    if config_path.exists():
        return  # BYO config wins — respected untouched.

    template_path = (env.get(ENV_HOSTED_CONFIG) or "").strip()
    if not template_path:
        print(
            "agentrail: hosted run with no .agentrail/config.json in this repo "
            f"and {ENV_HOSTED_CONFIG} is unset — proceeding without injecting a "
            "default config (the run may be honestly refused by the "
            "independent review assert).",
            file=sys.stderr,
        )
        return

    try:
        template_text = Path(template_path).read_text()
    except OSError as exc:
        print(
            f"agentrail: hosted config template at {template_path!r} could not "
            f"be read ({exc}) — proceeding without injecting a default config "
            "(the run may be honestly refused by the independent review "
            "assert).",
            file=sys.stderr,
        )
        return

    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(template_text)


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
    prompt: Optional[str] = None,
    agentrail_cmd: Optional[List[str]] = None,
    run_cwd: Optional[str] = None,
    run_env: Optional[Dict[str, str]] = None,
    run_dir_factory: Optional[Callable[[], Path]] = None,
    post_checkout: Optional[Callable[[Path], None]] = None,
    runner=subprocess,
) -> RunResult:
    """Run a single issue on the HOST (provider sandbox), not in Docker.

    Clones ``repo_url`` at ``ref`` into a fresh, isolated temp working dir, runs
    ``agentrail run issue <issue_ref> --agent <agent> [--model M]`` there (the
    agent CLI uses the host login + its own native sandbox), parses the run's
    ``run.json`` into a :class:`RunResult`, then ALWAYS removes the temp dir —
    even on error or timeout (AC1, AC2).

    Prompt mode (#968): when ``prompt`` is given, the in-clone command becomes
    ``agentrail run prompt "<prompt>" --label <issue_ref>`` instead of
    ``run issue <issue_ref>``, so the eval drives the agent on a corpus task's
    raw prompt through the SAME pipeline + Objective Gate. ``issue_ref`` is then
    the run label. Everything else (clone into ``workdir/repo`` at ``ref``, the
    #964 diff-capture contract, teardown) is unchanged.

    ``env`` is forwarded to the run; ``AGENTRAIL_FAILURE_HANDOFF`` is set from
    ``failure_handoff`` (a possibly large/multiline compacted handoff, kept off
    the argv). ``env["GIT_TOKEN"]`` (the workspace's connected GitHub OAuth
    token, or a locally configured PAT) authenticates the clone/push over HTTPS
    and `gh pr create` on green — see :func:`_authenticated_clone_url`; a token
    is never placed on argv or left in any captured output this function
    returns (:func:`_redact_token`). Any link env (``AGENTRAIL_SERVER_*``)
    already in ``env`` is passed through so the run ingests. The agent defaults
    to ``claude`` unless ``AGENTRAIL_AGENT`` is set in ``env``.

    When ``AGENTRAIL_SANDBOX_RUNTIME=1`` is in ``env``, the run command is wrapped
    with ``npx @anthropic-ai/sandbox-runtime`` for whole-process isolation
    (default OFF).

    Launcher injection (#970, eval-only): by default the in-clone command is
    ``agentrail run ...`` invoked with ``cwd`` == the clone, exactly as the
    autonomous loop expects. The eval injects ``agentrail_cmd`` (e.g.
    ``[sys.executable, "-m", "agentrail.cli.main"]``) plus ``run_cwd`` == the
    source repo root and ``run_env`` (e.g. ``PYTHONPATH`` == source root and
    ``AGENTRAIL_ALLOW_SOURCE_RUN=1``) so the run drives the CURRENT source under
    test (which has ``run prompt``) while still pointing the agent at the clone
    via ``--target <clone>``. When none of these are passed, behaviour is
    byte-identical to before — the real loop's sandbox path is unchanged.

    Post-checkout seeding (eval-only): ``post_checkout`` is an optional callback
    invoked with the clone root right AFTER the pinned ref is checked out and
    BEFORE the agent runs. Defaults to ``None`` (no-op), so the production loop is
    byte-identical. The eval uses it to seed a ``.agentrail/config.json`` into
    clones whose pinned commit predates that file — without it the Objective Gate
    declares no verify checks and is always red.

    Returns ``status='error'`` for any host-level failure — clone failure,
    timeout, missing ``run.json`` — i.e. whenever no trustworthy gate verdict was
    obtained. ``runner`` is injected (default :mod:`subprocess`) so tests never
    clone or run a real agent.
    """
    env = dict(env or {})
    agent = env.get(ENV_AGENT) or DEFAULT_AGENT
    sandbox_runtime = env.get(ENV_SANDBOX_RUNTIME) == "1"

    # GitHub auth for this run: GIT_TOKEN is either the workspace's connected
    # OAuth token (threaded through by the CLI's claim handling — see
    # agentrail/cli/commands/runner.py / agentrail/runner/client.py) or a
    # locally configured PAT (back-compat fallback, unchanged behaviour).
    # Embedded into the clone URL below so clone/push authenticate, and
    # exported as GH_TOKEN so `gh pr create` in _publish_green does too. NOTE:
    # an OAuth token issued at login can expire; there is no refresh here — an
    # expired token just surfaces as a normal git/gh auth failure.
    git_token = (env.get("GIT_TOKEN") or "").strip()

    # Child-process env: inherit our environment, layer the caller's env, and set
    # the compacted handoff (the execute phase reads it from this var).
    child_env = dict(os.environ)
    child_env.update(env)
    if failure_handoff is not None:
        child_env[ENV_FAILURE_HANDOFF] = failure_handoff
    if git_token and not child_env.get("GH_TOKEN") and not child_env.get("GITHUB_TOKEN"):
        # gh CLI reads GH_TOKEN (preferred) or GITHUB_TOKEN to authenticate
        # non-interactively; only set it when the caller hasn't already
        # configured gh auth some other way.
        child_env["GH_TOKEN"] = git_token

    # Fresh isolated working dir per run (injectable for hermetic tests).
    if run_dir_factory is not None:
        work_dir = Path(run_dir_factory())
        _own_work_dir = False  # caller owns the workdir; must not delete it here
    else:
        work_dir = Path(tempfile.mkdtemp(prefix="agentrail-host-run-"))
        _own_work_dir = True

    repo_dir = work_dir / "repo"
    log_dir = work_dir / _LOG_SUBDIR

    try:
        # 1. Clone at ref. The clone URL carries the token (if any) as HTTP Basic
        # auth so a private repo authenticates; repo_url itself (token-free) is
        # what's echoed anywhere we log/report the repo being run.
        clone_url = _authenticated_clone_url(repo_url, git_token)
        try:
            clone = runner.run(
                _clone_command(clone_url, ref, str(repo_dir)),
                cwd=str(work_dir), env=child_env, timeout=timeout,
            )
        except HostTimeout as exc:
            return RunResult(status="error",
                             gate_reason=f"clone timeout after {timeout}s: {exc}")
        except (HostError, OSError, ValueError) as exc:
            return RunResult(status="error", gate_reason=f"clone error: {exc}")
        if getattr(clone, "returncode", 0) != 0:
            tail = _redact_token(
                _logs_tail(getattr(clone, "stdout", ""), getattr(clone, "stderr", "")),
                git_token,
            )
            return RunResult(status="error",
                             gate_reason="git clone failed",
                             logs_tail=tail or "(no output)")

        # 1a. Detached checkout of a bare commit SHA. ``_clone_command`` omits
        # ``--branch`` for a SHA ref (git rejects a SHA there), so the clone
        # landed on the default branch; check the pinned commit out now so the
        # run sees the exact pinned tree. Branch/tag refs were already checked
        # out by ``--branch`` and skip this step. (#966)
        if _ref_is_commit_sha(ref):
            try:
                checkout = runner.run(
                    _checkout_command(ref),
                    cwd=str(repo_dir), env=child_env, timeout=timeout,
                )
            except (HostError, OSError, ValueError) as exc:
                return RunResult(status="error",
                                 gate_reason=f"checkout error: {exc}")
            if getattr(checkout, "returncode", 0) != 0:
                tail = _redact_token(
                    _logs_tail(
                        getattr(checkout, "stdout", ""), getattr(checkout, "stderr", "")
                    ),
                    git_token,
                )
                return RunResult(status="error",
                                 gate_reason=f"git checkout {ref} failed",
                                 logs_tail=tail or "(no output)")

        # 1a-bis. Post-checkout hook (eval-only seam, default None → no-op so the
        # autonomous-loop/production path is byte-identical). The clone now holds
        # the pinned tree; the eval injects a callback here to SEED files into it
        # before the agent runs — e.g. a ``.agentrail/config.json`` for corpus
        # tasks whose pinned commit predates that file. Without a config the
        # Objective Gate has zero declared verify checks and is ALWAYS red, so
        # such tasks can never reach green regardless of the agent's work. Runs on
        # the clone root (``repo_dir``); best-effort, never wedges the run.
        if post_checkout is not None:
            try:
                post_checkout(repo_dir)
            except Exception:  # noqa: BLE001 - seeding is best-effort
                pass

        # 1a-ter. Hosted default config injection (#1267 PR②) — see
        # _inject_hosted_config's own docstring for the full contract (BYO
        # config always wins; missing/unreadable template while hosted is a
        # loud warning, never a silent half-config). A no-op whenever this
        # process isn't hosted (AGENTRAIL_HOSTED != "1" in child_env).
        _inject_hosted_config(repo_dir, child_env)

        # 1b. Materialize connected MCP connectors into the codebase: write the
        # agent-correct MCP config into the clone from AGENTRAIL_MCP_<PROVIDER>_KEY
        # env vars so the agent can call Linear/Figma/Context7 tools during the
        # run — .mcp.json for claude, .codex/config.toml for codex (codex is NOT
        # JSON). The keys arrive decrypted (the console encrypts them at rest). No
        # MCP connector configured → nothing written. Best-effort: a bad config
        # must never wedge the run.
        try:
            from agentrail.connectors.mcp_config import write_mcp_config_from_env

            # child_env carries AGENTRAIL_AGENT, so the writer picks the format.
            write_mcp_config_from_env(repo_dir, child_env)
        except Exception:  # noqa: BLE001 - MCP config injection is best-effort
            pass

        # 2. Run the spine on the host.
        #
        # Default loop: command is bare ``agentrail run ...`` and runs with
        # ``cwd`` == the clone, so ``run`` targets the clone implicitly. Eval
        # injection (#970): the launcher is the SOURCE module, the command runs
        # with ``cwd`` == the source tree (``run_cwd``) so ``import agentrail``
        # resolves to source (not the clone, which would shadow it), and the
        # clone is named explicitly via ``--target``. ``run_env`` (PYTHONPATH +
        # source-run allow) layers on top of the child env so source import wins.
        run_target = str(repo_dir) if agentrail_cmd is not None else None
        run_cmd = _build_run_command(
            issue_ref=issue_ref, agent=agent, model=model,
            log_dir=str(log_dir), sandbox_runtime=sandbox_runtime,
            run_id=run_id, prompt=prompt,
            agentrail_cmd=agentrail_cmd, target=run_target,
        )
        run_command_cwd = run_cwd if run_cwd is not None else str(repo_dir)
        run_command_env = child_env
        if run_env:
            run_command_env = dict(child_env)
            run_command_env.update(run_env)
        try:
            proc = runner.run(
                run_cmd, cwd=run_command_cwd, env=run_command_env, timeout=timeout,
            )
        except HostTimeout as exc:
            # The run started (clone+checkout already succeeded), so it may have
            # written partial cost to the ledger before timing out. Recover it
            # rather than reporting $0 for money already spent (best-effort).
            return RunResult(status="error",
                             cost_usd=sum_cost_ledger(_ledger_path(repo_dir)),
                             gate_reason=f"host run timeout after {timeout}s: {exc}")
        except subprocess.TimeoutExpired as exc:  # pragma: no cover - real path
            return RunResult(status="error",
                             cost_usd=sum_cost_ledger(_ledger_path(repo_dir)),
                             gate_reason=f"host run timeout after {timeout}s: {exc}")
        except (HostError, OSError, ValueError) as exc:
            return RunResult(status="error",
                             cost_usd=sum_cost_ledger(_ledger_path(repo_dir)),
                             gate_reason=f"host run error: {exc}")

        # 3. Parse run.json → RunResult (mirrors the container parser).
        logs_tail = _redact_token(
            _logs_tail(getattr(proc, "stdout", ""), getattr(proc, "stderr", "")),
            git_token,
        )
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
            # capture_output so we can READ stdout — `gh pr create` prints the PR
            # URL there. Without this, subprocess.run leaves .stdout=None and the
            # PR URL is lost (the PR is still opened, but pr_url comes back empty,
            # so the dashboard + Telegram notify show no link). text=True yields a
            # str rather than bytes for the splitlines() parse below.
            return runner.run(
                cmd, cwd=str(repo_dir), env=env, timeout=120,
                capture_output=True, text=True,
            )
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

    Two ways to pick, checked in this order:

    1. **Explicit** ``AGENTRAIL_SANDBOX`` ∈ {``"host"``, ``"docker"``}
       (case/whitespace-insensitive) always WINS, regardless of
       ``ANTHROPIC_API_KEY``. This is the ONLY way to select Docker-sandbox
       mode for a process whose ``ANTHROPIC_API_KEY`` is structurally always
       empty — exactly the hosted fleet's own case
       (``deploy/runner/Dockerfile`` bakes ``ANTHROPIC_API_KEY=""`` on
       purpose; OpenRouter auth rides ``ANTHROPIC_AUTH_TOKEN`` instead — see
       that file's header) but that still runs on a socket-capable host and
       wants genuine per-task container isolation (#1267 PR④; see
       ``deploy/fleet/README.md``'s Isolation section). An unrecognized
       non-empty value is treated the same as unset (a loud stderr warning,
       then fall through to the legacy trigger below) — never a hard crash
       over a typo.
    2. **Legacy trigger** (unchanged, kept BYTE-IDENTICAL — do not remove):
       when ``AGENTRAIL_SANDBOX`` is unset, Docker is selected purely because
       ``ANTHROPIC_API_KEY`` happens to be set (CI / cloud: API-key auth
       works fine inside a container); otherwise host-native (local dev: the
       agent CLI uses the host login + its own native sandbox). Deployed
       environments — including ``deploy/docker-compose.prod.yml``'s
       commented socket-mount instructions — document and rely on exactly
       this rule when no explicit override is set.
    """
    from agentrail.sandbox.docker_runner import run_issue_in_sandbox

    raw_mode = (env.get(ENV_SANDBOX_MODE) or "").strip()
    mode = raw_mode.lower()
    if mode == SANDBOX_MODE_DOCKER:
        return run_issue_in_sandbox
    if mode == SANDBOX_MODE_HOST:
        return run_issue_on_host
    if mode:
        # Non-empty but not a recognized value — warn loudly, then fall
        # through to the legacy trigger exactly as if unset, rather than
        # crashing the runner over a typo.
        print(
            f"agentrail: {ENV_SANDBOX_MODE}={raw_mode!r} is not "
            f"{SANDBOX_MODE_HOST!r} or {SANDBOX_MODE_DOCKER!r} — ignoring it "
            "and falling back to the legacy ANTHROPIC_API_KEY-based "
            "selection.",
            file=sys.stderr,
        )

    # LEGACY trigger — pre-#1267-PR④ behaviour, kept byte-identical. Do NOT
    # remove: deployed environments rely on this exact rule when
    # AGENTRAIL_SANDBOX is unset.
    if (env.get("ANTHROPIC_API_KEY") or "").strip():
        return run_issue_in_sandbox
    return run_issue_on_host
