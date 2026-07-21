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
  agentrail issue create --connector github [--repo <owner/name>]
                         --title <t> --body <b>
  agentrail issue update --connector github [--repo <owner/name>]
                         --number <n> --title <t> --body <b>

Skill mode (default): launches the configured agent seeded with the to-issues
skill + CONTEXT.md + TASTE.md + triage-labels.md to break a milestone or PRD into
house-template GitHub issues and publish them. Interactive by default (the agent
quizzes you on the slice breakdown before publishing). --headless/--yes skips the
quiz and publishes without prompting. --dry-run prints what would be published.

Connector mode (--connector github): creates a single GitHub issue directly,
applying the ready-for-agent trigger label so the polling intake / heartbeat
picks it up. No agent, no gh CLI. --repo and the GitHub token both resolve the
same way: an explicit value wins (--repo <owner/name>; env GITHUB_OAUTH_TOKEN
or GITHUB_TOKEN) and otherwise falls back to whatever repo/token
AGENTRAIL_WORKSPACE_ID has connected on the AgentRail console (read from
Postgres via DATABASE_URL) — connecting a repo on the console is enough on its
own, no env vars required. Fails with a clear "connect a repo" error if
neither source resolves both.

``issue update --connector github``: edits an EXISTING issue's title/body in
place (house-format body edits only — no label/state/comment changes). --repo
and the token resolve identically to ``issue create``'s connector mode.
"""

# Env vars the connector path reads the user's GitHub OAuth access token from.
# Preferred name first; GITHUB_TOKEN is accepted as a fallback for convenience.
_GH_TOKEN_ENV = ("GITHUB_OAUTH_TOKEN", "GITHUB_TOKEN")


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
# Connector mode (GitHub OAuth: create one labeled issue directly)
# ---------------------------------------------------------------------------

# A single workspace context for this CLI process, used ONLY as the key for the
# Postgres fallback lookups below (workspace GitHub token / connected repo).
# Mirrors the Heartbeat daemon's established single-workspace convention
# (agentrail/cli/commands/heartbeat.py: --workspace / AGENTRAIL_WORKSPACE_ID)
# rather than inventing a second one — a self-hosted runner or a Jace
# deployment is already scoped to one workspace.
_WORKSPACE_ID_ENV = "AGENTRAIL_WORKSPACE_ID"

# Stable, greppable marker prefixed onto the UsageError message when neither a
# GitHub token nor a connected repo could be resolved for this workspace by ANY
# means (env, --repo flag, nor the Postgres fallback). Callers that shell out to
# this CLI (e.g. Jace's create_issue tool) match on this exact string in stderr
# to turn a raw CLI failure into a friendly "connect a repo first" message
# instead of surfacing a stack-trace-shaped error to the end user.
NOT_CONNECTED_MARKER = "AGENTRAIL_NOT_CONNECTED"
NOT_CONNECTED_EXIT_CODE = 3


def _github_oauth_token() -> Optional[str]:
    """Return the user's stored GitHub OAuth access token from the environment.

    Reads the preferred ``GITHUB_OAUTH_TOKEN`` first, then ``GITHUB_TOKEN``. The
    token originates from the NextAuth ``accounts`` table (the console exposes it
    to the CLI); here we accept it via env so the connector never shells out to
    the ``gh`` CLI (which needs its own separate auth).
    """
    for name in _GH_TOKEN_ENV:
        value = os.environ.get(name)
        if value:
            return value
    return None


def _resolve_workspace_connection(
    workspace_id: str, *, executor=None
) -> Tuple[Optional[str], Optional[str]]:
    """Resolve ``(token, repo)`` for ``workspace_id`` straight from Postgres —
    the SAME persistence seam (the QueueStore's ``Executor``, ``PostgresExecutor``
    in production) the Heartbeat daemon already uses, so there is one DB edge,
    not two:

      - token: the workspace owner's stored GitHub OAuth ``access_token``
        (``agentrail.heartbeat.token_provider.get_github_token`` — the Python
        twin of the TS ``getGithubToken``).
      - repo: the first repo in the workspace's enabled ``github`` connector
        (``agentrail.afk.connectors_store.get_active_connector``), which is
        exactly what "connect a repo" on the console writes (the repos route
        self-configures the connector on connect). The first entry is treated
        as the de facto default when more than one is connected — this mirrors
        the console's own claim-time resolver (``deriveRepoSlug``:
        ``cfg?.repos?.[0]``); there is no separate "default repo" field today.

    This is what lets the CLI (and Jace, which shells out to it) work off
    *only* "a repo is connected on the console" — no separately-supplied
    GITHUB_OAUTH_TOKEN/GITHUB_TOKEN/JACE_TARGET_REPO required.

    ``executor`` is injectable for tests. Any failure (no DATABASE_URL, no DB
    driver, a connection error) degrades to ``(None, None)`` rather than
    raising — a DB hiccup must surface as the same friendly "not connected"
    guidance as a genuinely unconfigured workspace, never a crash.
    """
    try:
        from agentrail.afk.connectors_store import get_active_connector
        from agentrail.heartbeat.token_provider import get_github_token

        if executor is None:
            from agentrail.afk.queue_store import PostgresExecutor

            executor = PostgresExecutor()

        token: Optional[str] = None
        try:
            token = get_github_token(workspace_id, executor)
        except Exception:
            token = None

        repo: Optional[str] = None
        try:
            gh = get_active_connector(workspace_id, "github", executor)
            if gh and gh.repos:
                repo = gh.repos[0]
        except Exception:
            repo = None

        return token, repo
    except Exception:
        return None, None


def _build_github_client(token: str, repo: str):
    """Construct the OAuth REST client (seam patched in tests)."""
    from agentrail.connectors.github import GitHubOAuthClient

    return GitHubOAuthClient(token=token, repos=[repo])


def _create_via_connector(
    *, connector: str, repo: Optional[str], title: Optional[str], body: Optional[str]
) -> int:
    """Create a single labeled issue on an external connector via OAuth (MVP).

    Currently supports ``github``: opens the issue with the ``ready-for-agent``
    trigger label via the user's OAuth token so the polling intake picks it up.

    Token and repo each resolve in the same order: an explicit value (``--repo``
    / the ``GITHUB_OAUTH_TOKEN``/``GITHUB_TOKEN`` env) wins when present;
    otherwise fall back to whatever "connecting a repo on the console" already
    wrote to Postgres for ``AGENTRAIL_WORKSPACE_ID`` (see
    :func:`_resolve_workspace_connection`). When NEITHER source resolves a repo,
    or NEITHER resolves a token, this raises a :class:`UsageError` carrying
    :data:`NOT_CONNECTED_MARKER` — callers that shell out to this CLI (Jace)
    match on that marker to show friendly "connect a repo first" guidance
    instead of a raw error.
    """
    if connector != "github":
        raise UsageError(f"--connector must be 'github' (got {connector!r})")
    if not title:
        raise UsageError("--connector github requires --title")
    if body is None:
        raise UsageError("--connector github requires --body")

    token = _github_oauth_token()
    resolved_repo = repo

    workspace_id = os.environ.get(_WORKSPACE_ID_ENV) or None
    if workspace_id and (not token or not resolved_repo):
        db_token, db_repo = _resolve_workspace_connection(workspace_id)
        token = token or db_token
        resolved_repo = resolved_repo or db_repo

    if not resolved_repo:
        raise UsageError(
            f"{NOT_CONNECTED_MARKER}: no GitHub repo is connected for this "
            "workspace (and no --repo was given). Connect a repo on the "
            "AgentRail console (Settings → Connectors → GitHub), or pass "
            "--repo <owner/name> explicitly.",
            code=NOT_CONNECTED_EXIT_CODE,
        )
    if not token:
        raise UsageError(
            f"{NOT_CONNECTED_MARKER}: no GitHub OAuth token is available for "
            "this workspace. Connect (or re-connect) GitHub on the AgentRail "
            "console, then try again — re-login grants the 'repo' scope. "
            "(GITHUB_OAUTH_TOKEN/GITHUB_TOKEN env also works, e.g. a manually "
            "configured PAT.)",
            code=NOT_CONNECTED_EXIT_CODE,
        )

    client = _build_github_client(token, resolved_repo)
    ref = client.create_issue(repo=resolved_repo, title=title, body=body)
    print(f"Created {ref.repo}#{ref.number} (label {TRIAGE_LABEL}): {ref.url}")
    return 0


def _update_via_connector(
    *, connector: str, repo: Optional[str], number: Optional[int],
    title: Optional[str], body: Optional[str]
) -> int:
    """Edit an EXISTING issue's title/body directly via OAuth (issue #1345).

    House-format body edits only — no label/state/comment changes. Token and
    repo resolve in the EXACT SAME order as :func:`_create_via_connector`
    (explicit --repo / GITHUB_OAUTH_TOKEN|GITHUB_TOKEN first, falling back to
    the workspace's Postgres-stored connection); see that function's own
    doc-comment for the full rationale. Raises the same
    :data:`NOT_CONNECTED_MARKER`-carrying :class:`UsageError` when neither
    source resolves both, so Jace's ``update_issue`` tool can show the same
    friendly "connect a repo first" guidance it already shows for create.
    """
    if connector != "github":
        raise UsageError(f"--connector must be 'github' (got {connector!r})")
    if not number:
        raise UsageError("--connector github requires --number")
    if not title:
        raise UsageError("--connector github requires --title")
    if body is None:
        raise UsageError("--connector github requires --body")

    token = _github_oauth_token()
    resolved_repo = repo

    workspace_id = os.environ.get(_WORKSPACE_ID_ENV) or None
    if workspace_id and (not token or not resolved_repo):
        db_token, db_repo = _resolve_workspace_connection(workspace_id)
        token = token or db_token
        resolved_repo = resolved_repo or db_repo

    if not resolved_repo:
        raise UsageError(
            f"{NOT_CONNECTED_MARKER}: no GitHub repo is connected for this "
            "workspace (and no --repo was given). Connect a repo on the "
            "AgentRail console (Settings → Connectors → GitHub), or pass "
            "--repo <owner/name> explicitly.",
            code=NOT_CONNECTED_EXIT_CODE,
        )
    if not token:
        raise UsageError(
            f"{NOT_CONNECTED_MARKER}: no GitHub OAuth token is available for "
            "this workspace. Connect (or re-connect) GitHub on the AgentRail "
            "console, then try again — re-login grants the 'repo' scope. "
            "(GITHUB_OAUTH_TOKEN/GITHUB_TOKEN env also works, e.g. a manually "
            "configured PAT.)",
            code=NOT_CONNECTED_EXIT_CODE,
        )

    client = _build_github_client(token, resolved_repo)
    ref = client.update_issue(repo=resolved_repo, number=number, title=title, body=body)
    print(f"Updated {ref.repo}#{ref.number}: {ref.url}")
    return 0


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
    if args[0] == "update":
        try:
            return _dispatch_update(args[1:])
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
    connector: Optional[str] = None
    repo: Optional[str] = None
    title: Optional[str] = None
    body: Optional[str] = None

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
        elif a == "--connector":
            connector = _need_value(args, i, "--connector")
            i += 2
        elif a == "--repo":
            repo = _need_value(args, i, "--repo")
            i += 2
        elif a == "--title":
            title = _need_value(args, i, "--title")
            i += 2
        elif a == "--body":
            # --body may legitimately be empty/start with markdown; take the
            # next token verbatim rather than the strict _need_value guard.
            if i + 1 >= len(args):
                raise UsageError("--body requires a value")
            body = args[i + 1]
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

    # Connector mode short-circuits the skill/agent path: create one labeled
    # issue directly on the external source via the user's OAuth token.
    if connector is not None:
        return _create_via_connector(
            connector=connector, repo=repo, title=title, body=body
        )

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


def _dispatch_update(args: List[str]) -> int:
    """Parse ``agentrail issue update ...``.

    Connector mode ONLY — unlike ``create``, there is no skill/agent mode for
    update (issue #1345's scope: a direct connector edit is all Jace's
    ``update_issue`` tool needs). ``--connector github`` is required.
    """
    connector: Optional[str] = None
    repo: Optional[str] = None
    number: Optional[int] = None
    title: Optional[str] = None
    body: Optional[str] = None

    i = 0
    while i < len(args):
        a = args[i]
        if a == "--connector":
            connector = _need_value(args, i, "--connector")
            i += 2
        elif a == "--repo":
            repo = _need_value(args, i, "--repo")
            i += 2
        elif a == "--number":
            raw_number = _need_value(args, i, "--number")
            try:
                number = int(raw_number)
            except ValueError:
                raise UsageError(f"--number must be an integer (got {raw_number!r})")
            i += 2
        elif a == "--title":
            title = _need_value(args, i, "--title")
            i += 2
        elif a == "--body":
            # --body may legitimately be empty/start with markdown; take the
            # next token verbatim rather than the strict _need_value guard.
            if i + 1 >= len(args):
                raise UsageError("--body requires a value")
            body = args[i + 1]
            i += 2
        elif a.startswith("--"):
            raise UsageError(f"Unknown option: {a}")
        else:
            raise UsageError(f"Unknown argument: {a}")

    if connector is None:
        raise UsageError("issue update requires --connector github")

    return _update_via_connector(
        connector=connector, repo=repo, number=number, title=title, body=body
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
