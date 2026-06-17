"""MCP connectors — turn a connected MCP credential into **codebase** access.

An **MCP** connector (Linear, Figma, Context7) is *codebase-level*: connecting it
doesn't make the console talk to the tool — the stored credential is materialized
into the project's MCP config so the coding agent running on that repo can call
the MCP server's tools during a run. The config FORMAT depends on the agent:

- **claude** reads a JSON ``.mcp.json`` at the repo root.
- **codex** reads TOML at ``.codex/config.toml`` (project-scoped) — NOT JSON.

So this module defines one normalized per-provider server spec and serializes it
to whichever format the run's agent needs. The provider shapes are the documented
ones (verified against each tool's MCP docs):

- **context7** — remote HTTP MCP, API key in a header (``CONTEXT7_API_KEY``).
- **figma** — Framelink ``figma-developer-mcp`` over stdio, ``FIGMA_API_KEY`` env.
- **linear** — community ``linear-mcp-server`` over stdio, ``LINEAR_API_KEY`` env
  (the official ``mcp.linear.app`` is OAuth-only, so an API key uses this server).

Secrets are **never** stored in plaintext: the console encrypts them at rest and
only the decrypted value is handed to the runner (over env), where it is written
into the codebase config. The runner receives one var per provider,
``AGENTRAIL_MCP_<PROVIDER>_KEY``; :func:`write_mcp_config_from_env` assembles +
writes the right-format file. Nothing is written when no MCP connector is set.

Gateway connectors (Discord/Slack/Telegram) are deliberately NOT here: they are
*platform-level* notify channels, not something the codebase gets access to.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Mapping, Optional

# The MCP providers that are codebase-level (write into the agent config).
MCP_PROVIDERS = ("linear", "figma", "context7")

# Env var carrying each provider's (decrypted) API key into the runner, e.g.
# AGENTRAIL_MCP_LINEAR_KEY. One per provider; absent → that server is omitted.
ENV_PREFIX = "AGENTRAIL_MCP_"
ENV_SUFFIX = "_KEY"

# Agents we know how to write MCP config for, and their default.
AGENT_CLAUDE = "claude"
AGENT_CODEX = "codex"
ENV_AGENT = "AGENTRAIL_AGENT"


def _env_var(provider: str) -> str:
    return f"{ENV_PREFIX}{provider.upper()}{ENV_SUFFIX}"


@dataclass(frozen=True)
class McpCredential:
    """One connected MCP connector: its provider and the (decrypted) API key."""

    provider: str
    secret: str


# --------------------------------------------------------------------------- #
# Normalized server spec — one shape, serialized to JSON (claude) or TOML (codex)
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class McpServerSpec:
    """A transport-normalized MCP server definition.

    Exactly one of the two transports is populated:
      - HTTP: ``url`` + ``headers`` (auth header name → value).
      - stdio: ``command`` + ``args`` + ``env`` (env var name → value).
    """

    transport: str  # "http" | "stdio"
    url: Optional[str] = None
    headers: Optional[Dict[str, str]] = None
    command: Optional[str] = None
    args: Optional[List[str]] = None
    env: Optional[Dict[str, str]] = None


def _context7(secret: str) -> McpServerSpec:
    return McpServerSpec(
        transport="http",
        url="https://mcp.context7.com/mcp",
        headers={"CONTEXT7_API_KEY": secret},
    )


def _figma(secret: str) -> McpServerSpec:
    return McpServerSpec(
        transport="stdio",
        command="npx",
        args=["-y", "figma-developer-mcp", "--stdio"],
        env={"FIGMA_API_KEY": secret},
    )


def _linear(secret: str) -> McpServerSpec:
    # Official mcp.linear.app is OAuth-only; an API key uses the community server.
    return McpServerSpec(
        transport="stdio",
        command="npx",
        args=["-y", "linear-mcp-server"],
        env={"LINEAR_API_KEY": secret},
    )


_BUILDERS: Dict[str, Callable[[str], McpServerSpec]] = {
    "context7": _context7,
    "figma": _figma,
    "linear": _linear,
}


def build_specs(credentials: List[McpCredential]) -> Dict[str, McpServerSpec]:
    """Build the {server-name: spec} map from connected MCP credentials. Pure.

    Skips unknown providers and blank secrets so the output only ever contains
    real, usable servers. Deterministic order (the credentials' order).
    """
    specs: Dict[str, McpServerSpec] = {}
    for cred in credentials:
        builder = _BUILDERS.get(cred.provider)
        if builder is None or not cred.secret:
            continue
        specs[cred.provider] = builder(cred.secret)
    return specs


# --------------------------------------------------------------------------- #
# Serializers
# --------------------------------------------------------------------------- #
def _spec_to_claude(spec: McpServerSpec) -> dict:
    """One server → the claude ``.mcp.json`` entry shape."""
    if spec.transport == "http":
        entry: dict = {"type": "http", "url": spec.url}
        if spec.headers:
            entry["headers"] = dict(spec.headers)
        return entry
    entry = {"command": spec.command, "args": list(spec.args or [])}
    if spec.env:
        entry["env"] = dict(spec.env)
    return entry


def to_claude_mcp_json(credentials: List[McpCredential]) -> Dict[str, dict]:
    """The full ``.mcp.json`` document (claude) for the given MCP credentials."""
    return {
        "mcpServers": {
            name: _spec_to_claude(spec)
            for name, spec in build_specs(credentials).items()
        }
    }


def _toml_str(value: str) -> str:
    """Serialize a TOML basic string with the required escapes."""
    out = value.replace("\\", "\\\\").replace('"', '\\"')
    out = out.replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return f'"{out}"'


def _toml_array(values: List[str]) -> str:
    return "[" + ", ".join(_toml_str(v) for v in values) + "]"


def _spec_to_codex_block(name: str, spec: McpServerSpec) -> str:
    """One server → a ``[mcp_servers.<name>]`` TOML block (codex)."""
    lines = [f"[mcp_servers.{name}]"]
    if spec.transport == "http":
        lines.append(f"url = {_toml_str(spec.url or '')}")
        body = "\n".join(lines)
        if spec.headers:
            header_lines = [f"\n[mcp_servers.{name}.http_headers]"]
            for k, v in spec.headers.items():
                header_lines.append(f"{k} = {_toml_str(v)}")
            body += "\n" + "\n".join(header_lines)
        return body
    lines.append(f"command = {_toml_str(spec.command or '')}")
    lines.append(f"args = {_toml_array(spec.args or [])}")
    body = "\n".join(lines)
    if spec.env:
        env_lines = [f"\n[mcp_servers.{name}.env]"]
        for k, v in spec.env.items():
            env_lines.append(f"{k} = {_toml_str(v)}")
        body += "\n" + "\n".join(env_lines)
    return body


def to_codex_config_toml(credentials: List[McpCredential]) -> str:
    """The ``.codex/config.toml`` text (codex) for the given MCP credentials.

    Emits one ``[mcp_servers.<name>]`` table per connected server. Empty when no
    MCP connector is configured.
    """
    blocks = [
        _spec_to_codex_block(name, spec)
        for name, spec in build_specs(credentials).items()
    ]
    return ("\n\n".join(blocks) + "\n") if blocks else ""


def credentials_from_env(env: Mapping[str, str]) -> List[McpCredential]:
    """Read per-provider MCP keys from ``env`` (``AGENTRAIL_MCP_<PROVIDER>_KEY``)."""
    creds: List[McpCredential] = []
    for provider in MCP_PROVIDERS:
        secret = (env.get(_env_var(provider)) or "").strip()
        if secret:
            creds.append(McpCredential(provider=provider, secret=secret))
    return creds


# --------------------------------------------------------------------------- #
# Writers — agent-aware (claude → .mcp.json JSON, codex → .codex/config.toml TOML)
# --------------------------------------------------------------------------- #
def _write_claude(repo_dir: Path, credentials: List[McpCredential]) -> Optional[Path]:
    servers = to_claude_mcp_json(credentials)["mcpServers"]
    if not servers:
        return None
    path = repo_dir / ".mcp.json"
    existing: Dict[str, object] = {}
    if path.is_file():
        try:
            loaded = json.loads(path.read_text())
            if isinstance(loaded, dict):
                existing = loaded
        except (ValueError, OSError):
            existing = {}
    merged = {}
    prior = existing.get("mcpServers")
    if isinstance(prior, dict):
        merged.update(prior)
    merged.update(servers)  # our connected servers win on conflict
    existing["mcpServers"] = merged
    path.write_text(json.dumps(existing, indent=2) + "\n")
    return path


def _write_codex(repo_dir: Path, credentials: List[McpCredential]) -> Optional[Path]:
    specs = build_specs(credentials)
    if not specs:
        return None
    codex_dir = repo_dir / ".codex"
    codex_dir.mkdir(parents=True, exist_ok=True)
    path = codex_dir / "config.toml"

    existing_text = ""
    if path.is_file():
        try:
            existing_text = path.read_text()
        except OSError:
            existing_text = ""

    # Append only servers the repo's config doesn't already define — each
    # [mcp_servers.<name>] header starts a fresh table, so appending at EOF is
    # safe TOML and never re-nests under a prior table.
    blocks: List[str] = []
    for name, spec in specs.items():
        if f"[mcp_servers.{name}]" in existing_text:
            continue
        blocks.append(_spec_to_codex_block(name, spec))
    if not blocks:
        return path  # everything already present; nothing to add

    addition = "\n\n".join(blocks) + "\n"
    if existing_text and not existing_text.endswith("\n"):
        existing_text += "\n"
    sep = "\n" if existing_text else ""
    path.write_text(existing_text + sep + addition)
    return path


def write_mcp_config(
    repo_dir: Path, credentials: List[McpCredential], agent: str
) -> Optional[Path]:
    """Write the run's MCP config into the cloned repo, in the agent's format.

    Returns the path written, or ``None`` (writes nothing) when there are no MCP
    servers or ``repo_dir`` is not an existing directory — so a run with no MCP
    connector, or a hermetic test with a mocked clone, never creates a stray file.
    ``agent`` selects the format: ``codex`` → ``.codex/config.toml`` (TOML), any
    other agent (default ``claude``) → ``.mcp.json`` (JSON).
    """
    if not repo_dir.is_dir():
        return None
    if agent == AGENT_CODEX:
        return _write_codex(repo_dir, credentials)
    return _write_claude(repo_dir, credentials)


def write_mcp_config_from_env(
    repo_dir: Path, env: Optional[Mapping[str, str]] = None
) -> Optional[Path]:
    """Assemble MCP credentials + agent from ``env`` and write the codebase config.

    The runner's injection seam: it forwards each connected MCP connector's
    decrypted key as ``AGENTRAIL_MCP_<PROVIDER>_KEY`` and the run agent as
    ``AGENTRAIL_AGENT``; this writes the right-format MCP config so the agent can
    call the tools. No keys → nothing written.
    """
    env = env or os.environ
    agent = (env.get(ENV_AGENT) or AGENT_CLAUDE).strip() or AGENT_CLAUDE
    return write_mcp_config(repo_dir, credentials_from_env(env), agent)
