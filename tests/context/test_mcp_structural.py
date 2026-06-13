"""Subprocess roundtrip tests for context_def and context_impact MCP tools.

AC4: pytest tests/context/test_mcp_structural.py passes — subprocess roundtrip for
context_def returns a non-empty house-schema JSON array against a real indexed
fixture repo. context_impact is skipped when the CLI does not yet support it
(blocked by issue #587) so this suite stays green now and auto-activates on merge.

Protocol: MCP stdio uses newline-delimited JSON-RPC 2.0 messages.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional

from agentrail.context.index import build_index

# ---------------------------------------------------------------------------
# Fixture repo helper (mirrors make_multi_def_repo from test_global_symbol_table)
# ---------------------------------------------------------------------------

def _make_indexed_repo() -> Path:
    """Create a small git repo with two Python files defining 'process', indexed."""
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(
        json.dumps({
            "schemaVersion": 1,
            "context": {
                "includeGlobs": ["**/*.py"],
                "excludeGlobs": [".git/**", ".agentrail/context/**"],
                "maxFileSizeBytes": 262144,
                "skipBinary": True,
                "respectGitIgnore": False,
                "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
                "embedding": {"mode": "disabled", "provider": None, "model": None},
                "summary": {"mode": "disabled", "provider": None, "model": None},
            },
        }, indent=2),
        encoding="utf-8",
    )
    (root / "alpha.py").write_text("def process():\n    return 1\n", encoding="utf-8")
    (root / "beta.py").write_text("def process():\n    return 2\n", encoding="utf-8")
    build_index(root)
    return root


# ---------------------------------------------------------------------------
# Check whether context impact CLI is available
# ---------------------------------------------------------------------------

def _impact_cli_available() -> bool:
    """Return True if `agentrail context impact` is a recognised subcommand."""
    try:
        result = subprocess.run(
            ["agentrail", "context", "impact", "_probe_", "--json"],
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        # `agentrail` binary not on PATH (e.g. CI runs pytest without the shim).
        # Mirror _node_available: treat an absent binary as "not available" so
        # the impact suite skips cleanly instead of erroring at collection.
        return False
    # If the exit message starts with "Unknown context command" it is absent.
    return "Unknown context command" not in (result.stderr or "")


_IMPACT_CLI_AVAILABLE = _impact_cli_available()


# ---------------------------------------------------------------------------
# MCP stdio JSON-RPC helpers
# ---------------------------------------------------------------------------

_MCP_DIST = Path(__file__).resolve().parents[2] / "packages" / "mcp" / "dist" / "index.js"


def _node_available() -> bool:
    try:
        subprocess.run(["node", "--version"], capture_output=True, check=True)
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


def _dist_available() -> bool:
    return _MCP_DIST.exists()


def _call_mcp_tool(
    tool_name: str,
    arguments: Dict[str, Any],
    target: str,
    timeout: float = 30.0,
) -> Dict[str, Any]:
    """Spawn the MCP server, perform one tools/call, and return the JSON-RPC result."""
    agentrail_bin = os.environ.get("AGENTRAIL_BIN", "agentrail")
    env = {**os.environ, "AGENTRAIL_BIN": agentrail_bin, "AGENTRAIL_TARGET": target}

    proc = subprocess.Popen(
        ["node", str(_MCP_DIST)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        text=True,
    )

    # Collect stdout lines in a background thread so reads don't block forever.
    lines: List[str] = []
    read_done = threading.Event()

    def _reader() -> None:
        assert proc.stdout is not None
        try:
            for line in proc.stdout:
                stripped = line.strip()
                if stripped:
                    lines.append(stripped)
                # Stop after we have both the initialize response (id=1) and the
                # tool call response (id=2).
                if len(lines) >= 2:
                    break
        finally:
            read_done.set()

    reader_thread = threading.Thread(target=_reader, daemon=True)
    reader_thread.start()

    try:
        assert proc.stdin is not None
        # Step 1: initialize
        init_req = json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "test-client", "version": "1.0"},
            },
        })
        proc.stdin.write(init_req + "\n")
        proc.stdin.flush()

        # Step 2: initialized notification (no id → no response)
        initialized_notif = json.dumps({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {},
        })
        proc.stdin.write(initialized_notif + "\n")
        proc.stdin.flush()

        # Step 3: tools/call
        call_req = json.dumps({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        })
        proc.stdin.write(call_req + "\n")
        proc.stdin.flush()

        read_done.wait(timeout=timeout)
    finally:
        proc.stdin.close() if proc.stdin else None
        proc.wait(timeout=5)

    # Find the response with id=2
    for raw in lines:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if msg.get("id") == 2:
            return msg

    raise AssertionError(
        f"No response with id=2 received from MCP server.\n"
        f"Lines received: {lines}\n"
        f"stderr: {proc.stderr.read() if proc.stderr else ''}"
    )


# ---------------------------------------------------------------------------
# House-schema validation helpers
# ---------------------------------------------------------------------------

_HOUSE_SCHEMA_KEYS = {"path", "lineStart", "lineEnd", "content", "citation", "reason", "score", "tokenEstimate", "deterministic"}


def _assert_house_schema(items: List[Dict[str, Any]], label: str) -> None:
    assert len(items) > 0, f"{label}: expected non-empty result list"
    for i, item in enumerate(items):
        missing = _HOUSE_SCHEMA_KEYS - item.keys()
        assert not missing, f"{label}[{i}] missing house-schema fields: {missing}"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@unittest.skipUnless(_node_available(), "node not available")
@unittest.skipUnless(_dist_available(), "packages/mcp/dist/index.js not built — run: cd packages/mcp && npm run build")
class TestMcpContextDef(unittest.TestCase):
    """AC4: context_def MCP tool returns non-empty house-schema JSON via subprocess roundtrip."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.repo = str(_make_indexed_repo())

    def test_context_def_roundtrip(self) -> None:
        msg = _call_mcp_tool("context_def", {"name": "process"}, self.repo)
        self.assertNotIn("error", msg, f"MCP error response: {msg}")
        result = msg.get("result", {})
        self.assertFalse(result.get("isError"), f"Tool returned isError: {result}")

        # Parse house-schema JSON from the text content
        content_list = result.get("content", [])
        self.assertTrue(content_list, "No content in MCP response")
        text = content_list[0].get("text", "")
        items = json.loads(text)
        self.assertIsInstance(items, list)
        _assert_house_schema(items, "context_def")

    def test_context_def_paths_include_fixture_files(self) -> None:
        msg = _call_mcp_tool("context_def", {"name": "process"}, self.repo)
        result = msg.get("result", {})
        text = result.get("content", [{}])[0].get("text", "[]")
        items = json.loads(text)
        paths = [item["path"] for item in items]
        self.assertIn("alpha.py", paths, f"alpha.py missing from context_def results: {paths}")
        self.assertIn("beta.py", paths, f"beta.py missing from context_def results: {paths}")


@unittest.skipUnless(_node_available(), "node not available")
@unittest.skipUnless(_dist_available(), "packages/mcp/dist/index.js not built — run: cd packages/mcp && npm run build")
@unittest.skipUnless(_IMPACT_CLI_AVAILABLE, "agentrail context impact not yet implemented (blocked by issue #587)")
class TestMcpContextImpact(unittest.TestCase):
    """AC4 (impact): context_impact MCP tool roundtrip — skipped until issue #587 merges."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.repo = str(_make_indexed_repo())

    def test_context_impact_roundtrip(self) -> None:
        msg = _call_mcp_tool("context_impact", {"name": "process"}, self.repo)
        self.assertNotIn("error", msg, f"MCP error response: {msg}")
        result = msg.get("result", {})
        self.assertFalse(result.get("isError"), f"Tool returned isError: {result}")

        text = result.get("content", [{}])[0].get("text", "[]")
        items = json.loads(text)
        self.assertIsInstance(items, list)
        _assert_house_schema(items, "context_impact")

    def test_context_impact_depth_parameter(self) -> None:
        msg = _call_mcp_tool("context_impact", {"name": "process", "depth": 2}, self.repo)
        self.assertNotIn("error", msg, f"MCP error response: {msg}")
        result = msg.get("result", {})
        self.assertFalse(result.get("isError"), f"Tool returned isError: {result}")


if __name__ == "__main__":
    unittest.main()
