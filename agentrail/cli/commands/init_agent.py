"""
``agentrail init <claude|cursor|codex> [--target DIR]`` — wire MCP + hook/steering.

Claude  → .mcp.json + context-first PreToolUse hook (enforcement layer)
Cursor  → .cursor/mcp.json + AGENTS.md steering block
Codex   → .codex/config.toml + AGENTS.md steering block

Reads API key from AGENTRAIL_API_KEY env, falls back to .agentrail/config.json
``apiKey`` field. Idempotent: re-run adds no duplicate config. Prints what was
wired and where the key came from (never echoes the value).
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional


_AGENTS = ("claude", "codex", "cursor")

_USAGE = """\
Usage: agentrail init <claude|cursor|codex> [--target DIR] [--force]

Wire the AgentRail context engine for a specific AI agent.

  claude  — writes .mcp.json + context-first PreToolUse hook
  cursor  — writes .cursor/mcp.json + AGENTS.md steering
  codex   — writes .codex/config.toml + AGENTS.md steering

Options:
  --target DIR   Project directory to configure. Defaults to current directory.
  --force        Re-write our config even if already wired (replaces in place).
  --print        Preview every change without writing anything (alias --dry-run).
  -h, --help     Show this help.

Existing files are never clobbered: edits are surgical (only our managed block /
our one JSON key), atomic, and back up the prior file to ``<name>.bak``. A config
that cannot be parsed is left untouched and the snippet is printed for you.\
"""

# Stable markers for idempotent AGENTS.md steering block.
_STEERING_START = "<!-- agentrail-mcp:start -->"
_STEERING_END = "<!-- agentrail-mcp:end -->"

_STEERING_BLOCK = """\
<!-- agentrail-mcp:start -->
## Context Retrieval (AgentRail MCP)

AgentRail's context engine is wired via MCP. Prefer these tools over raw file
search — they return ranked, bounded context with citations:

- `context_search "<query>"` — ranked candidates with path, line range, score
- `context_get <path> --lines A-B` — only the line range you need
- `context_build_pack` — bounded context pack for an issue or PR phase
- `context_explain_pack` — why sources were included or excluded

Use one focused `context_search`, then `context_get` only what you need.
For token efficiency, prefer the `agentrail context` CLI when available (lower
protocol overhead than MCP). The MCP is for agents that prefer native tools.
<!-- agentrail-mcp:end -->"""


class UsageError(Exception):
    def __init__(self, message: str, code: int = 2) -> None:
        super().__init__(message)
        self.code = code


def _repo_dir() -> Path:
    from agentrail.cli.main import _repo_dir as resolve
    return resolve()


def _resolve_api_key(target_dir: Path) -> tuple[Optional[str], Optional[str]]:
    """Return (api_key, source) where source is 'env', 'config', or None."""
    key = os.environ.get("AGENTRAIL_API_KEY")
    if key:
        return key, "env"
    config_path = target_dir / ".agentrail" / "config.json"
    if config_path.exists():
        try:
            cfg = json.loads(config_path.read_text())
            if isinstance(cfg, dict) and cfg.get("apiKey"):
                return cfg["apiKey"], "config"
        except (OSError, ValueError):
            pass
    return None, None


def _mcp_server_entry(repo_dir: Path, target_dir: Path, api_key: Optional[str]) -> Dict:
    """Build the ``mcpServers.agentrail-context`` dict."""
    mcp_dist = repo_dir / "packages" / "mcp" / "dist" / "index.js"
    agentrail_bin = repo_dir / "scripts" / "agentrail"
    env: Dict[str, str] = {
        "AGENTRAIL_BIN": str(agentrail_bin),
        "AGENTRAIL_TARGET": str(target_dir),
    }
    if api_key:
        env["AGENTRAIL_API_KEY"] = api_key
    return {
        "command": "node",
        "args": [str(mcp_dist)],
        "env": env,
    }


# ---------------------------------------------------------------------------
# Safe file writing — atomic, backed-up, managed-block (never clobber user data)
# ---------------------------------------------------------------------------


def _atomic_write(path: Path, content: str, backup: bool) -> None:
    """Write *content* to *path* via temp-file + rename (never a half file).

    When *backup* is set and the file already exists, the prior contents are
    copied to ``<name>.bak`` first so the user can always recover.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if backup and path.exists():
        shutil.copy2(path, path.with_name(path.name + ".bak"))
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix="." + path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(content)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _emit(path: Path, content: Optional[str], dry_run: bool, label: str) -> str:
    """Apply a computed file write and return a human-readable status line.

    ``content is None`` means "already wired, nothing to do". Otherwise the file
    is written atomically (backing up any prior contents); under *dry_run* the
    would-be result is printed instead and nothing is written.
    """
    if content is None:
        return f"skipped: {label} (already wired; use --force to overwrite)"
    old = path.read_text() if path.exists() else None
    if old == content:
        return f"unchanged: {label}"
    if dry_run:
        print(f"--- would write {label}: {path} ---")
        print(content, end="" if content.endswith("\n") else "\n")
        return f"(dry-run) would {'update' if old is not None else 'write'} {label}"
    _atomic_write(path, content, backup=old is not None)
    if old is not None:
        return f"updated: {label} (previous saved to {path.name}.bak)"
    return f"wired: {label}"


def _replace_between(text: str, start: str, end: str, replacement: str) -> str:
    """Replace the region from *start* to *end* (inclusive) with *replacement*.

    *replacement* already contains its own start/end markers. Surrounding
    content — before and after the managed block — is preserved verbatim, so we
    edit only our region and never reformat the rest of the file.
    """
    pre, _, rest = text.partition(start)
    _, _, post = rest.partition(end)
    pre = pre.rstrip("\n")
    post = post.lstrip("\n")
    out = (pre + "\n\n") if pre else ""
    out += replacement.rstrip("\n") + "\n"
    if post:
        out += "\n" + post
    return out


# ---------------------------------------------------------------------------
# Per-format content builders (pure: compute the new file text, write nothing)
# ---------------------------------------------------------------------------


def _detect_json_indent(raw: str) -> int:
    """Best-effort detection of an existing file's indent width (default 2)."""
    for line in raw.splitlines():
        if line.startswith(" "):
            return len(line) - len(line.lstrip(" "))
    return 2


def _manual_json_hint(path: Path, server_entry: Dict) -> str:
    snippet = json.dumps({"mcpServers": {"agentrail-context": server_entry}}, indent=2)
    return (
        f"Could not parse {path} as JSON, so it was left untouched to avoid "
        f"dropping your other config. Add this manually under \"mcpServers\":\n"
        f"{snippet}"
    )


def _mcp_json_content(path: Path, server_entry: Dict, force: bool) -> Optional[str]:
    """Compute merged ``.mcp.json`` text, preserving every other key.

    Returns None when already wired (and not forced). Refuses (raises) when the
    existing file is present but unparseable — never silently discards it.
    """
    existing: Dict = {}
    indent = 2
    if path.exists():
        raw = path.read_text()
        try:
            existing = json.loads(raw)
        except (OSError, ValueError):
            raise UsageError(_manual_json_hint(path, server_entry))
        if not isinstance(existing, dict):
            raise UsageError(
                f"refusing to modify {path}: top-level JSON is not an object.\n"
                + _manual_json_hint(path, server_entry)
            )
        indent = _detect_json_indent(raw)
        if not force and "agentrail-context" in existing.get("mcpServers", {}):
            return None
    existing.setdefault("mcpServers", {})["agentrail-context"] = server_entry
    return json.dumps(existing, indent=indent) + "\n"


_CODEX_START = "# >>> agentrail-context (managed by `agentrail init`) >>>"
_CODEX_END = "# <<< agentrail-context <<<"
_CODEX_HEADERS = (
    "[mcp.servers.agentrail-context]",
    "[mcp.servers.agentrail-context.env]",
)


def _strip_agentrail_codex_section(text: str) -> str:
    """Remove a legacy (unmarked) agentrail-context section group from TOML.

    A TOML section runs until the next ``[`` header at line start, so we drop
    every line belonging to one of our two known headers. Used to migrate files
    written before the managed-block markers existed.
    """
    out: List[str] = []
    skipping = False
    for line in text.splitlines(keepends=True):
        stripped = line.lstrip()
        if stripped.startswith("["):
            header = stripped.split("]", 1)[0] + "]"
            skipping = header in _CODEX_HEADERS
        if not skipping:
            out.append(line)
    return "".join(out)


def _codex_block_body(server_entry: Dict) -> str:
    mcp_dist = server_entry["args"][0]
    env = server_entry["env"]
    env_lines = [
        f'AGENTRAIL_BIN = "{env.get("AGENTRAIL_BIN", "")}"',
        f'AGENTRAIL_TARGET = "{env.get("AGENTRAIL_TARGET", "")}"',
    ]
    if env.get("AGENTRAIL_API_KEY"):
        env_lines.append(f'AGENTRAIL_API_KEY = "{env["AGENTRAIL_API_KEY"]}"')
    return (
        "[mcp.servers.agentrail-context]\n"
        'command = "node"\n'
        f'args = ["{mcp_dist}"]\n'
        "\n"
        "[mcp.servers.agentrail-context.env]\n"
        + "\n".join(env_lines)
        + "\n"
    )


def _codex_toml_content(path: Path, server_entry: Dict, force: bool) -> Optional[str]:
    """Compute ``.codex/config.toml`` text with our section as a managed block.

    Re-runs replace our block in place; legacy unmarked sections are migrated;
    all other TOML (and its comments) is preserved. Returns None when already
    wired and not forced.
    """
    existing = path.read_text() if path.exists() else ""
    has_marker = _CODEX_START in existing
    has_legacy = "[mcp.servers.agentrail-context]" in existing
    if (has_marker or has_legacy) and not force:
        return None
    marked = f"{_CODEX_START}\n{_codex_block_body(server_entry)}{_CODEX_END}\n"
    if has_marker:
        return _replace_between(existing, _CODEX_START, _CODEX_END, marked)
    base = _strip_agentrail_codex_section(existing) if has_legacy else existing
    base = base.rstrip("\n")
    return (base + "\n\n" if base else "") + marked


def _agents_md_content(path: Path) -> str:
    """Compute AGENTS.md text with the steering block as a managed block.

    Replaces the block in place when present (so updated steering applies), else
    appends it. Other prose is preserved.
    """
    content = path.read_text() if path.exists() else ""
    if _STEERING_START in content:
        return _replace_between(content, _STEERING_START, _STEERING_END, _STEERING_BLOCK + "\n")
    base = content.rstrip("\n")
    return (base + "\n\n" if base else "") + _STEERING_BLOCK + "\n"


def parse_init_agent_args(args: List[str]):
    if not args or args[0] in ("-h", "--help"):
        print(_USAGE)
        raise UsageError("", code=0)

    agent = args[0]
    if agent not in _AGENTS:
        raise UsageError(f"Unknown agent: {agent!r}. Choose one of: {', '.join(_AGENTS)}")

    target = os.getcwd()
    force = False
    dry_run = False
    i = 1
    while i < len(args):
        a = args[i]
        if a == "--target":
            if i + 1 >= len(args) or not args[i + 1] or args[i + 1].startswith("--"):
                raise UsageError("--target requires a directory")
            target = args[i + 1]
            i += 2
        elif a == "--force":
            force = True
            i += 1
        elif a in ("--print", "--dry-run"):
            dry_run = True
            i += 1
        elif a in ("-h", "--help"):
            print(_USAGE)
            raise UsageError("", code=0)
        else:
            raise UsageError(f"Unknown option: {a}")
    return agent, target, force, dry_run


def run_init_agent(args: List[str]) -> int:
    """Entry point for ``agentrail init <claude|cursor|codex>``."""
    try:
        agent, target_str, force, dry_run = parse_init_agent_args(args)
    except UsageError as exc:
        if str(exc):
            print(str(exc), file=sys.stderr)
        return exc.code

    try:
        return _run_init_agent(agent, target_str, force, dry_run)
    except UsageError as exc:
        if str(exc):
            print(str(exc), file=sys.stderr)
        return exc.code


def _run_init_agent(agent: str, target_str: str, force: bool, dry_run: bool) -> int:
    target_dir = Path(target_str).resolve()
    repo_dir = _repo_dir()

    api_key, key_source = _resolve_api_key(target_dir)
    server_entry = _mcp_server_entry(repo_dir, target_dir, api_key)

    print(f"agentrail init {agent}{' (dry-run)' if dry_run else ''}: {target_dir}")
    if key_source:
        print(f"  api key: resolved from {key_source}")
    else:
        print("  api key: not found (set AGENTRAIL_API_KEY in environment)")

    if agent == "claude":
        mcp_path = target_dir / ".mcp.json"
        print(_emit(mcp_path, _mcp_json_content(mcp_path, server_entry, force), dry_run, ".mcp.json"))

        if dry_run:
            print("(dry-run) would install context-first hook + .claude/settings.json")
        else:
            from agentrail.cli.commands.install import _install_claude_hooks
            _install_claude_hooks(repo_dir, target_dir)
            print("wired: context-first hook + .claude/settings.json")

    elif agent == "cursor":
        mcp_path = target_dir / ".cursor" / "mcp.json"
        print(_emit(mcp_path, _mcp_json_content(mcp_path, server_entry, force), dry_run, ".cursor/mcp.json"))
        agents_md = target_dir / "AGENTS.md"
        print(_emit(agents_md, _agents_md_content(agents_md), dry_run, "AGENTS.md (context steering)"))

    elif agent == "codex":
        toml_path = target_dir / ".codex" / "config.toml"
        print(_emit(toml_path, _codex_toml_content(toml_path, server_entry, force), dry_run, ".codex/config.toml"))
        agents_md = target_dir / "AGENTS.md"
        print(_emit(agents_md, _agents_md_content(agents_md), dry_run, "AGENTS.md (context steering)"))

        print("note: codex reads ~/.codex/config.toml globally; .codex/config.toml is project-local and may not be auto-discovered")

    return 0
