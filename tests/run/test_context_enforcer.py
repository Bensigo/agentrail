"""Acceptance test for issue #878 — in-sandbox Context Compiler enforcement.

RED proof: the module ``agentrail.run.context_enforcer`` does not exist.
Every import below fails immediately, so this test is genuinely failing now.
The Implementer turns it green; the Verifier confirms the red→green trail.

Acceptance criteria covered
----------------------------
AC2  An in-sandbox hook blocks raw repo-wide search (grep/find/glob/recursive
     ls) until the agent has queried the Context Compiler for the current task.
     The block is observable: the command is denied with a message pointing to
     the context engine.

AC3  A run that bypasses the context engine is recorded via an audit/Run Event
     and counted (bypass count), making enforcement falsifiable.

AC5  Enforcement is configurable (on/off) so it can be A/B'd against the
     Raw-Agent Baseline.

(AC1 — system-level context injection — and AC4 — measured token comparison —
are addressed in the implementation PR's evidence artefacts and pipeline
integration; this test covers the observable, unit-testable behavioural
contract.)
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def target_dir(tmp_path: Path) -> Path:
    """Minimal repo root with .agentrail/config.json (enforcement ON)."""
    agentrail = tmp_path / ".agentrail"
    agentrail.mkdir()
    (agentrail / "config.json").write_text(
        json.dumps({"enforcement": {"contextFirst": True}})
    )
    return tmp_path


@pytest.fixture()
def run_dir(tmp_path: Path) -> Path:
    d = tmp_path / "run" / "1"
    d.mkdir(parents=True)
    return d


# ---------------------------------------------------------------------------
# Payloads that represent blocked tool calls
# ---------------------------------------------------------------------------

_GREP_PAYLOAD = {"tool_name": "Grep", "tool_input": {"pattern": "def foo"}}
_GLOB_PAYLOAD = {"tool_name": "Glob", "tool_input": {"pattern": "**/*.py"}}
_BASH_GREP_PAYLOAD = {
    "tool_name": "Bash",
    "tool_input": {"command": "grep -r something ."},
}
_BASH_FIND_PAYLOAD = {
    "tool_name": "Bash",
    "tool_input": {"command": "find . -name '*.py'"},
}


# ---------------------------------------------------------------------------
# The ONE acceptance test
# ---------------------------------------------------------------------------

def test_context_enforcer_hook_lifecycle(target_dir: Path, run_dir: Path) -> None:
    """Full AC2 + AC3 + AC5 lifecycle through the public interface.

    Sequence:
      1. Enforcement ON → raw search is blocked; block message names the engine.
      2. Each blocked attempt increments the bypass counter (AC3 falsifiable).
      3. After ``record_context_queried``, the same payloads are allowed (AC2).
      4. Bypass counter does NOT increase for allowed calls.
      5. Enforcement OFF → search allowed immediately, no query required (AC5).
    """
    from agentrail.run.context_enforcer import (  # type: ignore[import]
        decide,
        get_bypass_count,
        is_enforcement_enabled,
        record_context_queried,
    )

    # ------------------------------------------------------------------ #
    # 1. Enforcement ON (read from .agentrail/config.json)                #
    # ------------------------------------------------------------------ #
    assert is_enforcement_enabled(target_dir) is True

    # ------------------------------------------------------------------ #
    # 2. AC2 — block before context-engine query                          #
    # ------------------------------------------------------------------ #
    for i, payload in enumerate(
        [_GREP_PAYLOAD, _GLOB_PAYLOAD, _BASH_GREP_PAYLOAD, _BASH_FIND_PAYLOAD],
        start=1,
    ):
        verdict, message = decide(payload, run_dir=run_dir, target_dir=target_dir)

        assert verdict == "block", (
            f"payload {payload['tool_name']} must be blocked before context query"
        )
        # AC2: block message must point to the context engine so the agent
        # knows what to do instead.
        assert "context" in message.lower(), (
            f"block message must mention the context engine; got: {message!r}"
        )

        # ---------------------------------------------------------------- #
        # 3. AC3 — bypass counter advances with every block                #
        # ---------------------------------------------------------------- #
        assert get_bypass_count(run_dir) == i, (
            f"bypass count must be {i} after {i} blocked call(s); "
            f"got {get_bypass_count(run_dir)}"
        )

    bypass_count_before_query = get_bypass_count(run_dir)

    # ------------------------------------------------------------------ #
    # 4. AC2 — allow after context-engine query                           #
    # ------------------------------------------------------------------ #
    record_context_queried(run_dir)

    for payload in [_GREP_PAYLOAD, _GLOB_PAYLOAD, _BASH_GREP_PAYLOAD, _BASH_FIND_PAYLOAD]:
        verdict_after, _ = decide(payload, run_dir=run_dir, target_dir=target_dir)
        assert verdict_after == "allow", (
            f"payload {payload['tool_name']} must be allowed after context query"
        )

    # AC3: counter must NOT advance for allowed calls.
    assert get_bypass_count(run_dir) == bypass_count_before_query, (
        "bypass count must not increase for allowed (post-query) calls"
    )

    # ------------------------------------------------------------------ #
    # 5. AC5 — enforcement OFF allows search without any prior query      #
    # ------------------------------------------------------------------ #
    (target_dir / ".agentrail" / "config.json").write_text(
        json.dumps({"enforcement": {"contextFirst": False}})
    )

    fresh_run_dir = target_dir / "run" / "2"
    fresh_run_dir.mkdir(parents=True)

    assert is_enforcement_enabled(target_dir) is False

    for payload in [_GREP_PAYLOAD, _GLOB_PAYLOAD, _BASH_GREP_PAYLOAD, _BASH_FIND_PAYLOAD]:
        verdict_off, _ = decide(payload, run_dir=fresh_run_dir, target_dir=target_dir)
        assert verdict_off == "allow", (
            f"enforcement OFF must allow {payload['tool_name']} without any context query"
        )

    # Bypass count on the fresh run must remain zero (nothing was blocked).
    assert get_bypass_count(fresh_run_dir) == 0
