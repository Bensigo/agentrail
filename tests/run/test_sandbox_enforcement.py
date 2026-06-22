"""Acceptance test for issue #878: in-sandbox Context Compiler enforcement.

RED-GREEN CONTRACT (ADR 0008)
-----------------------------
This test MUST be red before any implementation and green after the Implementer's
change.  The Implementer's job is to create ``agentrail/run/sandbox_enforcement.py``
with the public interface exercised here.  Do NOT modify this file to make the test
pass — that defeats the anti-false-green proof.

Acceptance criteria covered
---------------------------
AC2 — An in-sandbox enforcement hook blocks raw repo-wide search
       (Grep / Glob / Bash grep|rg|find) until the agent has queried the Context
       Compiler for the current task.  The block is observable: the call is denied
       with a message that points to the context engine.

AC3 — A blocked bypass attempt is recorded as an audit event and the bypass count
       in the local ledger is incremented, making enforcement falsifiable.

AC5 — Enforcement is configurable: when the context-first flag is OFF in
       ``.agentrail/config.json``, the same tool call is allowed unconditionally.
"""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

# This import FAILS until the Implementer creates the module — that is the red
# state.  The module must expose the three callables exercised below.
from agentrail.run.sandbox_enforcement import (
    evaluate_tool_use,    # (tool_name, tool_input, *, context_queried, enforcement_enabled) -> ("allow"|"block", str)
    record_bypass_attempt,  # (target_dir, run_id, tool_name, command="") -> None
    read_bypass_events,    # (target_dir) -> list[dict]
    is_enforcement_enabled, # (target_dir) -> bool
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _target_with_enforcement(tmp_path: Path, enabled: bool) -> Path:
    """Write a minimal .agentrail/config.json with enforcement on or off."""
    agentrail_dir = tmp_path / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    (agentrail_dir / "config.json").write_text(
        json.dumps({
            "schemaVersion": 1,
            "verify": "true",
            "enforcement": {
                "context_first": enabled,
            },
        }),
        encoding="utf-8",
    )
    return tmp_path


# ---------------------------------------------------------------------------
# Acceptance test
# ---------------------------------------------------------------------------

class TestContextFirstEnforcement:
    """Single acceptance test class covering AC2, AC3, and AC5 for issue #878.

    The scenario mirrors a real sandboxed agent session:
      1. Enforcement ON, agent has NOT yet queried the context engine
         → raw search is BLOCKED with a pointer to `agentrail context query`.
      2. The blocked call is RECORDED as a bypass audit event (count = 1).
      3. After the agent issues a context engine query (context_queried=True)
         → the same raw search is ALLOWED.
      4. Enforcement OFF (config flag) → raw search is ALLOWED from the start,
         no bypass events recorded.
    """

    # ------------------------------------------------------------------
    # AC2 — block before context query
    # ------------------------------------------------------------------

    def test_raw_grep_blocked_before_context_query(self, tmp_path):
        """AC2: Grep tool call is blocked when enforcement=ON and no context query yet."""
        verdict, message = evaluate_tool_use(
            "Grep",
            {"pattern": "build_context_pack", "path": "."},
            context_queried=False,
            enforcement_enabled=True,
        )
        assert verdict == "block", (
            "Expected 'block' for a Grep call before any context-engine query, got %r" % verdict
        )
        # Message must be non-empty and point the agent to the context engine.
        assert message, "Block message must be non-empty"
        assert "agentrail context" in message.lower() or "context" in message.lower(), (
            "Block message must reference the context engine so the agent knows what to do instead"
        )

    def test_bash_grep_blocked_before_context_query(self, tmp_path):
        """AC2: Bash(grep ...) is blocked when enforcement=ON and no prior context query."""
        verdict, message = evaluate_tool_use(
            "Bash",
            {"command": "grep -r 'build_context_pack' ."},
            context_queried=False,
            enforcement_enabled=True,
        )
        assert verdict == "block"
        assert message

    def test_glob_blocked_before_context_query(self, tmp_path):
        """AC2: Glob tool call is blocked when enforcement=ON and no context query yet."""
        verdict, message = evaluate_tool_use(
            "Glob",
            {"pattern": "**/*.py"},
            context_queried=False,
            enforcement_enabled=True,
        )
        assert verdict == "block"
        assert message

    # ------------------------------------------------------------------
    # AC2 — allow after context query
    # ------------------------------------------------------------------

    def test_raw_search_allowed_after_context_query(self, tmp_path):
        """AC2: Once the agent has queried the context engine, raw search is allowed."""
        verdict, message = evaluate_tool_use(
            "Grep",
            {"pattern": "build_context_pack", "path": "."},
            context_queried=True,
            enforcement_enabled=True,
        )
        assert verdict == "allow", (
            "Expected 'allow' after a context-engine query, got %r (message=%r)" % (verdict, message)
        )

    # ------------------------------------------------------------------
    # AC3 — bypass events are recorded
    # ------------------------------------------------------------------

    def test_bypass_attempt_recorded_in_ledger(self, tmp_path):
        """AC3: record_bypass_attempt appends an audit event; bypass count rises."""
        target = _target_with_enforcement(tmp_path, enabled=True)

        # No events before any bypass.
        assert read_bypass_events(target) == []

        record_bypass_attempt(target, run_id="run-test-001", tool_name="Grep", command="")

        events = read_bypass_events(target)
        assert len(events) == 1, "Expected exactly one bypass event after one blocked call"

        event = events[0]
        assert event.get("tool_name") == "Grep", "Event must record the blocked tool name"
        assert event.get("run_id") == "run-test-001", "Event must record the run_id"

    def test_bypass_count_accumulates(self, tmp_path):
        """AC3: Multiple bypass attempts accumulate in the ledger (bypass_count is falsifiable)."""
        target = _target_with_enforcement(tmp_path, enabled=True)

        record_bypass_attempt(target, run_id="run-test-002", tool_name="Glob", command="**/*.py")
        record_bypass_attempt(target, run_id="run-test-002", tool_name="Bash", command="find . -name '*.py'")

        events = read_bypass_events(target)
        assert len(events) == 2, (
            "Each blocked call must produce one audit event; got %d" % len(events)
        )

    # ------------------------------------------------------------------
    # AC5 — enforcement is configurable (on/off)
    # ------------------------------------------------------------------

    def test_is_enforcement_enabled_reads_config(self, tmp_path):
        """AC5: is_enforcement_enabled returns True/False from config."""
        on_target = _target_with_enforcement(tmp_path / "on", enabled=True)
        off_target = _target_with_enforcement(tmp_path / "off", enabled=False)

        assert is_enforcement_enabled(on_target) is True
        assert is_enforcement_enabled(off_target) is False

    def test_enforcement_off_allows_raw_search(self, tmp_path):
        """AC5: When enforcement_enabled=False, raw search is always allowed."""
        verdict, _message = evaluate_tool_use(
            "Grep",
            {"pattern": "build_context_pack", "path": "."},
            context_queried=False,
            enforcement_enabled=False,
        )
        assert verdict == "allow", (
            "With enforcement OFF, Grep must be allowed regardless of context_queried"
        )

    def test_enforcement_disabled_in_config_allows_raw_search(self, tmp_path):
        """AC5: End-to-end: config flag OFF → evaluate_tool_use allows search."""
        target = _target_with_enforcement(tmp_path, enabled=False)

        # is_enforcement_enabled reads config → False
        assert is_enforcement_enabled(target) is False

        # A caller wiring enforcement_enabled from config gets 'allow'.
        verdict, _message = evaluate_tool_use(
            "Glob",
            {"pattern": "**/*.py"},
            context_queried=False,
            enforcement_enabled=is_enforcement_enabled(target),
        )
        assert verdict == "allow"
