"""Unit tests for forced-context injection (agentrail/run/context_inject.py).

Covers: the flag gate (DEFAULT OFF), and the per-engine artifact emitted for
claude / codex / cursor / unknown. The context text passed in must be reachable
in every emitted artifact (we reuse the retrieved context verbatim; nothing is
recomputed here).
"""
from __future__ import annotations

import json

import pytest

from agentrail.run import context_inject as ci

CONTEXT = "RETRIEVED-CTX: the auth handler lives in src/auth.py::login (line 42)."


# --------------------------------------------------------------------------- #
# Flag gate (DEFAULT OFF).
# --------------------------------------------------------------------------- #
def test_flag_on_by_default(tmp_path, monkeypatch):
    # DEFAULT ON: no env var, no config → forced_context_enabled returns True.
    monkeypatch.delenv("AGENTRAIL_FORCED_CONTEXT", raising=False)
    assert ci.forced_context_enabled(tmp_path) is True


def test_flag_off_via_env_emits_nothing(tmp_path, monkeypatch):
    # Explicitly setting AGENTRAIL_FORCED_CONTEXT=0 disables the flag.
    monkeypatch.setenv("AGENTRAIL_FORCED_CONTEXT", "0")
    assert ci.forced_context_enabled(tmp_path) is False
    # With flag off, no artifacts for any engine.
    for engine in ("claude", "codex", "cursor"):
        assert ci.emit_forced_context(engine, tmp_path, CONTEXT) == []
    assert not (tmp_path / ".claude").exists()
    assert not (tmp_path / "AGENTS.md").exists()
    assert not (tmp_path / ".cursor").exists()


def test_flag_off_via_config_emits_nothing(tmp_path, monkeypatch):
    # Setting runners.forcedContext=false in config overrides the default ON.
    monkeypatch.delenv("AGENTRAIL_FORCED_CONTEXT", raising=False)
    cfg_dir = tmp_path / ".agentrail"
    cfg_dir.mkdir()
    (cfg_dir / "config.json").write_text(json.dumps({"runners": {"forcedContext": False}}))
    assert ci.forced_context_enabled(tmp_path) is False
    for engine in ("claude", "codex", "cursor"):
        assert ci.emit_forced_context(engine, tmp_path, CONTEXT) == []


def test_flag_on_via_config(tmp_path, monkeypatch):
    monkeypatch.delenv("AGENTRAIL_FORCED_CONTEXT", raising=False)
    cfg_dir = tmp_path / ".agentrail"
    cfg_dir.mkdir()
    (cfg_dir / "config.json").write_text(json.dumps({"runners": {"forcedContext": True}}))
    assert ci.forced_context_enabled(tmp_path) is True


def test_flag_env_override_wins(tmp_path, monkeypatch):
    cfg_dir = tmp_path / ".agentrail"
    cfg_dir.mkdir()
    (cfg_dir / "config.json").write_text(json.dumps({"runners": {"forcedContext": True}}))
    # Env "0" overrides a config "true".
    monkeypatch.setenv("AGENTRAIL_FORCED_CONTEXT", "0")
    assert ci.forced_context_enabled(tmp_path) is False
    monkeypatch.setenv("AGENTRAIL_FORCED_CONTEXT", "1")
    assert ci.forced_context_enabled(tmp_path) is True


def test_empty_context_emits_nothing_even_when_on(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTRAIL_FORCED_CONTEXT", "1")
    assert ci.emit_forced_context("claude", tmp_path, "   ") == []
    assert not (tmp_path / ".claude").exists()


# --------------------------------------------------------------------------- #
# Per-engine artifacts (flag ON).
# --------------------------------------------------------------------------- #
@pytest.fixture
def on(monkeypatch):
    monkeypatch.setenv("AGENTRAIL_FORCED_CONTEXT", "1")


def test_claude_emits_userpromptsubmit_hook_with_reachable_context(tmp_path, on):
    written = ci.emit_forced_context("claude", tmp_path, CONTEXT)
    assert ci.CLAUDE_SETTINGS in written
    assert ci.CONTEXT_MD in written
    assert ci.CLAUDE_HOOK_SCRIPT in written

    settings = json.loads((tmp_path / ci.CLAUDE_SETTINGS).read_text())
    ups = settings["hooks"]["UserPromptSubmit"]
    assert isinstance(ups, list) and ups, "UserPromptSubmit hook must be present"
    commands = [
        h.get("command")
        for entry in ups
        for h in entry.get("hooks", [])
    ]
    assert any("forced-context.sh" in (c or "") for c in commands)

    # The context is reachable via the file the hook cats into additionalContext.
    ctx_md = (tmp_path / ci.CONTEXT_MD).read_text()
    assert CONTEXT in ctx_md

    # The hook script emits the additionalContext envelope and reads context.md.
    script = (tmp_path / ci.CLAUDE_HOOK_SCRIPT).read_text()
    assert "additionalContext" in script
    assert "UserPromptSubmit" in script
    assert ".agentrail/context.md" in script


def test_claude_merges_without_clobbering_existing_settings(tmp_path, on):
    settings_path = tmp_path / ci.CLAUDE_SETTINGS
    settings_path.parent.mkdir(parents=True)
    settings_path.write_text(json.dumps({
        "env": {"FOO": "bar"},
        "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": []}]},
    }))
    ci.emit_forced_context("claude", tmp_path, CONTEXT)
    settings = json.loads(settings_path.read_text())
    # Existing keys preserved.
    assert settings["env"] == {"FOO": "bar"}
    assert "PreToolUse" in settings["hooks"]
    # Our hook added.
    assert "UserPromptSubmit" in settings["hooks"]


def test_claude_is_idempotent(tmp_path, on):
    ci.emit_forced_context("claude", tmp_path, CONTEXT)
    ci.emit_forced_context("claude", tmp_path, CONTEXT)
    settings = json.loads((tmp_path / ci.CLAUDE_SETTINGS).read_text())
    ups = settings["hooks"]["UserPromptSubmit"]
    # Re-running must not duplicate the hook entry.
    assert len(ups) == 1


def test_cursor_emits_mdc_with_alwaysapply_and_context(tmp_path, on):
    written = ci.emit_forced_context("cursor", tmp_path, CONTEXT)
    assert written == [ci.CURSOR_RULE]
    text = (tmp_path / ci.CURSOR_RULE).read_text()
    assert text.startswith("---\n")
    assert "alwaysApply: true" in text
    assert CONTEXT in text


def test_codex_emits_agents_md_with_context(tmp_path, on):
    written = ci.emit_forced_context("codex", tmp_path, CONTEXT)
    assert written == [ci.AGENTS_MD]
    text = (tmp_path / ci.AGENTS_MD).read_text()
    assert CONTEXT in text
    assert ci._AGENTS_START in text and ci._AGENTS_END in text


def test_codex_preserves_user_agents_md_and_is_idempotent(tmp_path, on):
    agents = tmp_path / ci.AGENTS_MD
    agents.write_text("# My project\n\nUse tabs not spaces.\n")
    ci.emit_forced_context("codex", tmp_path, CONTEXT)
    ci.emit_forced_context("codex", tmp_path, CONTEXT)
    text = agents.read_text()
    # User content preserved.
    assert "Use tabs not spaces." in text
    # Managed block present exactly once (idempotent re-run replaces in place).
    assert text.count(ci._AGENTS_START) == 1
    assert text.count(ci._AGENTS_END) == 1
    assert CONTEXT in text


def test_unknown_engine_is_noop(tmp_path, on):
    assert ci.emit_forced_context("aider", tmp_path, CONTEXT) == []
    assert ci.emit_forced_context("", tmp_path, CONTEXT) == []
    # Nothing written.
    assert not (tmp_path / ".claude").exists()
    assert not (tmp_path / "AGENTS.md").exists()
    assert not (tmp_path / ".cursor").exists()


def test_engine_accepts_command_prefix(tmp_path, on):
    # Engine strings may carry a full command; the leading token decides.
    written = ci.emit_forced_context("claude --print", tmp_path, CONTEXT)
    assert ci.CLAUDE_SETTINGS in written
