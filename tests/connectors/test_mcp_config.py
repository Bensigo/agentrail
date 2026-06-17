"""MCP config generation tests — the *codebase-level* half of connectors.

A connected MCP credential is materialized into the project's MCP config so the
coding agent can call the tool during a run. The FORMAT depends on the agent:
claude reads ``.mcp.json`` (JSON), codex reads ``.codex/config.toml`` (TOML, NOT
JSON). These tests pin both serializations, the env→config assembly, and the
write/merge behavior (never clobber a repo's own servers; no stray file when
nothing is connected).
"""
from __future__ import annotations

import json
import tempfile
import tomllib
import unittest
from pathlib import Path

from agentrail.connectors.mcp_config import (
    McpCredential,
    build_specs,
    credentials_from_env,
    to_claude_mcp_json,
    to_codex_config_toml,
    write_mcp_config,
    write_mcp_config_from_env,
)


class ClaudeJsonTests(unittest.TestCase):
    def test_context7_is_http_with_api_key_header(self):
        servers = to_claude_mcp_json([McpCredential("context7", "ctx7sk-abc")])[
            "mcpServers"
        ]
        self.assertEqual(
            servers["context7"],
            {
                "type": "http",
                "url": "https://mcp.context7.com/mcp",
                "headers": {"CONTEXT7_API_KEY": "ctx7sk-abc"},
            },
        )

    def test_figma_and_linear_are_stdio_with_api_key_env(self):
        servers = to_claude_mcp_json(
            [McpCredential("figma", "figd_x"), McpCredential("linear", "lin_api_x")]
        )["mcpServers"]
        self.assertEqual(servers["figma"]["command"], "npx")
        self.assertIn("figma-developer-mcp", servers["figma"]["args"])
        self.assertEqual(servers["figma"]["env"], {"FIGMA_API_KEY": "figd_x"})
        self.assertEqual(servers["linear"]["env"], {"LINEAR_API_KEY": "lin_api_x"})

    def test_unknown_provider_and_blank_secret_are_skipped(self):
        specs = build_specs(
            [
                McpCredential("discord", "x"),  # gateway, not MCP
                McpCredential("figma", ""),  # blank
                McpCredential("context7", "ctx7sk-ok"),
            ]
        )
        self.assertEqual(list(specs.keys()), ["context7"])


class CodexTomlTests(unittest.TestCase):
    def test_codex_is_valid_toml_not_json(self):
        toml_text = to_codex_config_toml(
            [
                McpCredential("context7", "ctx7sk-abc"),
                McpCredential("figma", "figd_x"),
                McpCredential("linear", "lin_api_x"),
            ]
        )
        # It must be TOML — JSON would not parse, and tomllib must round-trip it.
        parsed = tomllib.loads(toml_text)
        servers = parsed["mcp_servers"]
        # context7 → HTTP with custom header table.
        self.assertEqual(servers["context7"]["url"], "https://mcp.context7.com/mcp")
        self.assertEqual(
            servers["context7"]["http_headers"]["CONTEXT7_API_KEY"], "ctx7sk-abc"
        )
        # figma / linear → stdio with command/args + env table.
        self.assertEqual(servers["figma"]["command"], "npx")
        self.assertEqual(servers["figma"]["env"]["FIGMA_API_KEY"], "figd_x")
        self.assertEqual(servers["linear"]["env"]["LINEAR_API_KEY"], "lin_api_x")

    def test_empty_when_no_credentials(self):
        self.assertEqual(to_codex_config_toml([]), "")


class FromEnvTests(unittest.TestCase):
    def test_reads_per_provider_keys(self):
        creds = credentials_from_env(
            {
                "AGENTRAIL_MCP_LINEAR_KEY": "lin_api_a",
                "AGENTRAIL_MCP_CONTEXT7_KEY": "ctx7sk-b",
                "UNRELATED": "x",
            }
        )
        self.assertEqual({c.provider for c in creds}, {"linear", "context7"})

    def test_blank_keys_are_ignored(self):
        self.assertEqual(credentials_from_env({"AGENTRAIL_MCP_FIGMA_KEY": "  "}), [])


class WriteTests(unittest.TestCase):
    def test_claude_writes_mcp_json(self):
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d)
            path = write_mcp_config(repo, [McpCredential("context7", "k")], "claude")
            self.assertEqual(path, repo / ".mcp.json")
            data = json.loads(path.read_text())
            self.assertIn("context7", data["mcpServers"])

    def test_codex_writes_config_toml_not_json(self):
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d)
            path = write_mcp_config(repo, [McpCredential("figma", "figd_x")], "codex")
            self.assertEqual(path, repo / ".codex" / "config.toml")
            parsed = tomllib.loads(path.read_text())
            self.assertIn("figma", parsed["mcp_servers"])
            self.assertFalse((repo / ".mcp.json").exists())

    def test_no_servers_writes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d)
            self.assertIsNone(write_mcp_config(repo, [], "claude"))
            self.assertIsNone(write_mcp_config(repo, [], "codex"))

    def test_missing_repo_dir_is_a_safe_noop(self):
        self.assertIsNone(
            write_mcp_config(
                Path("/nonexistent/x"), [McpCredential("figma", "f")], "claude"
            )
        )

    def test_claude_merges_with_existing(self):
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d)
            (repo / ".mcp.json").write_text(
                json.dumps({"mcpServers": {"custom": {"command": "x"}}})
            )
            write_mcp_config(repo, [McpCredential("context7", "k")], "claude")
            data = json.loads((repo / ".mcp.json").read_text())
            self.assertIn("custom", data["mcpServers"])  # repo's own survives
            self.assertIn("context7", data["mcpServers"])

    def test_codex_appends_without_duplicating(self):
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d)
            (repo / ".codex").mkdir()
            (repo / ".codex" / "config.toml").write_text(
                '[mcp_servers.figma]\ncommand = "old"\n'
            )
            write_mcp_config(
                repo,
                [McpCredential("figma", "figd_x"), McpCredential("linear", "lin_api_x")],
                "codex",
            )
            parsed = tomllib.loads((repo / ".codex" / "config.toml").read_text())
            # figma already present → not duplicated (kept the repo's); linear added.
            self.assertEqual(parsed["mcp_servers"]["figma"]["command"], "old")
            self.assertIn("linear", parsed["mcp_servers"])

    def test_from_env_uses_agent_var(self):
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d)
            path = write_mcp_config_from_env(
                repo,
                {"AGENTRAIL_AGENT": "codex", "AGENTRAIL_MCP_LINEAR_KEY": "lin_api_x"},
            )
            self.assertEqual(path, repo / ".codex" / "config.toml")

    def test_from_env_defaults_to_claude(self):
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d)
            path = write_mcp_config_from_env(
                repo, {"AGENTRAIL_MCP_CONTEXT7_KEY": "ctx7sk-x"}
            )
            self.assertEqual(path, repo / ".mcp.json")

    def test_from_env_no_keys_writes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d)
            self.assertIsNone(write_mcp_config_from_env(repo, {}))


if __name__ == "__main__":
    unittest.main()
