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
import sys
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
  --force        Overwrite existing MCP config even if already wired.
  -h, --help     Show this help.\
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


def _write_mcp_json(path: Path, server_entry: Dict, force: bool) -> bool:
    """Write/merge mcpServers entry into a JSON config file.

    Returns True if the file was changed, False if skipped (already wired).
    """
    existing: Dict = {}
    if path.exists():
        try:
            existing = json.loads(path.read_text())
        except (OSError, ValueError) as exc:
            # Never silently discard a config we cannot parse — that would drop
            # any other MCP servers the user has wired. Refuse and let them fix it.
            raise UsageError(
                f"refusing to modify {path}: it exists but is not valid JSON "
                f"({exc}). Fix or remove it, then re-run."
            )
        if not isinstance(existing, dict):
            raise UsageError(
                f"refusing to modify {path}: top-level JSON is not an object."
            )
        if not force and "agentrail-context" in existing.get("mcpServers", {}):
            return False

    existing.setdefault("mcpServers", {})["agentrail-context"] = server_entry
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(existing, indent=2) + "\n")
    return True


_CODEX_HEADERS = (
    "[mcp.servers.agentrail-context]",
    "[mcp.servers.agentrail-context.env]",
)


def _strip_agentrail_codex_section(text: str) -> str:
    """Remove any existing agentrail-context section group from TOML text.

    A TOML section runs until the next ``[`` header at line start, so we drop
    every line belonging to one of our two known headers. Used under --force so
    we replace the section in place instead of appending a duplicate (which most
    TOML parsers reject).
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


def _write_codex_toml(path: Path, server_entry: Dict, force: bool) -> bool:
    """Append an MCP server block to .codex/config.toml.

    Returns True if the file was changed, False if already wired.
    The section marker ``[mcp.servers.agentrail-context]`` is used for
    idempotency detection.
    """
    existing_text = ""
    if path.exists():
        existing_text = path.read_text()
        if "[mcp.servers.agentrail-context]" in existing_text:
            if not force:
                return False
            # force=True: drop the old section so we replace rather than
            # duplicate it (duplicate top-level keys are invalid TOML).
            existing_text = _strip_agentrail_codex_section(existing_text).rstrip("\n")
            if existing_text:
                existing_text += "\n"

    mcp_dist = server_entry["args"][0]
    agentrail_bin = server_entry["env"].get("AGENTRAIL_BIN", "")
    agentrail_target = server_entry["env"].get("AGENTRAIL_TARGET", "")
    api_key = server_entry["env"].get("AGENTRAIL_API_KEY")

    env_lines = [
        f'AGENTRAIL_BIN = "{agentrail_bin}"',
        f'AGENTRAIL_TARGET = "{agentrail_target}"',
    ]
    if api_key:
        env_lines.append(f'AGENTRAIL_API_KEY = "{api_key}"')

    block = (
        "\n[mcp.servers.agentrail-context]\n"
        f'command = "node"\n'
        f'args = ["{mcp_dist}"]\n'
        "\n"
        "[mcp.servers.agentrail-context.env]\n"
        + "\n".join(env_lines)
        + "\n"
    )

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(existing_text + block)
    return True


def _append_agents_md_steering(target_dir: Path) -> bool:
    """Append the MCP steering block to AGENTS.md.

    Idempotent: skips if the ``<!-- agentrail-mcp:start -->`` marker is
    already present. Returns True if changed.
    """
    agents_md = target_dir / "AGENTS.md"
    content = agents_md.read_text() if agents_md.exists() else ""
    if _STEERING_START in content:
        return False
    sep = "" if not content or content.endswith("\n") else "\n"
    agents_md.write_text(content + sep + "\n" + _STEERING_BLOCK + "\n")
    return True


def parse_init_agent_args(args: List[str]):
    if not args or args[0] in ("-h", "--help"):
        print(_USAGE)
        raise UsageError("", code=0)

    agent = args[0]
    if agent not in _AGENTS:
        raise UsageError(f"Unknown agent: {agent!r}. Choose one of: {', '.join(_AGENTS)}")

    target = os.getcwd()
    force = False
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
        elif a in ("-h", "--help"):
            print(_USAGE)
            raise UsageError("", code=0)
        else:
            raise UsageError(f"Unknown option: {a}")
    return agent, target, force


def run_init_agent(args: List[str]) -> int:
    """Entry point for ``agentrail init <claude|cursor|codex>``."""
    try:
        agent, target_str, force = parse_init_agent_args(args)
    except UsageError as exc:
        if str(exc):
            print(str(exc), file=sys.stderr)
        return exc.code

    try:
        return _run_init_agent(agent, target_str, force)
    except UsageError as exc:
        if str(exc):
            print(str(exc), file=sys.stderr)
        return exc.code


def _run_init_agent(agent: str, target_str: str, force: bool) -> int:
    target_dir = Path(target_str).resolve()
    repo_dir = _repo_dir()

    api_key, key_source = _resolve_api_key(target_dir)
    server_entry = _mcp_server_entry(repo_dir, target_dir, api_key)

    print(f"agentrail init {agent}: {target_dir}")
    if key_source:
        print(f"  api key: resolved from {key_source}")
    else:
        print("  api key: not found (set AGENTRAIL_API_KEY in environment)")

    if agent == "claude":
        mcp_path = target_dir / ".mcp.json"
        if _write_mcp_json(mcp_path, server_entry, force):
            print("wired: .mcp.json")
        else:
            print("skipped: .mcp.json (already wired; use --force to overwrite)")

        from agentrail.cli.commands.install import _install_claude_hooks
        _install_claude_hooks(repo_dir, target_dir)

    elif agent == "cursor":
        mcp_path = target_dir / ".cursor" / "mcp.json"
        if _write_mcp_json(mcp_path, server_entry, force):
            print("wired: .cursor/mcp.json")
        else:
            print("skipped: .cursor/mcp.json (already wired; use --force to overwrite)")

        if _append_agents_md_steering(target_dir):
            print("wired: AGENTS.md (context steering)")
        else:
            print("skipped: AGENTS.md steering (already present)")

    elif agent == "codex":
        toml_path = target_dir / ".codex" / "config.toml"
        if _write_codex_toml(toml_path, server_entry, force):
            print("wired: .codex/config.toml")
        else:
            print("skipped: .codex/config.toml (already wired; use --force to overwrite)")

        if _append_agents_md_steering(target_dir):
            print("wired: AGENTS.md (context steering)")
        else:
            print("skipped: AGENTS.md steering (already present)")

        print("note: codex reads ~/.codex/config.toml globally; .codex/config.toml is project-local and may not be auto-discovered")

    return 0
