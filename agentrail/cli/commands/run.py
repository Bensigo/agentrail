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


def _dispatch(args: List[str]) -> int:
    raise UsageError("not implemented")
