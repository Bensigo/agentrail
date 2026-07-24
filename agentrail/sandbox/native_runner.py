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

import functools
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
# _authenticated_clone_url / _redact_token used to be defined in this module.
# #1268 extracted them into agentrail.sandbox.clone_auth as the ONE shared
# implementation (the onboard work-kind handler needed the exact same
# mechanism and a duplicate would drift) — re-imported under their original
# names so every existing call site below, and this module's own test suite
# (agentrail/tests/sandbox/test_native_runner.py), is unchanged.
from agentrail.sandbox.clone_auth import (
    authenticated_clone_url as _authenticated_clone_url,
    redact_token as _redact_token,
)

# The subprocess execution ceiling is sourced from the ONE liveness config
# (#1388 AC4) so it can never drift from the stale-run reclaim window that must
# stay above it — see agentrail/runner/liveness.py. Value unchanged (3600s).
from agentrail.runner.liveness import EXECUTION_CEILING_SECONDS

DEFAULT_TIMEOUT = EXECUTION_CEILING_SECONDS  # seconds — hard ceiling on the whole host run.
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

# #1391: the DISTINCT infrastructure-error classification a run records when its
# publish push could not authenticate to GitHub even after a token refresh — the
# workspace's OAuth token expired mid-run and the refresh was unrecoverable.
# Surfaced as ``status='error'`` (never a generic ``red``) with this
# ``gate_reason`` so run evidence shows a distinct infra error: the compute was
# NOT wasted for a code reason, so the loop must not spend a code-retry budget
# chasing it. Stands alone without #1389's attempt-history (which isn't merged
# yet) — the distinct status + reason are the whole classification here.
GITHUB_TOKEN_REFRESH_FAILED = "infra: github token expired and refresh failed"

# Substrings (case-insensitive) that mark a ``git push`` failure as a GitHub
# AUTHENTICATION failure — the only push failures the #1391 mid-run token
# refresh should try to recover. A non-auth push failure (network blip, hook
# rejection) keeps the prior best-effort behavior and never triggers a refresh.
_GIT_AUTH_FAILURE_MARKERS = (
    "authentication failed",
    "invalid username or token",
    "invalid username or password",
    "could not read username",
    "could not read password",
    "bad credentials",
    "support for password authentication",
    "terminal prompts disabled",
    "error: 403",
    "error: 401",
    "http 403",
    "http 401",
    "token expired",
    "requested url returned error: 403",
    "requested url returned error: 401",
)


def _looks_like_git_auth_failure(push_result: Optional[object]) -> bool:
    """True when a failed ``git push`` result reads as a GitHub AUTH failure.

    Inspects the captured stdout/stderr for the known credential-rejection
    markers (:data:`_GIT_AUTH_FAILURE_MARKERS`). ``None`` (the push raised) is
    NOT treated as auth — a raised subprocess is an environment error, not a
    401. Conservative on purpose: a false negative just keeps today's
    best-effort behavior, whereas a false positive would spend a token refresh
    on an unrelated failure.
    """
    if push_result is None:
        return False
    text = (
        f"{getattr(push_result, 'stdout', '') or ''}\n"
        f"{getattr(push_result, 'stderr', '') or ''}"
    ).lower()
    return any(marker in text for marker in _GIT_AUTH_FAILURE_MARKERS)


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


# ---------------------------------------------------------------------------
# Git credential handoff (#1295 G5) — never write the token into .git/config
# ---------------------------------------------------------------------------
#
# Before #1295 the workspace's GitHub token was spliced straight into the clone
# URL (``_authenticated_clone_url`` → ``https://x-access-token:TOKEN@github…``),
# so it persisted in the clone's ``.git/config`` origin remote — readable by
# the untrusted agent the run then executes INSIDE that clone (threat model
# §2 B6, gap G5), and by any concurrent sibling run on the shared filesystem.
#
# Instead we clone the TOKEN-FREE URL and hand git the token out-of-band via a
# ``GIT_ASKPASS`` helper that reads it from the environment. The token never
# lands in ``.git/config`` (origin stays token-free) nor on argv (it is not a
# command-line argument to git). The same env drives the later ``git push`` in
# :func:`_publish_green` and any push the agent makes, so legitimate clone AND
# push both still authenticate as THIS workspace.
#
# The credential-helper reset is load-bearing on the hosted fleet: the runner
# entrypoint runs ``gh auth setup-git`` (``deploy/runner/entrypoint.sh``), which
# installs a global git credential helper answering with the operator's SHARED
# fallback PAT. Without resetting it, git would consult that helper first and
# authenticate as the shared identity instead of THIS workspace's token (a
# correctness regression for private per-workspace repos the shared PAT cannot
# reach). We clear the inherited helper list via the ``GIT_CONFIG_*`` env
# interface (git ≥ 2.31) so the reset itself never lands on argv or in
# ``.git/config`` either, then git falls through to ``GIT_ASKPASS``.
_GIT_ASKPASS_SCRIPT = """#!/bin/sh
# AgentRail host-native git credential helper (#1295 G5). Supplies the
# per-workspace GitHub token to git over HTTPS from the environment, so the
# token is NEVER written into the clone's .git/config. git invokes this with
# the credential prompt string as $1 ("Username for ..."/"Password for ...").
case "$1" in
  *[Uu]sername*) printf '%s' 'x-access-token' ;;
  *)             printf '%s' "${GIT_TOKEN:-}" ;;
esac
"""

_GIT_ASKPASS_FILENAME = ".agentrail-git-askpass.sh"


def _install_git_askpass(work_dir: Path) -> str:
    """Write the :data:`_GIT_ASKPASS_SCRIPT` into ``work_dir`` (the per-run,
    always-torn-down working dir — NOT the clone), make it executable, and
    return its path. The script carries NO secret itself; it reads the token
    from ``GIT_TOKEN`` in the environment at invocation time.
    """
    script = Path(work_dir) / _GIT_ASKPASS_FILENAME
    script.write_text(_GIT_ASKPASS_SCRIPT)
    script.chmod(0o700)
    return str(script)


def _git_credential_env(askpass_path: str) -> Dict[str, str]:
    """Env that routes git's HTTPS auth through the askpass helper at
    ``askpass_path`` (reading ``GIT_TOKEN``) and resets any inherited
    credential helper so THIS workspace's token wins over the fleet's shared
    fallback PAT. Nothing here embeds the token in ``.git/config`` or on argv.
    """
    return {
        "GIT_ASKPASS": askpass_path,
        # Never block on an interactive prompt if askpass somehow yields nothing.
        "GIT_TERMINAL_PROMPT": "0",
        # Reset the inherited credential.helper list (empty value resets it),
        # supplied via the GIT_CONFIG_* env interface so it stays off argv and
        # out of .git/config; git then falls through to GIT_ASKPASS.
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "credential.helper",
        "GIT_CONFIG_VALUE_0": "",
    }


def _build_run_command(
    *, issue_ref: str, agent: str, model: Optional[str], log_dir: str,
    sandbox_runtime: bool, run_id: str, prompt: Optional[str] = None,
    agentrail_cmd: Optional[List[str]] = None, target: Optional[str] = None,
    budget_usd: Optional[float] = None, budget_source: Optional[str] = None,
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

    Budget passthrough (#1275): when ``budget_usd`` is given, appends
    ``--budget-usd <value>`` mirroring exactly how ``model`` becomes
    ``--model`` above, plus ``--budget-source <budget_source>`` when a source
    label is also given (the runner always pairs the two — see
    ``agentrail.cli.commands.runner._make_execute``, the only caller that ever
    sets these). ``None`` (the default) appends neither flag — byte-identical
    to before this parameter existed.
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
    if budget_usd is not None:
        cmd += ["--budget-usd", str(budget_usd)]
        if budget_source:
            cmd += ["--budget-source", budget_source]
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
    budget_usd: Optional[float] = None,
    budget_source: Optional[str] = None,
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
    github_token_refresher: Optional[Callable[[], Optional[str]]] = None,
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

    Budget passthrough (#1275): ``budget_usd``/``budget_source`` mirror
    ``model`` exactly — forwarded to :func:`_build_run_command` as
    ``--budget-usd``/``--budget-source``, appended to the in-clone command
    ONLY when ``budget_usd`` is given (``None``, the default, means neither
    flag appears — byte-identical to before these parameters existed). The
    caller (``agentrail.cli.commands.runner._make_execute``) sets both
    together from a claimed WorkItem's ``estimated_budget_usd`` — an
    alignment brief's confirmed per-issue ceiling (owner rule: "confirming
    the brief = sanctioning the ceiling").

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

    # Child-process env (#1295 G1): a MINIMAL non-secret system base + the
    # justified allowlist pulled from THIS process's env + the caller's OWN
    # explicit env — NOT a blanket copy of os.environ, which on the hosted
    # fleet would hand the untrusted agent FLEET_CONSOLE_TOKEN and every other
    # operator secret. See build_native_child_env for the full contract.
    child_env = build_native_child_env(os.environ, env)
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

    # GitHub auth handoff (#1295 G5): route git's HTTPS auth through a
    # GIT_ASKPASS helper reading GIT_TOKEN from the env, instead of splicing the
    # token into the clone URL where it would persist in .git/config for the
    # untrusted agent to read. The env drives the clone here AND the later push
    # in _publish_green / the agent's own pushes, so both still authenticate as
    # this workspace. No-op when there is no token (unchanged behaviour: a plain
    # clone that relies on the host's own git credential config, if any).
    if git_token:
        child_env["GIT_TOKEN"] = git_token  # the askpass helper reads this
        child_env.update(_git_credential_env(_install_git_askpass(work_dir)))

    try:
        # 1. Clone at ref, TOKEN-FREE (#1295 G5). The token never enters the URL
        # (and so never .git/config); auth rides the GIT_ASKPASS env set above.
        # repo_url is also exactly what's echoed anywhere we log/report the run.
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
            budget_usd=budget_usd, budget_source=budget_source,
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
            branch, pr_url, push_auth_infra = _publish_green(
                runner, repo_dir, issue_ref, pr_title, base_ref=ref, env=child_env,
                repo_url=repo_url, github_token_refresher=github_token_refresher,
            )
            from dataclasses import replace

            if push_auth_infra:
                # #1391 AC3: the gate went green but the publish push could not
                # authenticate to GitHub even after a token refresh — an
                # INFRASTRUCTURE failure (the workspace's OAuth token expired),
                # not a code failure. Downgrade to a DISTINCT infra-error
                # classification so run evidence shows it as such and the loop
                # never spends a code-retry budget on it. The agent's work is
                # committed to ``branch`` locally but remains unpushed.
                result = replace(
                    result,
                    status="error",
                    gate_reason=GITHUB_TOKEN_REFRESH_FAILED,
                    branch=branch or result.branch,
                )
            else:
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


def _git_identity_args(env: Dict[str, str]) -> List[str]:
    """The ``-c user.email=...`` / ``-c user.name=...`` argv for the runner's
    own commit (GitHub App swap spec §6).

    Uses the workspace's GitHub App bot identity — ``AGENTRAIL_GIT_BOT_NAME`` /
    ``AGENTRAIL_GIT_BOT_EMAIL``, threaded into ``env`` by
    ``agentrail.cli.commands.runner._make_execute`` from a claimed
    ``WorkItem``'s ``git_bot_name``/``git_bot_email`` — when BOTH are present,
    so pushed commits attribute to ``<slug>[bot]`` instead of the neutral
    fallback. Falls back to :data:`_GIT_IDENTITY` when either is missing: an
    older backend, a self-host with no GitHub App configured, or a partial/
    inconsistent claim (only one of the two set) all degrade to the same
    historical neutral identity rather than a lone name or email.
    """
    bot_name = env.get("AGENTRAIL_GIT_BOT_NAME")
    bot_email = env.get("AGENTRAIL_GIT_BOT_EMAIL")
    if bot_name and bot_email:
        return ["-c", f"user.email={bot_email}", "-c", f"user.name={bot_name}"]
    return list(_GIT_IDENTITY)


def _publish_green(
    runner, repo_dir: Path, issue_ref: str, pr_title: Optional[str],
    *, base_ref: str, env: Dict[str, str],
    repo_url: str = "",
    github_token_refresher: Optional[Callable[[], Optional[str]]] = None,
) -> tuple[str, str, bool]:
    """Commit the agent's work to a feature branch, push it, open a PR.

    Returns ``(branch, pr_url, push_auth_infra)``. ``branch``/``pr_url`` may be
    ``""`` on failure. ``push_auth_infra`` is ``True`` ONLY when the push failed
    GitHub AUTH and the #1391 token-refresh recovery could not fix it — the
    caller then records the distinct infra-error classification. Best-effort
    otherwise: every step is guarded so a publish failure never raises into the
    run. The branch is ``agentrail/issue-<n>`` so the PR branch is
    self-describing.

    Mid-run token refresh (#1391): when the push fails and it reads as an auth
    failure (:func:`_looks_like_git_auth_failure`) AND ``github_token_refresher``
    is provided, refresh the workspace's GitHub token ONCE, re-point ``origin``
    at the fresh token, and retry the push a single time. A successful retry
    proceeds to open the PR exactly as a first-try push would. ``None``
    refresher (the single-workspace default, or a workspace with no OAuth token)
    keeps the prior best-effort behavior byte-for-byte: a push failure just
    returns no PR.
    """
    number = re.search(r"(\d+)\s*$", str(issue_ref))
    n = number.group(1) if number else str(issue_ref)
    branch = f"agentrail/issue-{n}"
    title = pr_title or f"agentrail: resolve #{n}"
    # GitHub App bot identity when the claim carried one, else the neutral
    # fallback (spec §6) — see _git_identity_args's own docstring.
    identity = _git_identity_args(env)

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
    if _run(["git", *identity, "checkout", "-B", branch]) is None:
        return "", "", False
    _run(["git", "add", "-A"])
    commit = _run(["git", *identity, "commit", "-m", f"{title} (#{n})"])
    if commit is None or getattr(commit, "returncode", 1) != 0:
        return branch, "", False  # nothing to commit / commit failed

    push = _run(["git", "push", "--force", "-u", "origin", f"HEAD:{branch}"])
    if push is None or getattr(push, "returncode", 1) != 0:
        # #1391 mid-run recovery: only an AUTH failure with a refresher available
        # triggers a refresh + single retry; every other push failure keeps the
        # prior best-effort "green, no PR" behavior.
        if github_token_refresher is not None and _looks_like_git_auth_failure(push):
            fresh: Optional[str] = None
            try:
                fresh = github_token_refresher()
            except Exception:  # noqa: BLE001 — refresh is best-effort, never fatal
                fresh = None
            if not fresh:
                # The refresh itself failed (bad_refresh_token / network / no
                # refresh token) — unrecoverable; classify as infra error.
                return branch, "", True
            # Re-point origin at the fresh token and retry the push ONCE. Reassign
            # ``env`` (a local) so the ``gh pr create`` below authenticates with
            # the fresh token too — the nested ``_run`` reads ``env`` at call time.
            _run(["git", "remote", "set-url", "origin",
                  _authenticated_clone_url(repo_url, fresh)])
            env = {**env, "GH_TOKEN": fresh, "GIT_TOKEN": fresh}
            push = _run(["git", "push", "--force", "-u", "origin", f"HEAD:{branch}"])
            if push is None or getattr(push, "returncode", 1) != 0:
                # Refresh succeeded but the retried push still failed — the token
                # is not the (only) problem; still an unrecoverable infra push.
                return branch, "", True
            # Fresh-token push succeeded — fall through to open the PR.
        else:
            return branch, "", False

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
        return branch, url, False
    url = (getattr(pr, "stdout", "") or "").strip().splitlines()[-1:] or [""]
    return branch, url[0], False


# ---------------------------------------------------------------------------
# Docker-sandbox env passthrough allowlist (#1267 PR④ item 2)
# ---------------------------------------------------------------------------
#
# ``run_issue_in_sandbox`` (agentrail.sandbox.docker_runner) forwards EVERY
# key of the ``env`` dict it is handed into the spawned container, by name
# (``docker_runner.build_run_command``'s ``env_keys = sorted(env.keys())`` ->
# ``docker run -e KEY`` per key) — whatever is in that dict reaches the
# container, nothing more and nothing less. The dict it is normally handed
# (``agentrail.cli.commands.runner._make_execute``'s ``run_env =
# dict(os.environ)``, reused verbatim by ``agentrail.cli.commands.fleet``'s
# own docstring: "Every per-workspace run this daemon executes inherits this
# process's OS environment") starts as a full copy of THIS process's entire
# environment. For the hosted fleet daemon (``deploy/runner/Dockerfile`` /
# ``agentrail/cli/commands/fleet.py``) that is EVERYTHING the container was
# started with — ``FLEET_CONSOLE_TOKEN``, ``OPENROUTER_API_KEY``,
# ``AGENTRAIL_SERVER_*``, ``PATH``/``HOME``/etc: a blanket dump, not a
# deliberate contract. Today that is harmless by accident, because
# ``ANTHROPIC_API_KEY`` is always empty in that image so Docker-sandbox mode
# is never reachable for it — but item 1 above (``AGENTRAIL_SANDBOX=docker``)
# makes it reachable on purpose. Without this filter, flipping that switch
# would forward operator-only secrets the sandbox has no use for — most
# concretely ``FLEET_CONSOLE_TOKEN``, the console sync secret that can mint
# per-workspace runner tokens — into a customer's disposable per-task
# sandbox container. This wrapper is the fix: reduce ``env`` to an explicit,
# justified allowlist before ``run_issue_in_sandbox`` ever sees it, no
# matter what the caller handed in.
#
# What this filter does NOT achieve — stated plainly, because "isolation,
# honestly" cuts both ways: the operator's OpenRouter credential is still
# inside every sandbox container, by design. Its VALUE arrives as
# ``ANTHROPIC_AUTH_TOKEN`` (deploy/runner/entrypoint.sh maps
# OPENROUTER_API_KEY -> ANTHROPIC_AUTH_TOKEN at fleet-container start, and
# that name is deliberately allowlisted below — the coding agent cannot
# authenticate without it). Excluding the raw ``OPENROUTER_API_KEY`` name
# therefore removes only a redundant, unconsumed copy of the same secret; a
# task running inside the sandbox can still read the operator's real
# OpenRouter credential. That residual exposure is part of why the
# multi-tenant production guidance (deploy/fleet/README.md's Isolation
# section) points at #1295 hardening rather than calling per-task
# containers alone sufficient.
#
# What's allowed through, and why:
#   ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN     - Claude Code's OpenRouter
#       auth (deploy/runner/Dockerfile bakes the base URL; entrypoint.sh maps
#       OPENROUTER_API_KEY -> ANTHROPIC_AUTH_TOKEN at container start — see
#       that file's own header on why ANTHROPIC_API_KEY is deliberately left
#       empty instead of holding the real credential).
#   CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK          - required alongside the
#       two vars above for the OpenRouter-routed model path to work at all
#       (baked as an image ENV right next to them).
#   AGENTRAIL_HOSTED                              - the marker
#       agentrail.run.pipeline.is_hosted_run() reads; without it inside the
#       container, #1270's independent-review assert silently never engages.
#   AGENTRAIL_CLAUDE_COMMAND                      - the baked
#       `claude --bare -p --dangerously-skip-permissions` override
#       (resolve_agent_command's env slot); without it the container falls
#       back to a command built for a different auth flow.
#   AGENTRAIL_HOSTED_CONFIG                       - path to the seeded
#       default `.agentrail/config.json` template (see
#       _inject_hosted_config above). Forwarded for parity with the
#       host-native path even though today's docker-sandbox entrypoint
#       (agentrail/docker/runner/entrypoint.sh) does not yet call the
#       equivalent injection itself — that is a pre-existing gap in that
#       image, out of scope for this PR (see its out-of-scope list).
#   GIT_TOKEN                                     - the CLAIMED workspace's
#       own GitHub token, set fresh per run (never baked) — needed for the
#       in-container clone/push to authenticate as THAT workspace, not the
#       fleet operator.
#   AGENTRAIL_MCP_<PROVIDER>_KEY (prefix match)   - per-workspace MCP
#       connector keys (Linear/Figma/Context7), one env var per connected
#       provider — see write_mcp_config_from_env's own contract.
#   AGENTRAIL_SERVER_BASE_URL, AGENTRAIL_SERVER_API_KEY,
#   AGENTRAIL_SERVER_REPOSITORY_ID                 - links THIS run's
#       ingested cost/telemetry back to the dashboard run (_make_execute
#       sets these per-claim); without them the run still executes but the
#       dashboard never sees its cost or telemetry — the same link
#       run_issue_on_host's own docstring already documents forwarding for
#       the host-native path.
#
# This SAME allowlist governs BOTH ways ``select_sandbox_runner`` can choose
# Docker mode (the new explicit ``AGENTRAIL_SANDBOX=docker`` and the legacy
# ``ANTHROPIC_API_KEY``-presence trigger) — the passthrough boundary is a
# property of the CONTAINER, not of which trigger picked it. Which is also
# why the two vars below are included even though they're not part of the
# OpenRouter/hosted list: they are the sandbox image's own DOCUMENTED env
# interface (``agentrail/docker/runner/Dockerfile``'s header: "Required
# RUNTIME env ... ANTHROPIC_API_KEY agent API key for the Claude CLI (or ...
# OPENAI_API_KEY for codex)") — a documented interface, not a claim that a
# live CI pipeline actively exercises that path today. Omitting them would
# silently narrow that documented interface out from under any deployment
# that does rely on it, the first time this allowlist applied to it.
#   ANTHROPIC_API_KEY, OPENAI_API_KEY             - the disposable sandbox
#       image's own pre-existing, documented agent-CLI credential contract
#       (claude / codex respectively). For the OpenRouter/hosted case this
#       rides through as the empty string (deploy/runner/Dockerfile bakes
#       ANTHROPIC_API_KEY="" on purpose) alongside ANTHROPIC_AUTH_TOKEN —
#       verified not to shadow it (deploy/runner/README.md's "Auth mechanism"
#       section: "a no-credential control run refused with 'Not logged in'
#       before any network call").
#
# The third select_sandbox_runner caller — the heartbeat runtime
# (agentrail/cli/commands/heartbeat.py) — was checked too: it hand-builds a
# small env of {AGENT_API_KEY, GIT_TOKEN, ANTHROPIC_API_KEY}, of which
# AGENT_API_KEY is vestigial (forwarded by name since the MVP but consumed
# by nothing in the sandbox image, its entrypoint, or the agent CLIs —
# grepped; only heartbeat help text and a docker_runner docstring example
# mention it), so this allowlist omitting it changes nothing observable for
# that path either.
#
# Nothing else passes. A var some future run genuinely needs that isn't
# listed here is a bug to fix by adding a new, named, justified entry —
# never by widening this back into a blanket forward.
_DOCKER_SANDBOX_ENV_ALLOWLIST = frozenset(
    {
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK",
        "AGENTRAIL_HOSTED",
        "AGENTRAIL_CLAUDE_COMMAND",
        "AGENTRAIL_HOSTED_CONFIG",
        "GIT_TOKEN",
        "AGENTRAIL_SERVER_BASE_URL",
        "AGENTRAIL_SERVER_API_KEY",
        "AGENTRAIL_SERVER_REPOSITORY_ID",
    }
)
# Per-provider MCP connector keys are one env var per provider
# (AGENTRAIL_MCP_LINEAR_KEY, AGENTRAIL_MCP_FIGMA_KEY, ...) — a prefix match,
# not a fixed name.
_DOCKER_SANDBOX_ENV_PREFIX_ALLOWLIST = ("AGENTRAIL_MCP_",)


def filter_docker_sandbox_env(env: Dict[str, str]) -> Dict[str, str]:
    """Reduce ``env`` to :data:`_DOCKER_SANDBOX_ENV_ALLOWLIST` (+ the
    ``AGENTRAIL_MCP_`` prefix). Exported so tests — and any future caller —
    can assert on the filter directly without going through the full runner.
    """
    return {
        k: v
        for k, v in (env or {}).items()
        if k in _DOCKER_SANDBOX_ENV_ALLOWLIST or k.startswith(_DOCKER_SANDBOX_ENV_PREFIX_ALLOWLIST)
    }


# ---------------------------------------------------------------------------
# Host-native child-env boundary (#1295 G1) — allowlist the native path too
# ---------------------------------------------------------------------------
#
# The host-native path runs the coding agent as a subprocess ON the fleet host,
# so the child's environment is whatever we hand it. Before #1295 that was a
# blanket copy of the ENTIRE fleet-process environment (``dict(os.environ)``,
# the old ``run_issue_on_host`` lines below), which on the hosted fleet
# includes ``FLEET_CONSOLE_TOKEN`` (mints EVERY tenant's runner token), the raw
# ``OPENROUTER_API_KEY``, a shared fallback ``GITHUB_TOKEN``, and — on the
# single-tenant compose shape — ``DATABASE_URL`` / ``AUTH_SECRET`` /
# ``CONNECTOR_SECRET_KEY`` / ``POSTGRES_PASSWORD``. A malicious repo/issue
# driving the agent could ``printenv`` any of them (threat model §2 B1, §3,
# gap G1: "the top cross-tenant escalation").
#
# The docker sandbox path already reduces the env to a justified allowlist
# (``_DOCKER_SANDBOX_ENV_ALLOWLIST``) before the container ever sees it. This
# builds the SAME boundary for the host-native path: the child env is a MINIMAL
# non-secret system/toolchain base + that same allowlist pulled from the
# process env + the caller's OWN explicit env. Nothing secret outside the
# allowlist survives.
#
# NOTE — the caller half of the fix: the boundary only holds because the caller
# (``agentrail.cli.commands.runner._make_execute``, reused verbatim by the
# fleet) no longer hands us a blanket ``dict(os.environ)`` as ``env``. This
# function passes the caller's ``env`` through UNTOUCHED by design — the eval
# harness legitimately threads narrow, NON-secret feature-flag vars
# (``AGENTRAIL_EVAL_LAYER_*`` …) that must reach the child and are not in the
# allowlist — so if a caller ever went back to copying the whole environment
# into ``env``, the secrets would ride back in through it. ``_make_execute``'s
# own tests pin that it builds a narrow env.
#
# Essential, NON-SECRET system/toolchain vars the agent's own toolchain (git,
# gh, node/npx, python, claude, TLS) needs to function at all. These are ambient
# OS configuration, never credentials. Everything a run legitimately needs
# beyond these arrives explicitly via the allowlist above + the caller's env.
_NATIVE_SYSTEM_ENV_PASSTHROUGH = frozenset(
    {
        "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD",
        "LANG", "LANGUAGE", "TERM", "TZ",
        "TMPDIR", "TEMP", "TMP",
        # XDG base dirs some tools resolve config/cache under.
        "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
        # TLS / proxy — non-secret infra config commonly required for the
        # agent's OWN outbound HTTPS (model API, GitHub, console) behind a proxy
        # or with a custom CA bundle. Dropping these would silently break such
        # deployments while removing nothing secret.
        "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
        "http_proxy", "https_proxy", "no_proxy",
        "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO",
    }
)
# Locale is a whole family (LC_ALL, LC_CTYPE, …), not a fixed set of names.
_NATIVE_SYSTEM_ENV_PREFIX_PASSTHROUGH = ("LC_",)


def _is_native_system_env(key: str) -> bool:
    return key in _NATIVE_SYSTEM_ENV_PASSTHROUGH or key.startswith(
        _NATIVE_SYSTEM_ENV_PREFIX_PASSTHROUGH
    )


def build_native_child_env(
    process_env: Dict[str, str], caller_env: Dict[str, str]
) -> Dict[str, str]:
    """Build the host-native agent's child environment as a MINIMAL, non-secret
    base rather than a blanket copy of the fleet process env (#1295 G1). See the
    section header above for the threat this closes.

    Order (later wins):

      1. essential NON-SECRET system/toolchain vars from ``process_env``;
      2. the justified allowlist (:func:`filter_docker_sandbox_env`) pulled from
         ``process_env`` — the SAME proven set the docker sandbox forwards
         (``ANTHROPIC_*`` model auth, ``GIT_TOKEN``, ``AGENTRAIL_SERVER_*``, the
         hosted markers, the per-provider MCP connector keys);
      3. the caller's OWN explicit ``caller_env``, passed through untouched.

    A ``process_env`` secret that is neither a system var nor allowlisted —
    ``FLEET_CONSOLE_TOKEN``, ``DATABASE_URL``, ``AUTH_SECRET``,
    ``CONNECTOR_SECRET_KEY``, ``POSTGRES_PASSWORD``, the raw
    ``OPENROUTER_API_KEY``, a shared ``GITHUB_TOKEN`` — is ABSENT from the
    result, so a malicious repo/issue driving the agent cannot read it out of
    its own environment. Exported so the probe suite can assert on the boundary
    directly.
    """
    child: Dict[str, str] = {
        k: v for k, v in (process_env or {}).items() if _is_native_system_env(k)
    }
    child.update(filter_docker_sandbox_env(process_env))
    child.update(caller_env or {})
    return child


def _wrap_docker_sandbox_env(fn: Callable[..., RunResult]) -> Callable[..., RunResult]:
    """Wrap ``fn`` (``run_issue_in_sandbox``) so its ``env`` kwarg is always
    reduced to the allowlist above before ``fn`` actually runs.

    ``functools.wraps`` copies ``fn``'s ``__wrapped__`` onto the returned
    closure, which ``inspect.signature`` follows by default — this matters
    because ``agentrail.cli.commands.runner._make_execute`` introspects the
    selected runner's signature (``"model" in
    inspect.signature(runner).parameters``, etc.) to decide which kwargs to
    pass it. Without ``functools.wraps``, a plain ``**kwargs`` wrapper would
    hide every real parameter name from that introspection and silently stop
    forwarding ``model`` on a Docker-sandbox escalation retry — a functional
    regression, not just a style nit.
    """

    @functools.wraps(fn)
    def _docker_sandbox_with_allowlisted_env(*, env: Dict[str, str], **kwargs):
        return fn(env=filter_docker_sandbox_env(env), **kwargs)

    return _docker_sandbox_with_allowlisted_env


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

    Either way, the returned Docker-mode callable is NOT the bare
    ``run_issue_in_sandbox`` — it is wrapped so its ``env`` is reduced to an
    explicit allowlist before the sandbox container ever sees it (#1267 PR④
    item 2; see ``_wrap_docker_sandbox_env`` above for the full contract and
    why: the dict this is normally handed starts as a full copy of this
    process's own environment, which would otherwise leak wholesale into a
    customer's disposable per-task container).
    """
    from agentrail.sandbox.docker_runner import run_issue_in_sandbox

    raw_mode = (env.get(ENV_SANDBOX_MODE) or "").strip()
    mode = raw_mode.lower()
    if mode == SANDBOX_MODE_DOCKER:
        return _wrap_docker_sandbox_env(run_issue_in_sandbox)
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

    # LEGACY trigger — pre-#1267-PR④ SELECTION behaviour, kept byte-identical
    # (do NOT remove: deployed environments rely on this exact rule when
    # AGENTRAIL_SANDBOX is unset). The allowlist wrap below is an item-2
    # passthrough fix, not a selection change — it applies uniformly to
    # every path that picks Docker mode, this one included, because the
    # blanket-forward gap it closes is a property of the CONTAINER, not of
    # which trigger chose it.
    if (env.get("ANTHROPIC_API_KEY") or "").strip():
        return _wrap_docker_sandbox_env(run_issue_in_sandbox)
    return run_issue_on_host
