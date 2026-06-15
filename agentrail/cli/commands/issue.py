"""``agentrail issue create`` — publish house-template issues via the to-issues skill.

Binds the shipped ``to-issues`` skill to the skill-backed agent-session
primitive (``agentrail/skillcmd/session.py``). The agent is launched
interactively by default (it owns the TTY and quizzes the user on the slice
breakdown before publishing); ``--headless``/``--yes`` runs it unattended.

Interactive (default):
    Delegates to ``run_skill_session(headless=False)`` — the agent follows the
    skill procedure including publishing via ``gh``.

Headless:
    Assembles the seed prompt directly, runs the agent with captured stdout,
    parses ``<!-- ISSUE START --> ... <!-- ISSUE END -->`` delimiters out of
    the output, and either prints (``--dry-run``) or calls
    ``gh issue create --label ready-for-agent --body "..."`` per body.
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import List, Optional, Tuple

from agentrail.cli.commands.run import (
    AGENTS,
    UsageError,
    ensure_command_available,
    resolve_agent_command,
    resolve_agent_name,
)
from agentrail.run.proc import sanitized_env
from agentrail.skillcmd.session import (
    assemble_seed_prompt,
    derive_command,
    run_skill_session,
)

SKILL_NAME = "to-issues"
TRIAGE_LABEL = "ready-for-agent"
# House context files inlined into the seed prompt (beyond CONTEXT.md which
# assemble_seed_prompt always includes).
EXTRA_CONTEXT = ["TASTE.md", "docs/agents/triage-labels.md"]

# Appended to the seed prompt only in headless mode so the CLI can parse
# individual issue bodies from the agent's captured stdout.
_HEADLESS_OUTPUT_INSTRUCTION = """\

## Output instructions (headless mode) — READ CAREFULLY

You are running in headless (unattended) mode. Do EXACTLY this and nothing else:

1. Do NOT run ``gh``, ``git``, or any command that creates, edits, or publishes
   issues. You are NOT publishing anything yourself — the CLI publishes from your
   stdout after you finish. Running ``gh issue create`` will fail and is wrong.

2. Print each proposed issue's COMPLETE markdown body to stdout, wrapped between
   these exact marker lines, each on its own line. The FIRST line inside the body
   MUST be a TITLE marker with a short imperative issue title (<= 80 chars):

<!-- ISSUE START -->
<!-- TITLE: short imperative issue title -->
<full issue body here>
<!-- ISSUE END -->

3. Output ALL issues in dependency order (blockers first). The CLI parses the
   marker pairs to extract the title and publish each body, and applies the
   triage label ``{label}`` itself — you do not. Every issue MUST include its
   TITLE marker. Do not put the markers anywhere except around each body. After
   the last marker you may add a short plain-text summary for logs.
""".format(label=TRIAGE_LABEL)

_USAGE = """\
Usage:
  agentrail issue create <milestone-or-prd> [--agent codex|claude|cursor|hermes|custom]
                         [--target DIR] [--headless|--yes] [--dry-run]

Launches the configured agent seeded with the to-issues skill + CONTEXT.md +
TASTE.md + triage-labels.md to break a milestone or PRD into house-template
GitHub issues and publish them.

Interactive by default (the agent quizzes you on the slice breakdown before
publishing). --headless/--yes skips the quiz and publishes without prompting.
--dry-run prints what would be published without calling gh.
"""


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


_ISSUE_RE = re.compile(
    r"<!--\s*ISSUE START\s*-->(.*?)<!--\s*ISSUE END\s*-->",
    re.DOTALL | re.IGNORECASE,
)
_TITLE_RE = re.compile(r"<!--\s*TITLE:\s*(.*?)\s*-->", re.IGNORECASE)
_SECTION_HEADINGS = {
    "parent", "required context", "what to build", "acceptance criteria",
    "verification evidence", "verification", "blocked by",
}


def _derive_title(body: str) -> str:
    """Last-resort title when no ``<!-- TITLE: -->`` marker was emitted.

    Prefer the first markdown heading that is not a house-template section name;
    otherwise the first non-empty, non-marker line; otherwise a generic title.
    """
    for line in body.splitlines():
        s = line.strip()
        if s.startswith("#"):
            text = s.lstrip("# ").strip()
            if text and text.lower() not in _SECTION_HEADINGS:
                return text[:100]
    for line in body.splitlines():
        s = line.strip()
        if s and not s.startswith("<!--"):
            return s[:100]
    return "AgentRail issue"


def parse_issues(output: str) -> List[Tuple[str, str]]:
    """Extract ``(title, body)`` pairs from ``<!-- ISSUE START/END -->`` markers.

    Title comes from a leading ``<!-- TITLE: ... -->`` marker (stripped out of the
    body); when absent it is derived from the body. Empty bodies are discarded.
    """
    issues: List[Tuple[str, str]] = []
    for match in _ISSUE_RE.finditer(output):
        raw = match.group(1).strip()
        if not raw:
            continue
        title: Optional[str] = None
        tm = _TITLE_RE.search(raw)
        if tm:
            title = tm.group(1).strip() or None
            raw = _TITLE_RE.sub("", raw, count=1).strip()
        if not raw:
            continue
        issues.append((title or _derive_title(raw), raw))
    return issues


def parse_issue_bodies(output: str) -> List[str]:
    """Back-compat: just the bodies (see :func:`parse_issues`)."""
    return [body for _title, body in parse_issues(output)]


def publish_issue(body: str, target_dir: str, _subprocess=None, title: Optional[str] = None) -> int:
    """Call ``gh issue create`` with *title*, *body*, and the house triage label.

    A title is always passed (``gh`` requires one in non-interactive mode); when
    not supplied it is derived from the body. Returns the ``gh`` exit code.
    """
    import subprocess as _sp

    proc_module = _subprocess if _subprocess is not None else _sp
    title = title or _derive_title(body)
    result = proc_module.run(
        ["gh", "issue", "create", "--title", title, "--label", TRIAGE_LABEL, "--body", body],
        cwd=target_dir,
    )
    return result.returncode


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run_issue(args: List[str]) -> int:
    """Entry point for ``agentrail issue ...``."""
    if not args or args[0] in ("-h", "--help"):
        print(_USAGE, end="")
        return 0
    if args[0] == "create":
        try:
            return _dispatch_create(args[1:])
        except UsageError as exc:
            msg = str(exc)
            if msg:
                print(msg, file=sys.stderr)
            return exc.code
    print(f"Unknown issue subcommand: {args[0]}", file=sys.stderr)
    print(_USAGE, end="", file=sys.stderr)
    return 2


# ---------------------------------------------------------------------------
# Internal dispatch
# ---------------------------------------------------------------------------


def _need_value(args: List[str], i: int, flag: str) -> str:
    if i + 1 >= len(args) or args[i + 1].startswith("--"):
        raise UsageError(f"{flag} requires a value")
    return args[i + 1]


def _dispatch_create(args: List[str]) -> int:
    agent_flag = "__config__"
    target = os.getcwd()
    headless = False
    dry_run = False
    milestone: Optional[str] = None

    i = 0
    while i < len(args):
        a = args[i]
        if a == "--agent":
            value = _need_value(args, i, "--agent")
            if value not in AGENTS:
                raise UsageError("--agent must be codex, claude, cursor, hermes, or custom")
            agent_flag = value
            i += 2
        elif a == "--target":
            target = _need_value(args, i, "--target")
            i += 2
        elif a in ("--headless", "--yes"):
            headless = True
            i += 1
        elif a == "--dry-run":
            dry_run = True
            i += 1
        elif a.startswith("--"):
            raise UsageError(f"Unknown option: {a}")
        else:
            if milestone is not None:
                raise UsageError("issue create takes at most one milestone-or-prd argument")
            milestone = a
            i += 1

    target = str(Path(target).resolve())
    agent = resolve_agent_name(target, agent_flag)
    command = resolve_agent_command(agent, "", target)
    ensure_command_available(command)

    input_refs: List[str] = [milestone] if milestone else []

    if not headless:
        # Interactive path — agent owns the TTY and follows the skill procedure
        # (including publishing via gh). dry-run is advisory only here.
        if dry_run:
            print(
                "warning: --dry-run is only fully enforced in --headless mode; "
                "the agent may still publish in interactive mode.",
                file=sys.stderr,
            )
        return run_skill_session(
            SKILL_NAME,
            target,
            input_refs,
            agent=agent,
            command=command,
            headless=False,
            extra_context=EXTRA_CONTEXT,
        )

    # Headless path — capture agent stdout, parse delimiters, then print/publish.
    return _run_headless(
        agent=agent,
        command=command,
        target=target,
        input_refs=input_refs,
        dry_run=dry_run,
    )


def _repo_dir() -> Path:
    from agentrail.cli.main import _repo_dir as resolve
    return resolve()


def _run_headless(
    *,
    agent: str,
    command: str,
    target: str,
    input_refs: List[str],
    dry_run: bool,
    _subprocess=None,
    _repo=None,
) -> int:
    import subprocess as _sp

    proc_module = _subprocess if _subprocess is not None else _sp
    repo = _repo if _repo is not None else _repo_dir()
    target_path = Path(target)

    seed = assemble_seed_prompt(
        repo,
        target_path,
        SKILL_NAME,
        input_refs,
        EXTRA_CONTEXT,
    )
    seed = seed.rstrip("\n") + "\n" + _HEADLESS_OUTPUT_INSTRUCTION

    argv, _ = derive_command(agent, command, headless=True)
    if not argv:
        raise UsageError("runner command is empty")

    env = sanitized_env()
    proc = proc_module.run(
        argv,
        cwd=target,
        input=seed,
        text=True,
        capture_output=True,
        env=env,
    )

    if proc.returncode != 0:
        sys.stderr.write(proc.stderr or "")
        return proc.returncode

    output = proc.stdout or ""
    issues = parse_issues(output)

    if not issues:
        # Fail loudly: a headless run that published nothing must NOT look like
        # success. The usual cause is the agent ignoring the output contract and
        # trying to run `gh issue create` itself.
        print(
            "error: agent produced no issue bodies "
            "(expected <!-- ISSUE START --> / <!-- ISSUE END --> markers); "
            "nothing was published.",
            file=sys.stderr,
        )
        sys.stderr.write(output)
        return 1

    if dry_run:
        for idx, (title, body) in enumerate(issues, 1):
            print(f"--- Issue {idx} (dry-run) — {title} ---")
            print(body)
            print()
        return 0

    overall_rc = 0
    for title, body in issues:
        rc = publish_issue(body, target, proc_module, title=title)
        if rc != 0:
            overall_rc = rc
    return overall_rc
