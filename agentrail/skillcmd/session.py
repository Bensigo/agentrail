"""The skill-backed agent-session primitive.

``run_skill_session`` loads a shipped ``SKILL.md`` verbatim, assembles a seed
prompt (skill body + ``CONTEXT.md`` always + optional ``TASTE.md``/ADRs + the
resolved input refs), and invokes the configured agent:

* **interactive (default)** — derive the agent's interactive command from
  ``INTERACTIVE_COMMANDS`` and exec it with inherited stdio so the agent owns
  the TTY and can quiz the user one question at a time.
* **headless** (``--headless``/``--yes``) — reuse the resolved headless command,
  feed the seed prompt on stdin (as ``run`` does), and exit with the agent's
  code.

Agent resolution (``resolve_agent_name`` / ``resolve_agent_command``) is reused
from ``cli/commands/run.py`` — the env/``config.json`` override points are not
duplicated here.
"""
from __future__ import annotations

import shlex
import subprocess
import sys
from pathlib import Path
from typing import List, Optional, Tuple

from agentrail.cli.commands.run import (
    AGENTS,
    DEFAULT_COMMANDS,
    ENV_NAMES,
    UsageError,
    resolve_agent_command,
    resolve_agent_name,
)
from agentrail.run.proc import sanitized_env
from agentrail.skillcmd.prompts import build_seed_prompt

# Interactive forms of each agent CLI, mirroring DEFAULT_COMMANDS. The headless
# commands feed the prompt on stdin and run unattended; the interactive forms
# below own the TTY and take the seed prompt as the initial message.
#
# Open question (spec §, slice 1): how does each installed agent accept the seed
# in interactive mode? Verified against the shipped CLIs:
#   - claude: interactive == headless minus `-p`. The initial user message is
#     passed as a trailing positional arg (`claude [message]`); the
#     permissions flag is retained. We pass the seed as that positional.
#   - codex: `codex` (interactive TUI) instead of `codex exec`; the initial
#     prompt is the trailing positional (`codex [prompt]`). The headless
#     `--sandbox danger-full-access` is an `exec`-subcommand flag and is NOT
#     carried into the bare TUI form — an interactive user approves actions
#     live, so the unattended sandbox override does not apply.
# `custom`/`cursor`/`hermes` have no first-class interactive form here, so they
# fall back to headless with a printed warning (see _derive_interactive).
INTERACTIVE_COMMANDS = {
    "codex": "codex",
    "claude": "claude --dangerously-skip-permissions",
    "cursor": "",
    "hermes": "",
    "custom": "",
}


def _interactive_default(agent: str, headless_command: str) -> str:
    """Derive an interactive command line for *agent* from its headless form.

    Prefers an explicit ``INTERACTIVE_COMMANDS`` entry. When none exists we
    transform the resolved headless command structurally so user/env/config
    overrides still flow through:
      - drop a leading ``-p`` flag (claude-style headless toggle),
      - rewrite a ``codex exec`` head to ``codex``.
    Returns '' when no interactive form can be derived.
    """
    builtin = INTERACTIVE_COMMANDS.get(agent, "")
    # Agents with no built-in interactive form (custom/cursor/hermes) have no
    # rule to derive one — return '' so the caller falls back to headless with
    # a warning. We only structurally transform agents we know (claude/codex).
    if not builtin.strip():
        return ""
    # Use the builtin when the headless command is the stock default — otherwise
    # the user overrode it and we must transform *their* command so their
    # flags/binary are preserved.
    if headless_command.strip() == DEFAULT_COMMANDS.get(agent, "").strip():
        return builtin

    try:
        tokens = shlex.split(headless_command)
    except ValueError:
        tokens = headless_command.split()
    if not tokens:
        return builtin

    # codex exec -> codex
    if len(tokens) >= 2 and tokens[0] == "codex" and tokens[1] == "exec":
        tokens = [tokens[0]] + tokens[2:]
    # drop a `-p` headless toggle wherever it sits
    tokens = [t for t in tokens if t != "-p"]
    # drop a trailing stdin sentinel `-` (headless reads stdin; interactive doesn't)
    if tokens and tokens[-1] == "-":
        tokens = tokens[:-1]
    return " ".join(tokens)


def derive_command(agent: str, headless_command: str, headless: bool) -> Tuple[List[str], bool]:
    """Return ``(argv_prefix, is_interactive)`` for the invocation.

    *headless_command* is the already-resolved headless command line (from
    ``resolve_agent_command`` — env/config overrides applied). When *headless*
    is False we derive the interactive form; if no interactive form exists for
    this agent we fall back to headless and the caller prints a warning.

    The returned argv is the command **prefix only** — the seed prompt is
    appended by the caller (positional for interactive, stdin for headless).
    """
    if headless:
        try:
            return shlex.split(headless_command), False
        except ValueError:
            return headless_command.split(), False

    interactive = _interactive_default(agent, headless_command)
    if not interactive.strip():
        # No interactive form: fall back to headless.
        try:
            return shlex.split(headless_command), False
        except ValueError:
            return headless_command.split(), False
    try:
        return shlex.split(interactive), True
    except ValueError:
        return interactive.split(), True


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, ValueError):
        return ""


def load_skill_body(repo_dir: Path, skill_name: str) -> str:
    """Read ``skills/<skill_name>/SKILL.md`` verbatim from the CLI's own skills
    dir (the canonical shipped copy, not a project-mutable one)."""
    path = repo_dir / "skills" / skill_name / "SKILL.md"
    if not path.exists():
        raise UsageError(f"skill not found: {path}", code=1)
    body = _read_text(path)
    if not body.strip():
        raise UsageError(f"skill is empty: {path}", code=1)
    return body


def _resolve_input_refs(target: Path, input_refs: List[str]) -> List[Tuple[str, str]]:
    """Resolve each input ref to a ``(label, body)`` pair.

    A ref that names an existing file (absolute, or relative to *target*) is
    inlined verbatim under its path; anything else is treated as literal text.
    """
    resolved: List[Tuple[str, str]] = []
    for ref in input_refs:
        if not ref:
            continue
        candidate = Path(ref)
        if not candidate.is_absolute():
            candidate = target / ref
        if candidate.is_file():
            resolved.append((ref, _read_text(candidate)))
        else:
            resolved.append(("(inline)", ref))
    return resolved


def assemble_seed_prompt(
    repo_dir: Path,
    target: Path,
    skill_name: str,
    input_refs: List[str],
    extra_context: List[str],
) -> str:
    """Load the skill + house context off disk and frame the seed prompt.

    ``CONTEXT.md`` is always inlined (when present); *extra_context* names
    additional house files relative to *target* (e.g. ``TASTE.md``). Missing
    optional files are skipped silently.
    """
    skill_body = load_skill_body(repo_dir, skill_name)

    context_files: List[Tuple[str, str]] = []
    # CONTEXT.md is mandated by the house procedure — always inline it.
    for name in ["CONTEXT.md"] + list(extra_context):
        body = _read_text(target / name)
        if body.strip():
            context_files.append((name, body))

    input_pairs = _resolve_input_refs(target, input_refs)
    return build_seed_prompt(skill_name, skill_body, context_files, input_pairs)


def _repo_dir() -> Path:
    from agentrail.cli.main import _repo_dir as resolve
    return resolve()


def run_skill_session(
    skill_name: str,
    target_dir: str,
    input_refs: List[str],
    *,
    agent: str,
    command: str,
    headless: bool,
    extra_context: Optional[List[str]] = None,
    repo_dir: Optional[Path] = None,
    _subprocess=subprocess,
) -> int:
    """Load *skill_name* verbatim, assemble the seed prompt, and invoke the
    configured agent. Returns the agent's exit code.

    *agent* / *command* come from ``resolve_agent_name`` / ``resolve_agent_command``
    (the caller resolves them, mirroring ``run``). ``_subprocess`` is injectable
    for tests.
    """
    extra_context = extra_context or []
    repo = repo_dir or _repo_dir()
    target = Path(target_dir).resolve()

    seed = assemble_seed_prompt(repo, target, skill_name, input_refs, extra_context)

    argv, interactive = derive_command(agent, command, headless)
    if not argv:
        raise UsageError("runner command is empty")

    if not headless and not interactive:
        print(
            f"warning: agent '{agent}' has no interactive command; "
            "falling back to headless (no live grilling).",
            file=sys.stderr,
        )

    # Strip agent-session env markers (CLAUDECODE/CODEX_SESSION/…) so the child
    # agent starts a fresh session — same sanitization `run` applies via proc.py.
    env = sanitized_env()

    if interactive:
        # Interactive: append the seed as the initial positional message and
        # exec with inherited stdio so the agent owns the TTY.
        full = argv + [seed]
        proc = _subprocess.run(full, cwd=str(target), env=env)
        return proc.returncode

    # Headless: feed the seed prompt on stdin (as `run` does), inherit stdout/err.
    proc = _subprocess.run(argv, cwd=str(target), input=seed, text=True, env=env)
    return proc.returncode


__all__ = [
    "INTERACTIVE_COMMANDS",
    "AGENTS",
    "ENV_NAMES",
    "resolve_agent_name",
    "resolve_agent_command",
    "derive_command",
    "load_skill_body",
    "assemble_seed_prompt",
    "run_skill_session",
]
