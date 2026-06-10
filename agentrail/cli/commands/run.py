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
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List

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
  agentrail run [--agent NAME] [--target DIR] [--command CMD] [--log-dir DIR]
  agentrail run issue N [--agent NAME] [--target DIR] [--command CMD] [--log-dir DIR]
  agentrail run batch [--concurrency N] [--agent NAME] [--target DIR]
                      [--command CMD] [--base BRANCH] [--] ISSUE [ISSUE ...]

Bare `run` selects the next queued GitHub issue (labels: afk, ready-for-agent;
excludes afk-in-progress) and runs it. `run issue N` runs a specific issue.
`run batch` runs several issues in parallel, each in its own git worktree.
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
            opts.command = _need_value(args, i, "--command"); i += 2
        elif a == "--log-dir":
            opts.log_dir = _need_value(args, i, "--log-dir"); i += 2
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


def _legacy_script() -> Path:
    from agentrail.cli.main import _legacy_script as resolve
    return resolve()


def exec_issue(issue: int, opts: RunOptions, *, allow_source: bool = False) -> int:
    argv = [str(_legacy_script()), "run", "issue", str(issue),
            "--target", opts.target, "--agent", opts.agent]
    if opts.command:
        argv += ["--command", opts.command]
    if opts.log_dir:
        argv += ["--log-dir", opts.log_dir]
    env = os.environ.copy()
    if allow_source:
        env["AGENTRAIL_ALLOW_SOURCE_RUN"] = "1"
    proc = subprocess.run(argv, env=env, check=False)
    return int(proc.returncode)


def _dispatch(args: List[str]) -> int:
    raise UsageError("not implemented")
