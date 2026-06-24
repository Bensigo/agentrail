"""
``agentrail run`` — native dispatcher for the run command.

Replaces the legacy bash ``run`` outer layer: option parsing, agent/command
resolution, the source-checkout and active-run guards, queued-issue selection,
and ``run batch`` orchestration. The inner per-issue plan/execute pipeline is
still provided by the legacy script (delegated via subprocess) until a later
slice ports it.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List

from agentrail.run.pipeline import layer_enabled

AGENTS = {"codex", "claude", "cursor", "hermes", "custom"}

DEFAULT_COMMANDS = {
    "codex": "codex exec --sandbox danger-full-access -",
    "claude": "claude -p --dangerously-skip-permissions",
    "cursor": "cursor-agent -p",
    "hermes": "hermes -p",
    "custom": "",
}

ENV_NAMES = {a: f"AGENTRAIL_{a.upper()}_COMMAND" for a in AGENTS}


class UsageError(Exception):
    """Raised for bad CLI input; carries an exit code (2 by default)."""

    def __init__(self, message: str, code: int = 2) -> None:
        super().__init__(message)
        self.code = code


def _usage() -> str:
    return """Usage:
  agentrail run [--agent NAME] [--target DIR] [--command CMD] [--model MODEL]
                [--log-dir DIR]
  agentrail run issue N [--agent NAME] [--target DIR] [--command CMD]
                        [--model MODEL] [--log-dir DIR] [--run-id ID]
                        [--budget-usd FLOAT]
  agentrail run prompt "TEXT" [--label NAME] [--agent NAME] [--target DIR]
                        [--command CMD] [--model MODEL] [--log-dir DIR]
                        [--run-id ID] [--budget-usd FLOAT]
  agentrail run batch [--concurrency N] [--agent NAME] [--target DIR]
                      [--command CMD] [--model MODEL] [--base BRANCH]
                      [--] ISSUE [ISSUE ...]

Bare `run` selects the next queued GitHub issue (labels: afk, ready-for-agent;
excludes afk-in-progress) and runs it. `run issue N` runs a specific issue.
`run prompt "TEXT"` runs the SAME pipeline (test-author → execute → verify +
Objective Gate) on a raw prompt instead of a numbered issue. `run batch` runs
several issues in parallel, each in its own git worktree.

Budget: when --budget-usd is omitted, the default cap is read from
`budgets.per_issue_usd` in .agentrail/config.json (0 or unset = uncapped).
Passing --budget-usd 0 explicitly disables the cap even when the config
sets a default.
"""


def run_run(args: List[str]) -> int:
    if args and args[0] in ("-h", "--help"):
        print(_usage())
        return 0
    try:
        return _dispatch(args)
    except UsageError as exc:
        print(str(exc), file=sys.stderr)
        return exc.code


@dataclass
class RunOptions:
    agent: str = "__config__"
    target: str = ""
    command: str = ""
    log_dir: str = ""
    run_id: str = ""
    model: str = ""
    command_explicit: bool = False
    budget_usd: float = 0.0
    budget_explicit: bool = False
    label: str = ""


def _need_value(args: List[str], i: int, flag: str) -> str:
    if i + 1 >= len(args) or args[i + 1].startswith("--"):
        raise UsageError(f"{flag} requires a value")
    return args[i + 1]


def parse_run_options(args: List[str]) -> RunOptions:
    opts = RunOptions(target=os.getcwd())
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--agent":
            value = _need_value(args, i, "--agent")
            if value not in AGENTS:
                raise UsageError("--agent must be codex, claude, cursor, hermes, or custom")
            opts.agent = value; i += 2
        elif a == "--target":
            opts.target = _need_value(args, i, "--target"); i += 2
        elif a == "--command":
            opts.command = _need_value(args, i, "--command")
            opts.command_explicit = True; i += 2
        elif a == "--model":
            opts.model = _need_value(args, i, "--model"); i += 2
        elif a == "--log-dir":
            opts.log_dir = _need_value(args, i, "--log-dir"); i += 2
        elif a == "--run-id":
            opts.run_id = _need_value(args, i, "--run-id"); i += 2
        elif a == "--label":
            opts.label = _need_value(args, i, "--label"); i += 2
        elif a == "--budget-usd":
            raw = _need_value(args, i, "--budget-usd")
            try:
                opts.budget_usd = float(raw)
            except ValueError:
                raise UsageError("--budget-usd must be a non-negative number")
            # float('-1.5') parses fine — the sign needs its own check.
            if opts.budget_usd < 0:
                raise UsageError("--budget-usd must be a non-negative number")
            opts.budget_explicit = True
            i += 2
        elif a in ("-h", "--help"):
            print(_usage()); raise UsageError("", code=0)
        else:
            raise UsageError(f"Unknown option: {a}")
    return opts


def _read_config(target: str) -> dict:
    path = Path(target) / ".agentrail" / "config.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except (ValueError, OSError):
        return {}


def resolve_default_budget(target: str) -> float:
    """Return `budgets.per_issue_usd` from .agentrail/config.json, or 0.0.

    A bad value (non-numeric, negative) warns to stderr and is ignored — a
    broken config must never crash or silently cap a run.
    """
    cfg = _read_config(target)
    raw = (cfg.get("budgets") or {}).get("per_issue_usd") if cfg else None
    if raw is None:
        return 0.0
    # JSON true/false would float() to 1.0/0.0 — treat booleans as non-numeric.
    if isinstance(raw, bool):
        value = None
    else:
        try:
            value = float(raw)
        except (TypeError, ValueError):
            value = None
    if value is None or value < 0:
        print(f"warning: ignoring invalid budgets.per_issue_usd in "
              f".agentrail/config.json: {raw!r} (must be a non-negative number)",
              file=sys.stderr)
        return 0.0
    return value


def effective_budget(opts: RunOptions) -> float:
    """Effective per-issue budget: explicit --budget-usd (0 disables the cap,
    overriding any config default) > budgets.per_issue_usd > 0 (uncapped)."""
    if opts.budget_explicit:
        return opts.budget_usd
    return resolve_default_budget(opts.target)


def resolve_agent_name(target: str, fallback: str) -> str:
    if fallback != "__config__":
        return fallback
    cfg = _read_config(target)
    if cfg:
        return (cfg.get("runner") or {}).get("name") or "codex"
    return "codex"


def resolve_agent_command(agent: str, explicit: str, target: str) -> str:
    if explicit:
        return explicit
    cfg = _read_config(target)
    if cfg and agent == "__config__":
        return (cfg.get("runner") or {}).get("command") or ""
    if cfg:
        runners = cfg.get("runners") or {}
        cmd = (runners.get(agent) or {}).get("command")
        if cmd:
            return cmd
    env_specific = os.environ.get(ENV_NAMES.get(agent, ""))
    if env_specific:
        return env_specific
    generic = os.environ.get("AGENTRAIL_AGENT_COMMAND")
    if generic:
        return generic
    return DEFAULT_COMMANDS.get(agent, "")


def resolve_model_from_config(agent: str, target: str, phase: str = "") -> str:
    """Return the model string from config for agent/phase, or '' if unset.

    Precedence: runners.<agent>.models[phase] > runners.<agent>.model > ''
    """
    cfg = _read_config(target)
    if not cfg:
        return ""
    runners = cfg.get("runners") or {}
    runner_cfg = runners.get(agent) or {}
    if phase:
        models_map = runner_cfg.get("models") or {}
        if phase in models_map:
            return models_map[phase]
    return runner_cfg.get("model") or ""


def resolve_model_for_phase(agent: str, model_flag: str, target: str, phase: str) -> str:
    """Resolve the effective model for a phase.

    Precedence: --model flag > runners.<agent>.models[phase] > runners.<agent>.model > ''
    """
    if model_flag:
        return model_flag
    return resolve_model_from_config(agent, target, phase)


def verifier_candidate_models(agent: str, target: str) -> List[str]:
    """Candidate models for the Independent Verifier, in preference order.

    The Verifier must run on a DIFFERENT model than the Implementer (AC1, #782).
    Candidates come from the runner config: an explicit ``models.verify`` first,
    then every other per-phase model, then the flat ``model``. The pure
    ``verifier.select_verifier_model`` picks the first that differs from the
    implementer's model; an empty list (or no distinct model) means no verifier
    runs.
    """
    cfg = _read_config(target)
    runner_cfg = ((cfg.get("runners") or {}).get(agent) or {}) if cfg else {}
    models_map = runner_cfg.get("models") or {}
    candidates: List[str] = []
    verify_model = models_map.get("verify")
    if verify_model:
        candidates.append(str(verify_model))
    for phase, model in models_map.items():
        if phase == "verify" or not model:
            continue
        candidates.append(str(model))
    flat = runner_cfg.get("model")
    if flat:
        candidates.append(str(flat))
    return candidates


def resolve_verifier_command(
    agent: str, command: str, model_flag: str, target: str
) -> str:
    """Build the verify-phase command on a model DIFFERENT from the Implementer.

    Returns ``""`` when no distinct verifier model is available (then no verify
    phase runs — Independent Verification requires a different model, #782). The
    Implementer's model is the resolved ``execute``-phase model.
    """
    from agentrail.run.verifier import select_verifier_model

    implementer_model = resolve_model_for_phase(agent, model_flag, target, "execute")
    chosen = select_verifier_model(
        implementer_model, verifier_candidate_models(agent, target)
    )
    if not chosen:
        return ""
    return append_model_to_command(command, agent, chosen)


def append_model_to_command(command: str, agent: str, model: str) -> str:
    """Append model flag to command string; return command unchanged when model is empty.

    The command string is later evaluated by ``bash -lc``, so the model token
    is shell-quoted — a config/flag value with metacharacters must never
    become shell code.
    """
    if not model:
        return command
    import shlex
    quoted = shlex.quote(model)
    if agent == "codex":
        return f"{command} -m {quoted}"
    return f"{command} --model {quoted}"


def ensure_command_available(command_line: str) -> None:
    import shutil
    binary = command_line.split()[0] if command_line.strip() else ""
    if not binary:
        raise UsageError("runner command is empty")
    if shutil.which(binary) is None:
        raise UsageError(f"missing required command: {binary}", code=1)


def is_source_checkout(target: str) -> bool:
    p = Path(target)
    pkg = p / "package.json"
    if not pkg.exists():
        return False
    if not (p / "templates" / "scripts").is_dir():
        return False
    exe = p / "scripts" / "agentrail"
    if not (exe.exists() and os.access(exe, os.X_OK)):
        return False
    try:
        return json.loads(pkg.read_text()).get("name") == "@bensigo/agentrail"
    except (ValueError, OSError):
        return False


def ensure_source_run_allowed(target: str, action: str) -> None:
    if is_source_checkout(target) and os.environ.get("AGENTRAIL_ALLOW_SOURCE_RUN") != "1":
        raise UsageError(
            f"Refusing to {action} in the AgentRail source checkout.\n\n"
            "This repo is the AgentRail package source, not an installed target "
            "project. Use a real target project, or set AGENTRAIL_ALLOW_SOURCE_RUN=1 "
            "only for deliberate source dogfooding.",
            code=1,
        )


def active_run_issue(target: str):
    path = Path(target) / ".agentrail" / "state.json"
    if not path.exists():
        return None
    try:
        state = json.loads(path.read_text())
    except (ValueError, OSError):
        return None
    workflow = state.get("workflow") or {}
    run = workflow.get("activeRun")
    if not isinstance(run, dict):
        return None
    issue = run.get("targetIssue")
    if issue is None:
        issue = workflow.get("activeIssue")
    return None if issue is None else str(issue)


def ensure_no_conflicting_active_run(target: str, issue: str) -> None:
    active = active_run_issue(target)
    if active is None:
        return
    if active == issue:
        print(f"active run already exists for issue #{issue}; resume or inspect it "
              f"with: agentrail run --target {target}", file=sys.stderr)
    else:
        print(f"active run already exists for issue #{active}; refusing to start "
              f"issue #{issue}", file=sys.stderr)
    raise UsageError("", code=1)


def next_pickable_issue(target: str):
    proc = subprocess.run(
        ["gh", "issue", "list", "--state", "open", "--label", "afk",
         "--label", "ready-for-agent", "--search",
         "sort:created-asc -label:afk-in-progress", "--limit", "20",
         "--json", "number,title,url"],
        cwd=target, check=False, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return None
    try:
        issues = json.loads(proc.stdout or "[]")
    except ValueError:
        return None
    if not issues:
        return None
    best = min(issues, key=lambda it: int(it["number"]))
    return (int(best["number"]), best.get("title", ""), best.get("url", ""))


def _repo_dir() -> Path:
    from agentrail.cli.main import _repo_dir as resolve
    return resolve()


def exec_issue(issue: int, opts: RunOptions, *, allow_source: bool = False) -> int:
    # allow_source is retained for call-site compatibility (run_batch passes it)
    # but is no longer needed — the native pipeline has no source guard here;
    # guards run in _dispatch / run_batch before exec_issue is called.
    from agentrail.run.pipeline import run_issue
    agent = resolve_agent_name(opts.target, opts.agent)
    command = resolve_agent_command(agent, opts.command, opts.target)
    target = Path(opts.target).resolve()
    log_dir = Path(opts.log_dir) if opts.log_dir else None

    # Build per-phase command overrides. Skip when --command was explicit — the
    # user owns that string entirely and we never mutate it.
    phase_commands: Dict[str, str] = {}
    if not opts.command_explicit:
        # The MVP flow is test-author → execute (the plan phase is gone); keep a
        # "plan" override resolvable for any dormant caller, but the live phases
        # are test-author and execute.
        for phase in ("test-author", "execute"):
            model = resolve_model_for_phase(agent, opts.model, str(target), phase)
            if model:
                phase_commands[phase] = append_model_to_command(command, agent, model)
        # Independent Verifier (#782): a DIFFERENT-model verify command. Only set
        # when a model distinct from the Implementer's is available — otherwise
        # the pipeline runs no verify phase (AC1: never a same-model verifier).
        # VERIFY_GATE layer (eval ablation): when OFF, never build the verify
        # command, so no verify phase runs. ABSENT/"1" = ON = today's behavior.
        if layer_enabled("VERIFY_GATE"):
            verify_command = resolve_verifier_command(
                agent, command, opts.model, str(target)
            )
            if verify_command:
                phase_commands["verify"] = verify_command

    return run_issue(target, issue, agent=agent, command=command,
                     repo_dir=_repo_dir(), log_dir=log_dir,
                     run_id=opts.run_id, phase_commands=phase_commands,
                     budget_usd=effective_budget(opts))


def _phase_commands_for(opts: "RunOptions", agent: str, command: str, target: Path) -> Dict[str, str]:
    """Per-phase command overrides (model split + Independent Verifier).

    Single source of truth shared by ``exec_issue`` and ``exec_prompt`` so the
    SAME model-routing / verifier-selection rules apply in both modes — prompt
    mode never weakens the gate by silently dropping the distinct-model verify
    phase. Returns ``{}`` when ``--command`` was explicit (the user owns the
    command string and we never mutate it)."""
    phase_commands: Dict[str, str] = {}
    if opts.command_explicit:
        return phase_commands
    # MVP flow is test-author → execute (plan is gone); keep a "plan" override
    # resolvable for any dormant caller, but the live phases are these two.
    for phase in ("test-author", "execute"):
        model = resolve_model_for_phase(agent, opts.model, str(target), phase)
        if model:
            phase_commands[phase] = append_model_to_command(command, agent, model)
    # Independent Verifier (#782): only a DIFFERENT-model verify command.
    # VERIFY_GATE layer (eval ablation): when OFF, never build the verify command
    # so no verify phase runs. ABSENT/"1" = ON = today's behavior.
    if layer_enabled("VERIFY_GATE"):
        verify_command = resolve_verifier_command(agent, command, opts.model, str(target))
        if verify_command:
            phase_commands["verify"] = verify_command
    return phase_commands


def exec_prompt(prompt: str, opts: RunOptions) -> int:
    """Run the pipeline on a raw prompt (#968), not a numbered GitHub issue.

    Mirrors :func:`exec_issue` exactly — same agent/command/model resolution and
    the SAME per-phase command overrides — then delegates to
    ``pipeline.run_prompt`` so every phase and the Objective Gate run identically
    to issue mode. ``opts.label`` (default ``"prompt"``) is the non-numeric id
    used for the run-id and prompt/path framing."""
    from agentrail.run.pipeline import run_prompt
    agent = resolve_agent_name(opts.target, opts.agent)
    command = resolve_agent_command(agent, opts.command, opts.target)
    target = Path(opts.target).resolve()
    log_dir = Path(opts.log_dir) if opts.log_dir else None
    label = opts.label or "prompt"

    phase_commands = _phase_commands_for(opts, agent, command, target)

    return run_prompt(target, prompt, label=label, agent=agent, command=command,
                      repo_dir=_repo_dir(), log_dir=log_dir,
                      run_id=opts.run_id, phase_commands=phase_commands,
                      budget_usd=effective_budget(opts))


@dataclass
class BatchConfig:
    issues: List[int] = field(default_factory=list)
    concurrency: int = 2
    agent: str = "claude"
    target: str = ""
    command: str = ""
    base: str = "main"
    model: str = ""


def parse_batch_args(args: List[str]) -> BatchConfig:
    cfg = BatchConfig(
        concurrency=int(os.environ.get("AGENTRAIL_BATCH_CONCURRENCY", "2") or "2"),
        target=os.getcwd(),
    )
    raw_issues: List[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--concurrency":
            raw = _need_value(args, i, "--concurrency")
            try:
                cfg.concurrency = int(raw)
            except ValueError:
                raise UsageError("--concurrency must be a positive integer")
            i += 2
        elif a == "--agent":
            value = _need_value(args, i, "--agent")
            if value not in AGENTS:
                raise UsageError("--agent must be codex, claude, cursor, hermes, or custom")
            cfg.agent = value; i += 2
        elif a == "--target":
            cfg.target = _need_value(args, i, "--target"); i += 2
        elif a == "--command":
            cfg.command = _need_value(args, i, "--command"); i += 2
        elif a == "--model":
            cfg.model = _need_value(args, i, "--model"); i += 2
        elif a == "--base":
            cfg.base = _need_value(args, i, "--base"); i += 2
        elif a == "--":
            raw_issues.extend(args[i + 1:]); break
        elif a.startswith("-"):
            raise UsageError(f"run batch: unknown option {a}")
        else:
            raw_issues.append(a); i += 1
    cfg.issues = [int(x) for x in raw_issues if x.isdigit()]
    if not cfg.issues:
        raise UsageError("run batch requires at least one issue number")
    if cfg.concurrency < 1:
        raise UsageError("--concurrency must be a positive integer")
    return cfg


def _git_fetch(target: str, base: str) -> None:
    subprocess.run(["git", "-C", target, "fetch", "origin", base],
                   check=False, capture_output=True)


def _git_worktree_add(target: str, path: str, ref: str) -> None:
    subprocess.run(["git", "-C", target, "worktree", "add", "--detach", path, ref],
                   check=False, capture_output=True)


def _git_worktree_remove(target: str, path: str) -> None:
    subprocess.run(["git", "-C", target, "worktree", "remove", "--force", path],
                   check=False, capture_output=True)


def _seed_agentrail(target: str, worktree: str) -> None:
    src = Path(target) / ".agentrail"
    if src.is_dir():
        shutil.copytree(src, Path(worktree) / ".agentrail", dirs_exist_ok=True)


def run_batch(args: List[str]) -> int:
    cfg = parse_batch_args(args)
    cfg.target = str(Path(cfg.target).resolve())
    ensure_source_run_allowed(cfg.target, "run batch")
    command = resolve_agent_command(cfg.agent, cfg.command, cfg.target)
    ensure_command_available(command)

    import datetime as _dt
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    batch_dir = Path(cfg.target) / ".agentrail" / "batch" / stamp
    (batch_dir / "worktrees").mkdir(parents=True, exist_ok=True)
    print(f"batch: {len(cfg.issues)} issues, concurrency {cfg.concurrency}, agent {cfg.agent}")
    _git_fetch(cfg.target, cfg.base)

    worktrees: List[str] = []
    _wt_lock = threading.Lock()

    def _one(slot_issue):
        slot, issue = slot_issue
        wt = str(batch_dir / "worktrees" / f"slot-{slot}-issue-{issue}")
        with _wt_lock:
            worktrees.append(wt)
        _git_worktree_add(cfg.target, wt, f"origin/{cfg.base}")
        _seed_agentrail(cfg.target, wt)
        opts = RunOptions(agent=cfg.agent, target=wt, command=cfg.command,
                          command_explicit=bool(cfg.command), model=cfg.model)
        rc = exec_issue(issue, opts, allow_source=True)
        print(f"batch: issue #{issue} {'completed' if rc == 0 else 'failed'}")
        return rc

    try:
        with ThreadPoolExecutor(max_workers=cfg.concurrency) as pool:
            results = list(pool.map(_one, list(enumerate(cfg.issues, start=1))))
    finally:
        for wt in worktrees:
            _git_worktree_remove(cfg.target, wt)

    if any(rc != 0 for rc in results):
        print(f"batch: some issues failed; check {batch_dir}", file=sys.stderr)
        return 1
    print(f"batch: all {len(cfg.issues)} issues completed successfully")
    return 0


def _dispatch(args: List[str]) -> int:
    if args and args[0] == "issue":
        rest = args[1:]
        if not rest or rest[0].startswith("--"):
            raise UsageError("run issue requires a number")
        issue_arg = rest[0]
        if not issue_arg.isdigit():
            raise UsageError("run issue argument must be numeric")
        opts = parse_run_options(rest[1:])
        opts.target = str(Path(opts.target).resolve())
        opts.agent = resolve_agent_name(opts.target, opts.agent)
        ensure_source_run_allowed(opts.target, f"run issue #{issue_arg}")
        ensure_no_conflicting_active_run(opts.target, issue_arg)
        command = resolve_agent_command(opts.agent, opts.command, opts.target)
        ensure_command_available(command)
        opts.command = command
        return exec_issue(int(issue_arg), opts)

    if args and args[0] == "prompt":
        rest = args[1:]
        if not rest or rest[0].startswith("--"):
            raise UsageError('run prompt requires a prompt: agentrail run prompt "TEXT"')
        prompt_text = rest[0]
        opts = parse_run_options(rest[1:])
        opts.target = str(Path(opts.target).resolve())
        opts.agent = resolve_agent_name(opts.target, opts.agent)
        ensure_source_run_allowed(opts.target, "run prompt")
        command = resolve_agent_command(opts.agent, opts.command, opts.target)
        ensure_command_available(command)
        opts.command = command
        return exec_prompt(prompt_text, opts)

    if args and args[0] == "batch":
        return run_batch(args[1:])

    # bare `run`: select next queued issue
    opts = parse_run_options(args)
    opts.target = str(Path(opts.target).resolve())
    ensure_source_run_allowed(opts.target, "select queued issues")
    picked = next_pickable_issue(opts.target)
    if picked is None:
        print("No pickable GitHub issues found.")
        print("Required labels: afk, ready-for-agent")
        print("Excluded label: afk-in-progress")
        return 0
    number, title, url = picked
    print(f"selected issue #{number}: {title}")
    if url:
        print(url)
    opts.agent = resolve_agent_name(opts.target, opts.agent)
    ensure_no_conflicting_active_run(opts.target, str(number))
    command = resolve_agent_command(opts.agent, opts.command, opts.target)
    ensure_command_available(command)
    opts.command = command
    return exec_issue(number, opts)
