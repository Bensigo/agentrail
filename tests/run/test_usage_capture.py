"""Tests for agentrail/run/usage_capture.py.

All filesystem access is redirected into tmp_path fixtures so tests are
isolated from the real ~/.claude and ~/.codex directories.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from agentrail.run.usage_capture import Usage, capture_usage, _claude_projects_dir


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec) + "\n")


def _set_mtime(path: Path, ts: float) -> None:
    os.utime(path, (ts, ts))


# ---------------------------------------------------------------------------
# Claude extractor tests
# ---------------------------------------------------------------------------

class TestClaudeExtractor:
    def _make_projects_dir(self, tmp_path: Path, target: Path) -> Path:
        encoded = str(target.resolve()).replace("/", "-")
        projects_dir = tmp_path / "claude" / ".claude" / "projects" / encoded
        projects_dir.mkdir(parents=True, exist_ok=True)
        return projects_dir

    def test_basic_usage_extraction(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        projects_dir = self._make_projects_dir(tmp_path, target)

        since = time.time() - 60
        transcript = projects_dir / "session.jsonl"
        _write_jsonl(transcript, [
            {"message": {"usage": {"input_tokens": 100, "output_tokens": 50,
                                   "cache_read_input_tokens": 20},
                         "model": "claude-opus-4-6"}},
            {"message": {"usage": {"input_tokens": 200, "output_tokens": 80,
                                   "cache_read_input_tokens": 30},
                         "model": "claude-opus-4-6"}},
        ])
        _set_mtime(transcript, time.time())

        fake_home = tmp_path / "claude"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            result = capture_usage("claude", target, since)

        assert result is not None
        assert result.model == "claude-opus-4-6"
        assert result.input_tokens == 300
        assert result.output_tokens == 130
        assert result.cache_tokens == 50

    def test_since_ts_excludes_older_files(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        projects_dir = self._make_projects_dir(tmp_path, target)

        since = time.time()
        transcript = projects_dir / "old.jsonl"
        _write_jsonl(transcript, [
            {"message": {"usage": {"input_tokens": 999, "output_tokens": 999,
                                   "cache_read_input_tokens": 0},
                         "model": "claude-opus-4-6"}},
        ])
        # Set mtime to before since_ts
        _set_mtime(transcript, since - 10)

        fake_home = tmp_path / "claude"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            result = capture_usage("claude", target, since)

        assert result is None

    def test_missing_projects_dir_returns_none(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        fake_home = tmp_path / "nonexistent"

        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            result = capture_usage("claude", target, 0.0)

        assert result is None

    def test_malformed_lines_are_skipped(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        projects_dir = self._make_projects_dir(tmp_path, target)

        since = time.time() - 60
        transcript = projects_dir / "session.jsonl"
        with transcript.open("w") as fh:
            fh.write("NOT JSON\n")
            fh.write('{"message": {"usage": {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 0}, "model": "claude-haiku-4-5"}}\n')
            fh.write("{broken\n")
        _set_mtime(transcript, time.time())

        fake_home = tmp_path / "claude"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            result = capture_usage("claude", target, since)

        assert result is not None
        assert result.input_tokens == 10
        assert result.output_tokens == 5
        assert result.model == "claude-haiku-4-5"

    def test_no_usage_fields_returns_none(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        projects_dir = self._make_projects_dir(tmp_path, target)

        since = time.time() - 60
        transcript = projects_dir / "session.jsonl"
        _write_jsonl(transcript, [
            {"type": "summary", "content": "No usage here"},
        ])
        _set_mtime(transcript, time.time())

        fake_home = tmp_path / "claude"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            result = capture_usage("claude", target, since)

        assert result is None


# ---------------------------------------------------------------------------
# Codex extractor tests
# ---------------------------------------------------------------------------

class TestCodexExtractor:
    def _make_session_dir(self, tmp_path: Path, session_id: str) -> Path:
        session_dir = tmp_path / "codex" / ".codex" / "sessions" / session_id
        session_dir.mkdir(parents=True, exist_ok=True)
        return session_dir

    def _make_rollout(self, session_dir: Path, target_cwd: str,
                      model: str, token_usage: dict, mtime: float | None = None) -> Path:
        rollout = session_dir / "rollout-001.jsonl"
        _write_jsonl(rollout, [
            {"type": "session_meta", "cwd": target_cwd},
            {"type": "turn_context", "model": model},
            {"type": "token_count", "info": {"total_token_usage": token_usage}},
        ])
        if mtime is not None:
            _set_mtime(rollout, mtime)
        return rollout

    def test_basic_usage_extraction(self, tmp_path: Path) -> None:
        target = tmp_path / "myrepo"
        target.mkdir()
        session_dir = self._make_session_dir(tmp_path, "sess-abc")
        since = time.time() - 60
        rollout = self._make_rollout(
            session_dir, str(target.resolve()), "gpt-4o",
            {"input_tokens": 500, "output_tokens": 200, "cached_input_tokens": 100,
             "reasoning_output_tokens": 0},
            mtime=time.time(),
        )

        fake_home = tmp_path / "codex"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            result = capture_usage("codex", target, since)

        assert result is not None
        assert result.model == "gpt-4o"
        assert result.input_tokens == 500
        assert result.output_tokens == 200
        assert result.cache_tokens == 100

    def test_cwd_mismatch_excluded(self, tmp_path: Path) -> None:
        target = tmp_path / "myrepo"
        target.mkdir()
        other = tmp_path / "otherrepo"
        session_dir = self._make_session_dir(tmp_path, "sess-xyz")
        since = time.time() - 60
        self._make_rollout(
            session_dir, str(other.resolve()), "gpt-4o",
            {"input_tokens": 999, "output_tokens": 999, "cached_input_tokens": 0},
            mtime=time.time(),
        )

        fake_home = tmp_path / "codex"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            result = capture_usage("codex", target, since)

        assert result is None

    def test_since_ts_excludes_older_files(self, tmp_path: Path) -> None:
        target = tmp_path / "myrepo"
        target.mkdir()
        session_dir = self._make_session_dir(tmp_path, "sess-old")
        since = time.time()
        rollout = self._make_rollout(
            session_dir, str(target.resolve()), "gpt-4o",
            {"input_tokens": 999, "output_tokens": 999, "cached_input_tokens": 0},
            mtime=since - 30,
        )

        fake_home = tmp_path / "codex"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            result = capture_usage("codex", target, since)

        assert result is None

    def test_missing_sessions_dir_returns_none(self, tmp_path: Path) -> None:
        target = tmp_path / "myrepo"
        target.mkdir()
        # fake_home has no .codex/sessions subdir
        fake_home = tmp_path / "empty_home"
        fake_home.mkdir()

        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            result = capture_usage("codex", target, 0.0)

        assert result is None

    def test_malformed_lines_are_skipped(self, tmp_path: Path) -> None:
        target = tmp_path / "myrepo"
        target.mkdir()
        session_dir = self._make_session_dir(tmp_path, "sess-bad")
        since = time.time() - 60
        rollout = session_dir / "rollout-001.jsonl"
        with rollout.open("w") as fh:
            fh.write('{"type": "session_meta", "cwd": "' + str(target.resolve()) + '"}\n')
            fh.write("BADJSON\n")
            fh.write("{another bad line\n")
            fh.write('{"type": "turn_context", "model": "gpt-4o"}\n')
            fh.write('{"type": "token_count", "info": {"total_token_usage": {"input_tokens": 42, "output_tokens": 10, "cached_input_tokens": 5}}}\n')
        _set_mtime(rollout, time.time())

        fake_home = tmp_path / "codex"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            result = capture_usage("codex", target, since)

        assert result is not None
        assert result.input_tokens == 42
        assert result.output_tokens == 10
        assert result.cache_tokens == 5

    def test_no_token_count_event_returns_none(self, tmp_path: Path) -> None:
        target = tmp_path / "myrepo"
        target.mkdir()
        session_dir = self._make_session_dir(tmp_path, "sess-empty")
        since = time.time() - 60
        rollout = session_dir / "rollout-001.jsonl"
        _write_jsonl(rollout, [
            {"type": "session_meta", "cwd": str(target.resolve())},
            {"type": "turn_context", "model": "gpt-4o"},
        ])
        _set_mtime(rollout, time.time())

        fake_home = tmp_path / "codex"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            result = capture_usage("codex", target, since)

        assert result is None


# ---------------------------------------------------------------------------
# Unknown agent
# ---------------------------------------------------------------------------

class TestUnknownAgent:
    def test_unknown_agent_returns_none(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        assert capture_usage("hermes", target, 0.0) is None
        assert capture_usage("cursor", target, 0.0) is None
        assert capture_usage("custom-bot", target, 0.0) is None
