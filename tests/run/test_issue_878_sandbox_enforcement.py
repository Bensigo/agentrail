"""Acceptance test for issue #878 — in-sandbox Context Compiler enforcement.

Authored by the TEST-AUTHOR role (ADR 0008). Must remain RED until the
Implementer creates agentrail/run/sandbox_enforcement.py.

## What it tests

Five acceptance criteria through the PUBLIC interface of the (not-yet-existing)
sandbox enforcement module:

  AC1 — Context Pack is injected as the sandboxed agent's *primary* (system-level)
         context, not merely advisory text appended to the issue prompt.
  AC2 — An in-sandbox enforcement hook blocks raw repo-wide search (Grep/Glob/
         bash grep/rg/find) *before* the agent queries the Context Compiler;
         after a query the block lifts. Denial message cites the context engine.
  AC3 — A bypass attempt (raw search blocked) is recorded as an audit/Run event
         and counted — making enforcement falsifiable (count can be read as 0).
  AC4 — A token delta between enforcement ON and the Raw-Agent Baseline is
         computed and returned as a signed number (can be ≤0 — no improvement).
  AC5 — Enforcement is OFF by default and toggled ON via config, enabling A/B.

## Red-Green proof

RED  (now):  agentrail.run.sandbox_enforcement does not exist → ImportError.
GREEN (after implementation): Implementer creates the module with the public
      interface below; all assertions must pass.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# This import is the primary RED signal: the module does not exist yet.
# The Implementer must create agentrail/run/sandbox_enforcement.py exposing
# the five callables below.
# ---------------------------------------------------------------------------
from agentrail.run.sandbox_enforcement import (
    compute_token_delta,       # AC4
    count_bypass_events,       # AC3
    install_sandbox_hooks,     # AC1 + AC2
    is_enforcement_enabled,    # AC5
    record_bypass_event,       # AC3
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _target_with_enforcement(tmp: Path, *, enabled: bool) -> Path:
    """Write a minimal .agentrail/config.json that controls enforcement."""
    agentrail_dir = tmp / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    config: dict = {}
    if enabled:
        config["enforcement"] = {"enabled": True}
    (agentrail_dir / "config.json").write_text(json.dumps(config))
    return tmp


# ---------------------------------------------------------------------------
# The single acceptance test
# ---------------------------------------------------------------------------

def test_sandbox_enforcement_all_acs(tmp_path: Path) -> None:
    """One acceptance test covering all five ACs for issue #878.

    Structure mirrors the verification evidence stated in the issue:
      1. AC5 toggle — enforcement off by default, on via config.
      2. AC1 system-level injection — context pack in .claude/settings.json,
         not only in issue prompt text.
      3. AC2 hook blocks / allows — subprocess the installed hook script with
         a raw-search payload; assert exit 2 before context query, exit 0 after.
      4. AC3 bypass events — count increments on each blocked attempt.
      5. AC4 token delta — compute_token_delta returns a signed number.
    """

    # -----------------------------------------------------------------------
    # AC5: enforcement is OFF by default; ON when config says so.
    # -----------------------------------------------------------------------
    off_dir = _target_with_enforcement(tmp_path / "off", enabled=False)
    assert is_enforcement_enabled(off_dir) is False, (
        "AC5: enforcement must default to OFF so it can be A/B'd against the "
        "Raw-Agent Baseline without touching agent code."
    )

    on_dir = _target_with_enforcement(tmp_path / "on", enabled=True)
    assert is_enforcement_enabled(on_dir) is True, (
        "AC5: enforcement must be ON when config.enforcement.enabled is true."
    )

    # -----------------------------------------------------------------------
    # AC1: install_sandbox_hooks writes the context pack as *system-level*
    # context in .claude/settings.json (not just appended to the issue prompt).
    # -----------------------------------------------------------------------
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    pack_text = "## Context Pack\n- key file: agentrail/run/pipeline.py\n- goal: Fix issue #878"
    run_id = "test-run-878"

    install_sandbox_hooks(repo_dir, context_pack_text=pack_text, run_id=run_id, target_dir=on_dir)

    claude_settings_path = repo_dir / ".claude" / "settings.json"
    assert claude_settings_path.exists(), (
        "AC1: install_sandbox_hooks must create .claude/settings.json in the "
        "sandbox repo so the context pack is injected at the system level."
    )
    settings = json.loads(claude_settings_path.read_text())
    # System-level context may live under systemPrompt, or an env var that
    # Claude Code reads before the user prompt.  Either key is acceptable;
    # what is NOT acceptable is the pack being absent from settings entirely.
    system_context = (
        settings.get("systemPrompt") or
        (settings.get("env") or {}).get("ANTHROPIC_SYSTEM_PROMPT", "")
    )
    assert pack_text in system_context, (
        "AC1: Context Pack must appear in the agent's system-level context "
        "(settings.systemPrompt or env.ANTHROPIC_SYSTEM_PROMPT), not only in "
        "the issue prompt text where the agent may skip it."
    )

    # -----------------------------------------------------------------------
    # AC2 (block): hook denies Grep *before* a context-engine query.
    # The hook script must be installed in .claude/hooks/ and exit 2 on a
    # raw-search payload; its stderr must mention the context engine.
    # -----------------------------------------------------------------------
    hook_path = repo_dir / ".claude" / "hooks" / "context-enforcement.sh"
    assert hook_path.exists(), (
        "AC2: install_sandbox_hooks must write .claude/hooks/context-enforcement.sh "
        "so Claude Code's PreToolUse hook blocks raw search in the sandbox."
    )

    grep_payload = json.dumps({"tool_name": "Grep", "tool_input": {"pattern": "foo", "path": "."}})
    hook_env = {
        **os.environ,
        "AGENTRAIL_RUN_ID": run_id,
        "AGENTRAIL_TARGET_DIR": str(on_dir),
    }

    blocked = subprocess.run(
        ["bash", str(hook_path)],
        input=grep_payload,
        capture_output=True,
        text=True,
        env=hook_env,
    )
    assert blocked.returncode == 2, (
        "AC2: the enforcement hook must exit 2 (Claude Code block convention) "
        "when the sandboxed agent attempts raw Grep before querying the context engine."
    )
    assert "context" in blocked.stderr.lower(), (
        "AC2: the denial message must reference the context engine so the agent "
        "knows how to proceed (observable, not silent)."
    )

    # -----------------------------------------------------------------------
    # AC3: the blocked call above was recorded as a bypass audit event.
    # count_bypass_events must return ≥1 and increment on subsequent blocks.
    # -----------------------------------------------------------------------
    bypass_count = count_bypass_events(on_dir, run_id)
    assert bypass_count >= 1, (
        "AC3: a blocked raw-search attempt must be persisted as an audit/Run event "
        "so bypass rate is observable and falsifiable (can be 0)."
    )

    # record_bypass_event is also part of the public API so audit events can be
    # written by any component (e.g., the hook emitting over a Unix socket).
    record_bypass_event(on_dir, run_id, tool_name="Bash", command="grep secret .")
    assert count_bypass_events(on_dir, run_id) == bypass_count + 1, (
        "AC3: count_bypass_events must increment when record_bypass_event is called."
    )

    # -----------------------------------------------------------------------
    # AC2 (allow): after the context-queried marker exists the hook lifts.
    # The marker file path is the contract; the Implementer picks the location.
    # -----------------------------------------------------------------------
    marker_dir = on_dir / ".agentrail" / "run"
    marker_dir.mkdir(parents=True, exist_ok=True)
    (marker_dir / f"{run_id}-context-queried").touch()

    allowed = subprocess.run(
        ["bash", str(hook_path)],
        input=grep_payload,
        capture_output=True,
        text=True,
        env=hook_env,
    )
    assert allowed.returncode == 0, (
        "AC2: the enforcement hook must exit 0 (allow) after the agent has queried "
        "the context engine, so it is not permanently blocked."
    )

    # -----------------------------------------------------------------------
    # AC4: compute_token_delta returns a signed number (can be ≤0).
    # Tests the reporting contract; actual measurement happens in the pipeline.
    # -----------------------------------------------------------------------
    enforcement_on_tokens = 8_000
    baseline_tokens = 10_000
    delta = compute_token_delta(
        enforcement_on_tokens=enforcement_on_tokens,
        baseline_tokens=baseline_tokens,
    )
    assert isinstance(delta, (int, float)), (
        "AC4: compute_token_delta must return a numeric token delta "
        "(int or float) so it can be logged and compared vs the Raw-Agent Baseline."
    )
    assert delta == enforcement_on_tokens - baseline_tokens, (
        "AC4: delta must be enforcement_on_tokens − baseline_tokens; "
        "a negative result (enforcement costs more tokens) must be representable — "
        "the metric is falsifiable, not a one-sided savings claim."
    )
