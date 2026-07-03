"""Tests for agentrail/run/usage_capture.py.

All filesystem access is redirected into tmp_path fixtures so tests are
isolated from the real ~/.claude and ~/.codex directories.
"""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from agentrail.run.usage_capture import (
    Usage,
    capture_usage,
    capture_reads,
    record_reads_into_run_json,
    _claude_projects_dir,
)


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
        encoded = re.sub(r"[^A-Za-z0-9-]", "-", str(target.resolve()))
        projects_dir = tmp_path / "claude" / ".claude" / "projects" / encoded
        projects_dir.mkdir(parents=True, exist_ok=True)
        return projects_dir

    def test_encodes_dots_like_claude(self, tmp_path: Path) -> None:
        # afk worktrees live under '.afk/'; Claude encodes '.' as '-' too,
        # so '/repo/.afk/wt' must resolve to '...-repo--afk-wt'.
        target = tmp_path / "repo" / ".afk" / "wt"
        assert ".afk" not in _claude_projects_dir(target).name
        assert "--afk-" in _claude_projects_dir(target).name

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

    def test_captures_cache_creation_tokens(self, tmp_path: Path) -> None:
        """AC1: cache_creation_input_tokens is summed into cache_creation_tokens."""
        target = tmp_path / "repo"
        target.mkdir()
        projects_dir = self._make_projects_dir(tmp_path, target)

        since = time.time() - 60
        transcript = projects_dir / "session.jsonl"
        _write_jsonl(transcript, [
            {"message": {"usage": {"input_tokens": 100, "output_tokens": 50,
                                   "cache_read_input_tokens": 20,
                                   "cache_creation_input_tokens": 1000},
                         "model": "claude-opus-4-6"}},
            {"message": {"usage": {"input_tokens": 200, "output_tokens": 80,
                                   "cache_read_input_tokens": 30,
                                   "cache_creation_input_tokens": 500},
                         "model": "claude-opus-4-6"}},
        ])
        _set_mtime(transcript, time.time())

        fake_home = tmp_path / "claude"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            result = capture_usage("claude", target, since)

        assert result is not None
        assert result.cache_creation_tokens == 1500
        # cache_read tokens are kept distinct from cache_creation tokens.
        assert result.cache_tokens == 50

    def test_missing_cache_creation_defaults_to_zero(self, tmp_path: Path) -> None:
        """Transcripts without cache_creation_input_tokens yield 0 (back-compat)."""
        target = tmp_path / "repo"
        target.mkdir()
        projects_dir = self._make_projects_dir(tmp_path, target)

        since = time.time() - 60
        transcript = projects_dir / "session.jsonl"
        _write_jsonl(transcript, [
            {"message": {"usage": {"input_tokens": 100, "output_tokens": 50,
                                   "cache_read_input_tokens": 20},
                         "model": "claude-opus-4-6"}},
        ])
        _set_mtime(transcript, time.time())

        fake_home = tmp_path / "claude"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            result = capture_usage("claude", target, since)

        assert result is not None
        assert result.cache_creation_tokens == 0

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


# ===========================================================================
# Read harvest (transcript-scrape): capture_reads → run.json
# ===========================================================================


class TestClaudeReadHarvest:
    """AC1: a claude run's harvested reads (path + size/tokens) are captured."""

    def _make_projects_dir(self, tmp_path: Path, target: Path) -> Path:
        encoded = re.sub(r"[^A-Za-z0-9-]", "-", str(target.resolve()))
        projects_dir = tmp_path / "claude" / ".claude" / "projects" / encoded
        projects_dir.mkdir(parents=True, exist_ok=True)
        return projects_dir

    def test_harvests_reads_with_size_and_tokens(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        projects_dir = self._make_projects_dir(tmp_path, target)

        since = time.time() - 60
        body = "line\n" * 40  # 200 bytes → 50 tokens est
        transcript = projects_dir / "session.jsonl"
        _write_jsonl(transcript, [
            {"message": {"content": [
                {"type": "tool_use", "id": "toolu_1", "name": "Read",
                 "input": {"file_path": "/repo/src/app.py"}},
            ]}},
            {"toolUseResult": {"type": "text", "file": {
                "filePath": "/repo/src/app.py", "content": body,
                "numLines": 40, "startLine": 1, "totalLines": 40}}},
        ])
        _set_mtime(transcript, time.time())

        fake_home = tmp_path / "claude"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            cov = capture_reads("claude", target, since)

        assert cov.status == "ok"
        assert cov.engine == "claude"
        d = cov.to_dict()
        assert d["fileCount"] == 1
        f = d["files"][0]
        assert f["path"] == "/repo/src/app.py"
        assert f["bytes"] == len(body.encode("utf-8"))
        assert f["tokensEst"] == len(body.encode("utf-8")) // 4
        assert f["engine"] == "claude"

    def test_read_without_result_falls_back_to_disk_stat(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        real_file = target / "on_disk.txt"
        real_file.write_text("x" * 120)
        projects_dir = self._make_projects_dir(tmp_path, target)

        since = time.time() - 60
        transcript = projects_dir / "session.jsonl"
        _write_jsonl(transcript, [
            {"message": {"content": [
                {"type": "tool_use", "id": "toolu_2", "name": "Read",
                 "input": {"file_path": str(real_file)}},
            ]}},
        ])
        _set_mtime(transcript, time.time())

        fake_home = tmp_path / "claude"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            cov = capture_reads("claude", target, since)

        assert cov.status == "ok"
        f = cov.to_dict()["files"][0]
        assert f["bytes"] == 120  # picked up from the on-disk stat

    def test_no_reads_is_ok_empty_not_na(self, tmp_path: Path) -> None:
        # An engine we CAN read, whose transcript genuinely has no reads, is
        # status=ok with zero files — that is a MEASURED zero, distinct from n/a.
        target = tmp_path / "repo"
        target.mkdir()
        projects_dir = self._make_projects_dir(tmp_path, target)
        since = time.time() - 60
        transcript = projects_dir / "session.jsonl"
        _write_jsonl(transcript, [
            {"message": {"usage": {"input_tokens": 1, "output_tokens": 1}}},
        ])
        _set_mtime(transcript, time.time())

        fake_home = tmp_path / "claude"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            cov = capture_reads("claude", target, since)

        assert cov.status == "ok"
        d = cov.to_dict()
        assert d["fileCount"] == 0
        assert d["files"] == []

    def test_missing_transcript_dir_is_na_not_zero(self, tmp_path: Path) -> None:
        # AC3 variant: claude engine but NO transcript directory → n/a, not zero.
        target = tmp_path / "repo"
        target.mkdir()
        fake_home = tmp_path / "no_such_home"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            cov = capture_reads("claude", target, time.time() - 60)

        d = cov.to_dict()
        assert d["status"] == "n/a"
        assert d["format"] == "claude-transcript-missing"
        assert "fileCount" not in d and "files" not in d


class TestCodexReadHarvest:
    """AC2: codex reads are harvested from the rollout format."""

    def _make_session_dir(self, tmp_path: Path, session_id: str) -> Path:
        session_dir = tmp_path / "codex" / ".codex" / "sessions" / session_id
        session_dir.mkdir(parents=True, exist_ok=True)
        return session_dir

    def test_harvests_exec_command_reads(self, tmp_path: Path) -> None:
        target = tmp_path / "myrepo"
        target.mkdir()
        session_dir = self._make_session_dir(tmp_path, "sess-r")
        since = time.time() - 60
        rollout = session_dir / "rollout-001.jsonl"
        _write_jsonl(rollout, [
            {"type": "session_meta", "cwd": str(target.resolve())},
            {"type": "response_item", "payload": {
                "type": "function_call", "name": "exec_command",
                "call_id": "call_1",
                "arguments": json.dumps({"cmd": "sed -n '1,240p' /myrepo/main.go",
                                         "workdir": str(target.resolve())})}},
            {"type": "response_item", "payload": {
                "type": "function_call_output", "call_id": "call_1",
                "output": "...\nOriginal token count: 1089\n..."}},
            # a non-read command must be ignored
            {"type": "response_item", "payload": {
                "type": "function_call", "name": "exec_command",
                "call_id": "call_2",
                "arguments": json.dumps({"cmd": "go build ./...",
                                         "workdir": str(target.resolve())})}},
        ])
        _set_mtime(rollout, time.time())

        fake_home = tmp_path / "codex"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            cov = capture_reads("codex", target, since)

        assert cov.status == "ok"
        assert cov.engine == "codex"
        d = cov.to_dict()
        assert d["fileCount"] == 1
        f = d["files"][0]
        assert f["path"] == "/myrepo/main.go"
        assert f["tokensEst"] == 1089  # exact count from the tool output
        assert f["engine"] == "codex"

    def test_cat_and_head_are_reads(self, tmp_path: Path) -> None:
        target = tmp_path / "myrepo"
        target.mkdir()
        real = target / "f.txt"
        real.write_text("y" * 80)
        session_dir = self._make_session_dir(tmp_path, "sess-cat")
        since = time.time() - 60
        rollout = session_dir / "rollout-001.jsonl"
        _write_jsonl(rollout, [
            {"type": "session_meta", "cwd": str(target.resolve())},
            {"type": "response_item", "payload": {
                "type": "function_call", "name": "exec_command",
                "call_id": "c1",
                "arguments": json.dumps({"cmd": f"cat {real}"})}},
        ])
        _set_mtime(rollout, time.time())

        fake_home = tmp_path / "codex"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            cov = capture_reads("codex", target, since)

        assert cov.status == "ok"
        f = cov.to_dict()["files"][0]
        assert f["path"] == str(real)
        assert f["bytes"] == 80  # on-disk fallback since no token count line

    def test_no_matching_session_is_na(self, tmp_path: Path) -> None:
        target = tmp_path / "myrepo"
        target.mkdir()
        other = tmp_path / "other"
        session_dir = self._make_session_dir(tmp_path, "sess-x")
        rollout = session_dir / "rollout-001.jsonl"
        _write_jsonl(rollout, [
            {"type": "session_meta", "cwd": str(other.resolve())},
        ])
        _set_mtime(rollout, time.time())

        fake_home = tmp_path / "codex"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            cov = capture_reads("codex", target, time.time() - 60)

        d = cov.to_dict()
        assert d["status"] == "n/a"
        assert d["format"] == "codex-transcript-missing"
        assert "fileCount" not in d


class TestNaHygiene:
    """AC3: cursor/hermes report n/a — never a zero anywhere in the record."""

    @pytest.mark.parametrize("agent", ["cursor", "hermes", "custom-bot", ""])
    def test_uncovered_engines_report_na_not_zero(self, tmp_path: Path, agent: str) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        cov = capture_reads(agent, target, 0.0)
        d = cov.to_dict()
        assert d["status"] == "n/a"
        # The whole point: no count, no files array → cannot be read as zero.
        assert "fileCount" not in d
        assert "files" not in d
        assert "format" not in d  # plain no-vehicle case, not a parse error


class TestMalformedTranscript:
    """AC4: an unparseable transcript → n/a + a format tag; run still completes."""

    def _make_projects_dir(self, tmp_path: Path, target: Path) -> Path:
        encoded = re.sub(r"[^A-Za-z0-9-]", "-", str(target.resolve()))
        projects_dir = tmp_path / "claude" / ".claude" / "projects" / encoded
        projects_dir.mkdir(parents=True, exist_ok=True)
        return projects_dir

    def test_unparseable_claude_transcript_is_na_with_tag(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        projects_dir = self._make_projects_dir(tmp_path, target)
        since = time.time() - 60
        transcript = projects_dir / "session.jsonl"
        # Non-JSON garbage: lines are present but none are JSON objects.
        transcript.write_text("NOT JSON AT ALL\n<<< binary junk >>>\n")
        _set_mtime(transcript, time.time())

        fake_home = tmp_path / "claude"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            cov = capture_reads("claude", target, since)

        d = cov.to_dict()
        assert d["status"] == "n/a"
        assert d["format"] == "claude-unparseable"
        assert "fileCount" not in d and "files" not in d

    def test_capture_reads_never_raises(self, tmp_path: Path) -> None:
        # Even if Path.home explodes, capture_reads downgrades to n/a, never raises.
        target = tmp_path / "repo"
        target.mkdir()
        with patch("agentrail.run.usage_capture.Path.home",
                   side_effect=RuntimeError("boom")):
            cov = capture_reads("claude", target, 0.0)
        d = cov.to_dict()
        assert d["status"] == "n/a"
        assert d["format"] == "harvest-error"


class TestRecordReadsIntoRunJson:
    """The run.json persistence helper (read-modify-write, never raises)."""

    def test_writes_coverage_key(self, tmp_path: Path) -> None:
        run_json = tmp_path / "run.json"
        run_json.write_text(json.dumps({"runId": "r1", "objectiveGate": {"verdict": "pass"}}))
        target = tmp_path / "repo"
        target.mkdir()
        cov = capture_reads("cursor", target, 0.0)  # n/a coverage

        record_reads_into_run_json(run_json, cov)

        data = json.loads(run_json.read_text())
        # Existing keys are preserved (read-modify-write).
        assert data["runId"] == "r1"
        assert data["objectiveGate"] == {"verdict": "pass"}
        assert data["readsCoverage"]["status"] == "n/a"
        assert data["readsCoverage"]["engine"] == "cursor"

    def test_creates_file_when_absent(self, tmp_path: Path) -> None:
        run_json = tmp_path / "run.json"  # does not exist yet
        target = tmp_path / "repo"
        target.mkdir()
        cov = capture_reads("hermes", target, 0.0)
        record_reads_into_run_json(run_json, cov)
        data = json.loads(run_json.read_text())
        assert data["readsCoverage"]["status"] == "n/a"
