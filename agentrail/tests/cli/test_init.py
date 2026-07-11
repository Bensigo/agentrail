"""Tests for ``agentrail init <claude|cursor|codex>`` — issue #694 (M022 AC4-AC6).

Covers:
  - AC4: init claude → MCP + context-first hook; codex/cursor → MCP + steering, no hook
  - AC5: reads API key from env/config; idempotent (no duplicate config on re-run)
  - AC6: all three providers pass
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_repo() -> Path:
    """Minimal AgentRail source repo for init tests."""
    repo = Path(tempfile.mkdtemp())
    (repo / "package.json").write_text(json.dumps({"name": "@useagentrail/cli", "version": "1.0.0"}))
    (repo / "agentrail" / "templates" / "scripts").mkdir(parents=True)
    (repo / "agentrail" / "templates" / "scripts" / "context-first.sh").write_text("#!/usr/bin/env bash\nexit 0\n")
    (repo / "packages" / "mcp" / "dist").mkdir(parents=True)
    (repo / "packages" / "mcp" / "dist" / "index.js").write_text("// mcp server\n")
    (repo / "agentrail" / "scripts").mkdir(parents=True)
    launcher = repo / "agentrail" / "scripts" / "agentrail"
    launcher.write_text("#!/usr/bin/env bash\necho ok\n")
    launcher.chmod(0o755)
    return repo


def _run(repo: Path, agent: str, target: Path, extra_args=None, env_key: str = ""):
    """Call run_init_agent with repo mocked, optional AGENTRAIL_API_KEY env."""
    from agentrail.cli.commands.init_agent import run_init_agent
    args = [agent, "--target", str(target)] + (extra_args or [])
    env_patch = {}
    if env_key:
        env_patch["AGENTRAIL_API_KEY"] = env_key
    else:
        env_patch.pop("AGENTRAIL_API_KEY", None)
    with patch("agentrail.cli.commands.init_agent._repo_dir", return_value=repo), \
         patch.dict(os.environ, env_patch, clear=False):
        # Ensure AGENTRAIL_API_KEY is absent when env_key not given
        if not env_key:
            env = dict(os.environ)
            env.pop("AGENTRAIL_API_KEY", None)
            with patch.dict(os.environ, env, clear=True):
                return run_init_agent(args)
        return run_init_agent(args)


# ---------------------------------------------------------------------------
# AC4: init claude → MCP + hook
# ---------------------------------------------------------------------------

class TestInitClaude(TestCase):
    def setUp(self):
        self.repo = _make_repo()
        self.target = Path(tempfile.mkdtemp())

    def test_returns_zero(self):
        rc = _run(self.repo, "claude", self.target)
        self.assertEqual(rc, 0)

    def test_writes_mcp_json(self):
        _run(self.repo, "claude", self.target)
        mcp_path = self.target / ".mcp.json"
        self.assertTrue(mcp_path.exists(), ".mcp.json must be created for claude")

    def test_mcp_json_structure(self):
        _run(self.repo, "claude", self.target)
        data = json.loads((self.target / ".mcp.json").read_text())
        self.assertIn("mcpServers", data)
        server = data["mcpServers"]["agentrail-context"]
        self.assertEqual(server["command"], "node")
        self.assertIsInstance(server["args"], list)
        self.assertTrue(server["args"][0].endswith("packages/mcp/dist/index.js"))
        self.assertIn("AGENTRAIL_BIN", server["env"])
        self.assertIn("AGENTRAIL_TARGET", server["env"])

    def test_installs_hook_script(self):
        _run(self.repo, "claude", self.target)
        hook = self.target / ".agentrail" / "hooks" / "context-first.sh"
        self.assertTrue(hook.exists(), "context-first.sh must be installed for claude")
        self.assertTrue(os.access(hook, os.X_OK))

    def test_wires_hook_in_settings_json(self):
        _run(self.repo, "claude", self.target)
        settings_path = self.target / ".claude" / "settings.json"
        self.assertTrue(settings_path.exists())
        settings = json.loads(settings_path.read_text())
        entries = settings["hooks"]["PreToolUse"]
        self.assertEqual(len(entries), 1)
        self.assertIn("context-first.sh", entries[0]["hooks"][0]["command"])

    def test_no_steering_block_in_agents_md(self):
        """Claude relies on hook enforcement, not AGENTS.md steering block."""
        # Even if AGENTS.md exists, init claude must not append the MCP steering marker
        (self.target / "AGENTS.md").write_text("# Agents\n")
        _run(self.repo, "claude", self.target)
        content = (self.target / "AGENTS.md").read_text()
        self.assertNotIn("agentrail-mcp:start", content)


# ---------------------------------------------------------------------------
# AC4: init codex → MCP + steering, no hook
# ---------------------------------------------------------------------------

class TestInitCodex(TestCase):
    def setUp(self):
        self.repo = _make_repo()
        self.target = Path(tempfile.mkdtemp())

    def test_returns_zero(self):
        rc = _run(self.repo, "codex", self.target)
        self.assertEqual(rc, 0)

    def test_writes_codex_config_toml(self):
        _run(self.repo, "codex", self.target)
        toml_path = self.target / ".codex" / "config.toml"
        self.assertTrue(toml_path.exists(), ".codex/config.toml must be created for codex")

    def test_codex_toml_contains_mcp_server(self):
        _run(self.repo, "codex", self.target)
        content = (self.target / ".codex" / "config.toml").read_text()
        self.assertIn("[mcp.servers.agentrail-context]", content)
        self.assertIn('command = "node"', content)
        self.assertIn("packages/mcp/dist/index.js", content)
        self.assertIn("AGENTRAIL_BIN", content)
        self.assertIn("AGENTRAIL_TARGET", content)

    def test_appends_steering_to_agents_md(self):
        _run(self.repo, "codex", self.target)
        agents_md = self.target / "AGENTS.md"
        self.assertTrue(agents_md.exists())
        content = agents_md.read_text()
        self.assertIn("agentrail-mcp:start", content)
        self.assertIn("agentrail-mcp:end", content)

    def test_no_hook_files_for_codex(self):
        _run(self.repo, "codex", self.target)
        self.assertFalse(
            (self.target / ".agentrail" / "hooks" / "context-first.sh").exists(),
            "codex must not get the claude hook",
        )
        self.assertFalse(
            (self.target / ".claude" / "settings.json").exists(),
            "codex must not write claude settings.json",
        )


# ---------------------------------------------------------------------------
# AC4: init cursor → MCP + steering, no hook
# ---------------------------------------------------------------------------

class TestInitCursor(TestCase):
    def setUp(self):
        self.repo = _make_repo()
        self.target = Path(tempfile.mkdtemp())

    def test_returns_zero(self):
        rc = _run(self.repo, "cursor", self.target)
        self.assertEqual(rc, 0)

    def test_writes_cursor_mcp_json(self):
        _run(self.repo, "cursor", self.target)
        mcp_path = self.target / ".cursor" / "mcp.json"
        self.assertTrue(mcp_path.exists(), ".cursor/mcp.json must be created for cursor")

    def test_cursor_mcp_json_structure(self):
        _run(self.repo, "cursor", self.target)
        data = json.loads((self.target / ".cursor" / "mcp.json").read_text())
        server = data["mcpServers"]["agentrail-context"]
        self.assertEqual(server["command"], "node")
        self.assertIn("AGENTRAIL_BIN", server["env"])

    def test_appends_steering_to_agents_md(self):
        _run(self.repo, "cursor", self.target)
        content = (self.target / "AGENTS.md").read_text()
        self.assertIn("agentrail-mcp:start", content)

    def test_no_hook_files_for_cursor(self):
        _run(self.repo, "cursor", self.target)
        self.assertFalse(
            (self.target / ".agentrail" / "hooks" / "context-first.sh").exists(),
            "cursor must not get the claude hook",
        )
        self.assertFalse(
            (self.target / ".claude" / "settings.json").exists(),
        )


# ---------------------------------------------------------------------------
# AC5: reads API key from env
# ---------------------------------------------------------------------------

class TestApiKeyFromEnv(TestCase):
    def setUp(self):
        self.repo = _make_repo()
        self.target = Path(tempfile.mkdtemp())

    def _run_with_key(self, agent: str, key: str):
        from agentrail.cli.commands.init_agent import run_init_agent
        args = [agent, "--target", str(self.target)]
        with patch("agentrail.cli.commands.init_agent._repo_dir", return_value=self.repo), \
             patch.dict(os.environ, {"AGENTRAIL_API_KEY": key}, clear=False):
            return run_init_agent(args)

    def test_claude_mcp_json_includes_key(self):
        self._run_with_key("claude", "test-key-123")
        data = json.loads((self.target / ".mcp.json").read_text())
        self.assertEqual(data["mcpServers"]["agentrail-context"]["env"]["AGENTRAIL_API_KEY"], "test-key-123")

    def test_cursor_mcp_json_includes_key(self):
        self._run_with_key("cursor", "test-key-456")
        data = json.loads((self.target / ".cursor" / "mcp.json").read_text())
        self.assertEqual(data["mcpServers"]["agentrail-context"]["env"]["AGENTRAIL_API_KEY"], "test-key-456")

    def test_codex_toml_includes_key(self):
        self._run_with_key("codex", "test-key-789")
        content = (self.target / ".codex" / "config.toml").read_text()
        self.assertIn("test-key-789", content)

    def test_no_key_env_block_has_no_api_key(self):
        _run(self.repo, "claude", self.target, env_key="")
        data = json.loads((self.target / ".mcp.json").read_text())
        self.assertNotIn("AGENTRAIL_API_KEY", data["mcpServers"]["agentrail-context"]["env"])


# ---------------------------------------------------------------------------
# AC5: reads API key from .agentrail/config.json
# ---------------------------------------------------------------------------

class TestApiKeyFromConfig(TestCase):
    def setUp(self):
        self.repo = _make_repo()
        self.target = Path(tempfile.mkdtemp())
        config_dir = self.target / ".agentrail"
        config_dir.mkdir(parents=True)
        (config_dir / "config.json").write_text(json.dumps({"schemaVersion": 1, "apiKey": "cfg-key-abc"}))

    def test_claude_mcp_json_reads_config_key(self):
        from agentrail.cli.commands.init_agent import run_init_agent
        args = ["claude", "--target", str(self.target)]
        env = {k: v for k, v in os.environ.items() if k != "AGENTRAIL_API_KEY"}
        with patch("agentrail.cli.commands.init_agent._repo_dir", return_value=self.repo), \
             patch.dict(os.environ, env, clear=True):
            run_init_agent(args)
        data = json.loads((self.target / ".mcp.json").read_text())
        self.assertEqual(data["mcpServers"]["agentrail-context"]["env"]["AGENTRAIL_API_KEY"], "cfg-key-abc")


# ---------------------------------------------------------------------------
# AC5: idempotent re-run
# ---------------------------------------------------------------------------

class TestIdempotency(TestCase):
    def setUp(self):
        self.repo = _make_repo()
        self.target = Path(tempfile.mkdtemp())

    def test_claude_rerun_no_duplicate_mcp_servers(self):
        _run(self.repo, "claude", self.target)
        _run(self.repo, "claude", self.target)
        data = json.loads((self.target / ".mcp.json").read_text())
        # Only one agentrail-context server entry
        self.assertEqual(list(data["mcpServers"].keys()), ["agentrail-context"])

    def test_claude_rerun_no_duplicate_hook_entry(self):
        _run(self.repo, "claude", self.target)
        _run(self.repo, "claude", self.target)
        settings = json.loads((self.target / ".claude" / "settings.json").read_text())
        self.assertEqual(len(settings["hooks"]["PreToolUse"]), 1)

    def test_codex_rerun_no_duplicate_toml_section(self):
        _run(self.repo, "codex", self.target)
        _run(self.repo, "codex", self.target)
        content = (self.target / ".codex" / "config.toml").read_text()
        self.assertEqual(content.count("[mcp.servers.agentrail-context]"), 1)

    def test_codex_rerun_no_duplicate_steering(self):
        _run(self.repo, "codex", self.target)
        _run(self.repo, "codex", self.target)
        content = (self.target / "AGENTS.md").read_text()
        self.assertEqual(content.count("agentrail-mcp:start"), 1)

    def test_cursor_rerun_no_duplicate_mcp_entry(self):
        _run(self.repo, "cursor", self.target)
        _run(self.repo, "cursor", self.target)
        data = json.loads((self.target / ".cursor" / "mcp.json").read_text())
        self.assertEqual(list(data["mcpServers"].keys()), ["agentrail-context"])

    def test_cursor_rerun_no_duplicate_steering(self):
        _run(self.repo, "cursor", self.target)
        _run(self.repo, "cursor", self.target)
        content = (self.target / "AGENTS.md").read_text()
        self.assertEqual(content.count("agentrail-mcp:start"), 1)

    def test_force_overwrites_mcp_json(self):
        _run(self.repo, "claude", self.target)
        # Corrupt the file
        (self.target / ".mcp.json").write_text('{"mcpServers": {"agentrail-context": {"command": "old"}}}')
        _run(self.repo, "claude", self.target, extra_args=["--force"])
        data = json.loads((self.target / ".mcp.json").read_text())
        self.assertEqual(data["mcpServers"]["agentrail-context"]["command"], "node")

    def test_codex_force_replaces_not_duplicates(self):
        """--force must replace the section, not append a duplicate (invalid TOML)."""
        _run(self.repo, "codex", self.target)
        rc = _run(self.repo, "codex", self.target, extra_args=["--force"])
        self.assertEqual(rc, 0)
        content = (self.target / ".codex" / "config.toml").read_text()
        self.assertEqual(content.count("[mcp.servers.agentrail-context]"), 1)
        self.assertEqual(content.count("[mcp.servers.agentrail-context.env]"), 1)

    def test_codex_force_preserves_other_sections(self):
        """--force strips only our section; the user's other TOML is preserved."""
        toml = self.target / ".codex" / "config.toml"
        toml.parent.mkdir(parents=True, exist_ok=True)
        toml.write_text('[other]\nkeep = "me"\n')
        _run(self.repo, "codex", self.target)
        _run(self.repo, "codex", self.target, extra_args=["--force"])
        content = toml.read_text()
        self.assertIn('[other]', content)
        self.assertIn('keep = "me"', content)
        self.assertEqual(content.count("[mcp.servers.agentrail-context]"), 1)


class TestNoSilentDataLoss(TestCase):
    """init must never silently discard config it cannot understand."""

    def setUp(self):
        self.repo = _make_repo()
        self.target = Path(tempfile.mkdtemp())

    def test_claude_preserves_other_mcp_servers(self):
        mcp = self.target / ".mcp.json"
        mcp.write_text(json.dumps({"mcpServers": {"other": {"command": "x"}}}))
        _run(self.repo, "claude", self.target)
        data = json.loads(mcp.read_text())
        self.assertIn("other", data["mcpServers"])
        self.assertIn("agentrail-context", data["mcpServers"])

    def test_refuses_to_clobber_invalid_json(self):
        mcp = self.target / ".mcp.json"
        original = '{"mcpServers": {"other": {"command": "x"}}'  # missing closing brace
        mcp.write_text(original)
        rc = _run(self.repo, "claude", self.target)
        self.assertNotEqual(rc, 0, "must refuse rather than overwrite unparseable JSON")
        self.assertEqual(mcp.read_text(), original, "file must be left untouched")


# ---------------------------------------------------------------------------
# Arg parsing and routing
# ---------------------------------------------------------------------------

class TestArgParsing(TestCase):
    def setUp(self):
        self.repo = _make_repo()

    def test_unknown_agent_returns_2(self):
        from agentrail.cli.commands.init_agent import run_init_agent
        import io
        buf = io.StringIO()
        with patch("agentrail.cli.commands.init_agent._repo_dir", return_value=self.repo), \
             patch("sys.stderr", buf):
            rc = run_init_agent(["vscode"])
        self.assertEqual(rc, 2)

    def test_help_returns_zero(self):
        from agentrail.cli.commands.init_agent import run_init_agent
        with patch("agentrail.cli.commands.init_agent._repo_dir", return_value=self.repo):
            rc = run_init_agent(["--help"])
        self.assertEqual(rc, 0)

    def test_no_args_returns_zero_with_usage(self):
        from agentrail.cli.commands.init_agent import run_init_agent
        with patch("agentrail.cli.commands.init_agent._repo_dir", return_value=self.repo):
            rc = run_init_agent([])
        self.assertEqual(rc, 0)

    def test_unknown_option_returns_2(self):
        import io
        from agentrail.cli.commands.init_agent import run_init_agent
        target = Path(tempfile.mkdtemp())
        buf = io.StringIO()
        with patch("agentrail.cli.commands.init_agent._repo_dir", return_value=self.repo), \
             patch("sys.stderr", buf):
            rc = run_init_agent(["claude", "--target", str(target), "--bogus"])
        self.assertEqual(rc, 2)


class TestMainRouting(TestCase):
    """init <agent> routes to run_init_agent; bare init still routes to run_install."""

    def test_init_claude_routes_to_init_agent(self):
        import agentrail.cli.main as m
        with patch("agentrail.cli.main.run_init_agent", return_value=0) as mock_ia:
            rc = m.main(["init", "claude", "--target", "/x"])
        mock_ia.assert_called_once_with(["claude", "--target", "/x"])
        self.assertEqual(rc, 0)

    def test_init_codex_routes_to_init_agent(self):
        import agentrail.cli.main as m
        with patch("agentrail.cli.main.run_init_agent", return_value=0) as mock_ia:
            rc = m.main(["init", "codex"])
        mock_ia.assert_called_once_with(["codex"])
        self.assertEqual(rc, 0)

    def test_init_cursor_routes_to_init_agent(self):
        import agentrail.cli.main as m
        with patch("agentrail.cli.main.run_init_agent", return_value=0) as mock_ia:
            rc = m.main(["init", "cursor"])
        mock_ia.assert_called_once_with(["cursor"])
        self.assertEqual(rc, 0)

    def test_bare_init_still_routes_to_install(self):
        import agentrail.cli.main as m
        with patch("agentrail.cli.main.run_install", return_value=0) as mock_ri:
            rc = m.main(["init", "--target", "/x"])
        mock_ri.assert_called_once_with(["--target", "/x"])
        self.assertEqual(rc, 0)

    def test_install_alias_still_routes_to_install(self):
        import agentrail.cli.main as m
        with patch("agentrail.cli.main.run_install", return_value=0) as mock_ri:
            rc = m.main(["install", "--github-labels"])
        mock_ri.assert_called_once_with(["--github-labels"])
        self.assertEqual(rc, 0)


# ---------------------------------------------------------------------------
# Safe in-place updates: managed blocks, atomic write + backup, dry-run preview
# ---------------------------------------------------------------------------

class TestSafeUpdates(TestCase):
    def setUp(self):
        self.repo = _make_repo()
        self.target = Path(tempfile.mkdtemp())

    def test_force_backs_up_previous_mcp_json(self):
        _run(self.repo, "claude", self.target)
        before = (self.target / ".mcp.json").read_text()
        _run(self.repo, "cursor", self.target)  # different file, no-op for .mcp.json
        # change something and force-rewrite to trigger a backup
        (self.target / ".mcp.json").write_text('{"mcpServers": {"other": {"command": "x"}}}')
        _run(self.repo, "claude", self.target, extra_args=["--force"])
        bak = self.target / ".mcp.json.bak"
        self.assertTrue(bak.exists(), "previous .mcp.json must be backed up before overwrite")
        # backup holds the pre-write content; live file has both servers merged
        data = json.loads((self.target / ".mcp.json").read_text())
        self.assertIn("other", data["mcpServers"])
        self.assertIn("agentrail-context", data["mcpServers"])

    def test_mcp_json_indent_preserved(self):
        mcp = self.target / ".mcp.json"
        mcp.write_text(json.dumps({"mcpServers": {"other": {"command": "x"}}}, indent=4))
        _run(self.repo, "claude", self.target)
        # 4-space indent detected and kept
        self.assertIn('\n    "mcpServers"', mcp.read_text())

    def test_codex_managed_block_preserves_comments(self):
        toml = self.target / ".codex" / "config.toml"
        toml.parent.mkdir(parents=True, exist_ok=True)
        toml.write_text('# my comment\n[other]\nkeep = "me"  # inline\n')
        _run(self.repo, "codex", self.target)
        _run(self.repo, "codex", self.target, extra_args=["--force"])
        content = toml.read_text()
        self.assertIn("# my comment", content)
        self.assertIn('keep = "me"  # inline', content)
        self.assertIn("# >>> agentrail-context", content)
        self.assertEqual(content.count("[mcp.servers.agentrail-context]"), 1)

    def test_invalid_json_prints_snippet_to_paste(self):
        import io
        from agentrail.cli.commands.init_agent import run_init_agent
        mcp = self.target / ".mcp.json"
        mcp.write_text('{ broken')
        buf = io.StringIO()
        with patch("agentrail.cli.commands.init_agent._repo_dir", return_value=self.repo), \
             patch("sys.stderr", buf), patch.dict(os.environ, {}, clear=False):
            rc = run_init_agent(["claude", "--target", str(self.target)])
        self.assertEqual(rc, 2)
        self.assertIn("agentrail-context", buf.getvalue())  # snippet printed
        self.assertEqual(mcp.read_text(), '{ broken')  # untouched

    def test_dry_run_writes_nothing(self):
        import io
        from agentrail.cli.commands.init_agent import run_init_agent
        out = io.StringIO()
        with patch("agentrail.cli.commands.init_agent._repo_dir", return_value=self.repo), \
             patch("sys.stdout", out), patch.dict(os.environ, {}, clear=False):
            rc = run_init_agent(["codex", "--target", str(self.target), "--print"])
        self.assertEqual(rc, 0)
        self.assertFalse((self.target / ".codex" / "config.toml").exists())
        self.assertFalse((self.target / "AGENTS.md").exists())
        self.assertIn("would write", out.getvalue())

    def test_agents_md_steering_updates_in_place(self):
        agents = self.target / "AGENTS.md"
        agents.write_text(
            "# Project\n\n<!-- agentrail-mcp:start -->\nOLD STALE BLOCK\n"
            "<!-- agentrail-mcp:end -->\n\n## Keep me\n"
        )
        _run(self.repo, "codex", self.target)
        content = agents.read_text()
        self.assertNotIn("OLD STALE BLOCK", content)
        self.assertIn("Context Retrieval (AgentRail MCP)", content)
        self.assertIn("# Project", content)
        self.assertIn("## Keep me", content)
        self.assertEqual(content.count("agentrail-mcp:start"), 1)
