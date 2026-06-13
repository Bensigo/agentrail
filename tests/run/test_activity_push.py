"""Tests for agentrail.run.activity_push — agent activity extraction + push.

Coverage:
- Claude extractor: thinking/text truncation, tool-name collection, cap at 50.
- Codex extractor: reasoning/message/tool-call entries from rollout records.
- push_agent_activity: not linked → False (no network), payload shape with
  mocked urlopen (event_type 'agent_activity', run id, monotonic seq),
  non-fatal False on network error.

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

from agentrail.run import activity_push
from agentrail.run.activity_push import (
    ActivityEntry,
    MAX_ENTRIES_PER_PHASE,
    SUMMARY_MAX_CHARS,
    extract_activity,
    push_agent_activity,
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


def _make_claude_projects_dir(tmp_path: Path, target: Path) -> Path:
    encoded = re.sub(r"[^A-Za-z0-9-]", "-", str(target.resolve()))
    projects_dir = tmp_path / "claude" / ".claude" / "projects" / encoded
    projects_dir.mkdir(parents=True, exist_ok=True)
    return projects_dir


def _assistant_turn(blocks: list[dict], ts: str = "2026-06-12T10:00:00.000Z") -> dict:
    return {"type": "assistant", "timestamp": ts, "message": {"content": blocks}}


def _write_server_json(tmp_path: Path) -> None:
    d = tmp_path / ".agentrail"
    d.mkdir(parents=True, exist_ok=True)
    (d / "server.json").write_text(json.dumps({
        "base_url": "http://localhost:3000",
        "api_key": "ar_test",
        "repository_id": "repo-abc",
    }))


# ---------------------------------------------------------------------------
# AC1 — Claude extractor
# ---------------------------------------------------------------------------

class TestClaudeExtractor:
    def _extract(self, tmp_path: Path, target: Path, records: list[dict]):
        projects_dir = _make_claude_projects_dir(tmp_path, target)
        transcript = projects_dir / "session.jsonl"
        _write_jsonl(transcript, records)
        _set_mtime(transcript, time.time())

        fake_home = tmp_path / "claude"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            return extract_activity("claude", target, time.time() - 60)

    def test_thinking_extraction_and_tool_names(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        entries = self._extract(tmp_path, target, [
            _assistant_turn([
                {"type": "thinking", "thinking": "Let me read the config first."},
                {"type": "tool_use", "name": "Read"},
                {"type": "tool_use", "name": "Grep"},
            ]),
        ])

        assert len(entries) == 1
        assert entries[0].summary == "Let me read the config first."
        assert entries[0].tools == ["Read", "Grep"]
        assert entries[0].ts == "2026-06-12T10:00:00.000Z"

    def test_behavior_metrics_are_computed_from_tool_blocks(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        entries = self._extract(tmp_path, target, [
            _assistant_turn([
                {"type": "text", "text": "read then edit"},
                {"type": "tool_use", "name": "Read", "input": {"file_path": "a.ts"}},
                {
                    "type": "tool_use",
                    "name": "Read",
                    "input": {"file_path": "b.ts", "offset": 1, "limit": 40},
                },
                {"type": "tool_use", "name": "Read", "input": {"file_path": "a.ts"}},
                {"type": "tool_use", "name": "Edit", "input": {"file_path": "c.ts"}},
            ]),
        ])

        assert len(entries) == 1
        assert entries[0].files_read_count == 2
        assert entries[0].full_file_read == 1
        assert entries[0].tool_loop_count == 1
        assert entries[0].edit_without_context == 0
        assert entries[0].verification_skip == 1

    def test_context_blind_edit_metric_when_turn_edits_without_context(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        entries = self._extract(tmp_path, target, [
            _assistant_turn([
                {"type": "text", "text": "edit directly"},
                {"type": "tool_use", "name": "Edit", "input": {"file_path": "c.ts"}},
            ]),
        ])

        assert entries[0].edit_without_context == 1

    def test_text_truncated_to_200_chars(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        long_text = "x" * 500
        entries = self._extract(tmp_path, target, [
            _assistant_turn([{"type": "text", "text": long_text}]),
        ])

        assert len(entries) == 1
        assert entries[0].summary == "x" * SUMMARY_MAX_CHARS + "…"
        # long turns also carry fuller text so the dashboard can expand them
        assert entries[0].full_text == "x" * 500

    def test_full_text_empty_for_short_turns_and_capped_for_huge(self, tmp_path: Path) -> None:
        from agentrail.run.activity_push import FULL_TEXT_MAX_CHARS
        target = tmp_path / "repo"
        target.mkdir()
        entries = self._extract(tmp_path, target, [
            _assistant_turn([{"type": "text", "text": "short"}]),
            _assistant_turn([{"type": "text", "text": "y" * (FULL_TEXT_MAX_CHARS + 500)}]),
        ])

        assert entries[0].full_text == ""  # summary already carries it
        assert entries[1].full_text == "y" * FULL_TEXT_MAX_CHARS + "…"

    def test_thinking_preferred_over_text(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        entries = self._extract(tmp_path, target, [
            _assistant_turn([
                {"type": "text", "text": "final answer"},
                {"type": "thinking", "thinking": "internal reasoning"},
            ]),
        ])

        assert entries[0].summary == "internal reasoning"

    def test_one_entry_per_assistant_turn(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        entries = self._extract(tmp_path, target, [
            _assistant_turn([{"type": "text", "text": "turn one"}]),
            {"type": "user", "message": {"content": "tool result"}},
            _assistant_turn([{"type": "text", "text": "turn two"},
                             {"type": "tool_use", "name": "Bash"}]),
        ])

        assert [e.summary for e in entries] == ["turn one", "turn two"]
        assert entries[1].tools == ["Bash"]

    def test_cap_at_50_entries(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        records = [
            _assistant_turn([{"type": "text", "text": f"turn {i}"}])
            for i in range(80)
        ]
        entries = self._extract(tmp_path, target, records)

        assert len(entries) == MAX_ENTRIES_PER_PHASE

    def test_empty_turns_and_malformed_lines_skipped(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        projects_dir = _make_claude_projects_dir(tmp_path, target)
        transcript = projects_dir / "session.jsonl"
        with transcript.open("w") as fh:
            fh.write("NOT JSON\n")
            fh.write(json.dumps(_assistant_turn([])) + "\n")
            fh.write(json.dumps({"type": "assistant", "message": {"content": "str not list"}}) + "\n")
            fh.write(json.dumps(_assistant_turn([{"type": "text", "text": "ok"}])) + "\n")
        _set_mtime(transcript, time.time())

        fake_home = tmp_path / "claude"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            entries = extract_activity("claude", target, time.time() - 60)

        assert [e.summary for e in entries] == ["ok"]

    def test_since_ts_excludes_older_files(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        projects_dir = _make_claude_projects_dir(tmp_path, target)
        transcript = projects_dir / "old.jsonl"
        _write_jsonl(transcript, [_assistant_turn([{"type": "text", "text": "old"}])])
        since = time.time()
        _set_mtime(transcript, since - 10)

        fake_home = tmp_path / "claude"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            entries = extract_activity("claude", target, since)

        assert entries == []


# ---------------------------------------------------------------------------
# Codex extractor
# ---------------------------------------------------------------------------

class TestCodexExtractor:
    def _extract(self, tmp_path: Path, target: Path, records: list[dict]):
        session_dir = tmp_path / "codex" / ".codex" / "sessions" / "sess-1"
        rollout = session_dir / "rollout-001.jsonl"
        _write_jsonl(rollout, [{"type": "session_meta", "cwd": str(target.resolve())}] + records)
        _set_mtime(rollout, time.time())

        fake_home = tmp_path / "codex"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            return extract_activity("codex", target, time.time() - 60)

    def test_reasoning_message_and_tool_calls(self, tmp_path: Path) -> None:
        target = tmp_path / "myrepo"
        target.mkdir()
        entries = self._extract(tmp_path, target, [
            {"type": "response_item",
             "payload": {"type": "reasoning",
                         "summary": [{"type": "summary_text", "text": "Plan the change"}]}},
            {"type": "response_item",
             "payload": {"type": "function_call", "name": "shell"}},
            {"type": "response_item",
             "payload": {"type": "message", "role": "assistant",
                         "content": [{"type": "output_text", "text": "Done."}]}},
        ])

        assert len(entries) == 2
        assert entries[0].summary == "Plan the change"
        assert entries[0].tools == ["shell"]
        assert entries[1].summary == "Done."
        assert entries[1].tools == []

    def test_truncation_and_cwd_mismatch(self, tmp_path: Path) -> None:
        target = tmp_path / "myrepo"
        target.mkdir()
        other = tmp_path / "otherrepo"
        other.mkdir()

        session_dir = tmp_path / "codex" / ".codex" / "sessions" / "sess-2"
        rollout = session_dir / "rollout-001.jsonl"
        _write_jsonl(rollout, [
            {"type": "session_meta", "cwd": str(other.resolve())},
            {"type": "response_item",
             "payload": {"type": "message", "role": "assistant",
                         "content": [{"type": "output_text", "text": "y" * 400}]}},
        ])
        _set_mtime(rollout, time.time())

        fake_home = tmp_path / "codex"
        with patch("agentrail.run.usage_capture.Path.home", return_value=fake_home):
            # cwd mismatch → nothing for target
            assert extract_activity("codex", target, time.time() - 60) == []
            # matching repo → truncated entry
            entries = extract_activity("codex", other, time.time() - 60)

        assert len(entries) == 1
        assert entries[0].summary == "y" * SUMMARY_MAX_CHARS + "…"


class TestUnknownAgent:
    def test_unknown_agent_returns_empty(self, tmp_path: Path) -> None:
        target = tmp_path / "repo"
        target.mkdir()
        assert extract_activity("hermes", target, 0.0) == []


# ---------------------------------------------------------------------------
# AC2 — push payload shape (mocked urlopen) + non-fatal failures
# ---------------------------------------------------------------------------

class TestPushAgentActivity:
    def test_returns_false_when_not_linked(self, tmp_path: Path, monkeypatch) -> None:
        """No server.json → no network call, returns False."""
        def boom(*a, **k):  # pragma: no cover - must not be reached
            raise AssertionError("urlopen must not be called when not linked")
        monkeypatch.setattr(activity_push.urllib.request, "urlopen", boom)

        assert push_agent_activity(tmp_path, "run-1", "plan", "claude", 0.0) is False

    def test_returns_false_when_no_entries(self, tmp_path: Path, monkeypatch) -> None:
        _write_server_json(tmp_path)
        monkeypatch.setattr(activity_push, "extract_activity", lambda *a: [])

        assert push_agent_activity(tmp_path, "run-1", "plan", "claude", 0.0) is False

    def test_payload_shape_on_202(self, tmp_path: Path, monkeypatch) -> None:
        _write_server_json(tmp_path)
        entries = [
            ActivityEntry(summary="thinking about it", tools=["Read"],
                          ts="2026-06-12T10:00:00.000Z"),
            ActivityEntry(summary="now editing", tools=["Edit", "Bash"]),
        ]
        monkeypatch.setattr(activity_push, "extract_activity", lambda *a: entries)

        captured = {}

        class FakeResp:
            status = 202
            def __enter__(self): return self
            def __exit__(self, *a): return False

        def fake_urlopen(req, timeout):
            captured["url"] = req.full_url
            captured["auth"] = req.get_header("Authorization")
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return FakeResp()

        monkeypatch.setattr(activity_push.urllib.request, "urlopen", fake_urlopen)

        result = push_agent_activity(tmp_path, "run-xyz", "execute", "claude", 0.0)

        assert result is True
        assert captured["url"] == "http://localhost:3000/api/v1/ingest/run-events"
        assert captured["auth"] == "Bearer ar_test"

        events = captured["body"]
        assert len(events) == 2
        for i, ev in enumerate(events):
            assert ev["session_id"] == "run-xyz"
            assert ev["kind"] == "execute"
            assert ev["action"]["type"] == "agent_activity"
            assert ev["action"]["phase"] == "execute"
            assert ev["action"]["turn"] == i + 1
            for field in (
                "files_read_count",
                "full_file_read",
                "tool_loop_count",
                "edit_without_context",
                "verification_skip",
            ):
                assert field in ev["action"]
                assert isinstance(ev["action"][field], int)
        assert events[0]["action"]["summary"] == "thinking about it"
        assert events[0]["action"]["tools"] == ["Read"]
        assert events[0]["ts"] == "2026-06-12T10:00:00.000Z"
        assert events[1]["action"]["tools"] == ["Edit", "Bash"]
        # seq is monotonically increasing within the batch
        assert events[1]["seq"] > events[0]["seq"]
        # seeded from epoch-ms so it never collides with AFK counters (1..N)
        assert events[0]["seq"] > 1_000_000

    def test_seq_keeps_increasing_across_phases(self, tmp_path: Path, monkeypatch) -> None:
        _write_server_json(tmp_path)
        monkeypatch.setattr(
            activity_push, "extract_activity",
            lambda *a: [ActivityEntry(summary="s", tools=[])],
        )

        seqs: list[int] = []

        class FakeResp:
            status = 202
            def __enter__(self): return self
            def __exit__(self, *a): return False

        def fake_urlopen(req, timeout):
            seqs.extend(ev["seq"] for ev in json.loads(req.data.decode("utf-8")))
            return FakeResp()

        monkeypatch.setattr(activity_push.urllib.request, "urlopen", fake_urlopen)

        assert push_agent_activity(tmp_path, "run-seq", "plan", "claude", 0.0) is True
        assert push_agent_activity(tmp_path, "run-seq", "execute", "claude", 0.0) is True
        assert seqs == sorted(seqs)
        assert len(set(seqs)) == len(seqs)

    def test_returns_false_on_network_error(self, tmp_path: Path, monkeypatch) -> None:
        _write_server_json(tmp_path)
        monkeypatch.setattr(
            activity_push, "extract_activity",
            lambda *a: [ActivityEntry(summary="s", tools=[])],
        )

        def fake_urlopen(req, timeout):
            raise OSError("connection refused")

        monkeypatch.setattr(activity_push.urllib.request, "urlopen", fake_urlopen)

        # Never raises, returns False
        assert push_agent_activity(tmp_path, "run-1", "plan", "claude", 0.0) is False

    def test_returns_false_on_non_202(self, tmp_path: Path, monkeypatch) -> None:
        _write_server_json(tmp_path)
        monkeypatch.setattr(
            activity_push, "extract_activity",
            lambda *a: [ActivityEntry(summary="s", tools=[])],
        )

        class FakeResp:
            status = 400
            def __enter__(self): return self
            def __exit__(self, *a): return False

        monkeypatch.setattr(
            activity_push.urllib.request, "urlopen",
            lambda req, timeout: FakeResp(),
        )

        assert push_agent_activity(tmp_path, "run-1", "plan", "claude", 0.0) is False
