"""Tests for agentrail.afk.run_register — canonical run-id derivation and HTTP upsert.

Coverage:
- run_uuid is deterministic, valid UUID, differs by issue number.
- register_run returns False when not linked (no server.json).
- register_run returns True on HTTP 202 (mocked urlopen).
- register_run returns False (never raises) when urlopen raises.
- register_run posts to /api/v1/ingest/runs with Bearer header and correct id.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from agentrail.afk import run_register


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_server_json(tmp_path: Path, base_url: str = "http://localhost:3000",
                       api_key: str = "ar_test", repository_id: str = "repo-abc") -> None:
    d = tmp_path / ".agentrail"
    d.mkdir(parents=True, exist_ok=True)
    (d / "server.json").write_text(json.dumps({
        "base_url": base_url,
        "api_key": api_key,
        "repository_id": repository_id,
    }))


# ---------------------------------------------------------------------------
# run_uuid
# ---------------------------------------------------------------------------


def test_run_uuid_is_deterministic() -> None:
    uid = run_register.run_uuid("sess-123", 42)
    assert uid == run_register.run_uuid("sess-123", 42)


def test_run_uuid_is_valid_uuid() -> None:
    uid = run_register.run_uuid("sess-abc", 7)
    parsed = uuid.UUID(uid)
    assert str(parsed) == uid


def test_run_uuid_differs_by_issue() -> None:
    uid1 = run_register.run_uuid("sess-x", 1)
    uid2 = run_register.run_uuid("sess-x", 2)
    assert uid1 != uid2


def test_run_uuid_differs_by_session() -> None:
    uid1 = run_register.run_uuid("sess-a", 10)
    uid2 = run_register.run_uuid("sess-b", 10)
    assert uid1 != uid2


# ---------------------------------------------------------------------------
# register_run — not linked
# ---------------------------------------------------------------------------


def test_register_run_returns_false_when_not_linked(tmp_path: Path) -> None:
    """No server.json means load_link returns None and register_run returns False."""
    result = run_register.register_run(
        tmp_path,
        run_id="some-id",
        agent="claude",
        branch="afk/issue-1",
        title="Test issue",
        status="running",
    )
    assert result is False


# ---------------------------------------------------------------------------
# register_run — HTTP 202
# ---------------------------------------------------------------------------


def test_register_run_returns_true_on_202(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)

    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        return FakeResp()

    monkeypatch.setattr(run_register.urllib.request, "urlopen", fake_urlopen)
    result = run_register.register_run(
        tmp_path,
        run_id=run_register.run_uuid("sess-1", 5),
        agent="claude",
        branch="afk/issue-5",
        title="Fix bug",
        status="running",
        started_at="2026-06-12T00:00:00+00:00",
    )
    assert result is True


# ---------------------------------------------------------------------------
# register_run — never raises on network error
# ---------------------------------------------------------------------------


def test_register_run_returns_false_on_network_error(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)

    def boom(req, timeout):
        raise OSError("network down")

    monkeypatch.setattr(run_register.urllib.request, "urlopen", boom)
    result = run_register.register_run(
        tmp_path,
        run_id="x",
        agent="claude",
        branch="afk/issue-9",
        title="t",
        status="running",
    )
    assert result is False  # never raises


# ---------------------------------------------------------------------------
# register_run — correct URL, auth header, and run id in payload
# ---------------------------------------------------------------------------


def test_register_run_posts_correct_url_and_headers(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path, base_url="http://localhost:4000", api_key="ar_key99",
                       repository_id="repo-xyz")
    captured: dict = {}

    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["auth"] = req.get_header("Authorization")
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(run_register.urllib.request, "urlopen", fake_urlopen)

    expected_run_id = run_register.run_uuid("sess-verify", 17)
    run_register.register_run(
        tmp_path,
        run_id=expected_run_id,
        agent="codex",
        branch="afk/issue-17",
        title="My issue",
        status="running",
        started_at="2026-06-12T10:00:00+00:00",
    )

    assert captured["url"] == "http://localhost:4000/api/v1/ingest/runs"
    assert captured["auth"] == "Bearer ar_key99"
    assert captured["body"]["id"] == expected_run_id
    assert captured["body"]["repository_id"] == "repo-xyz"
    assert captured["body"]["agent"] == "codex"
    assert captured["body"]["status"] == "running"
    assert captured["body"]["started_at"] == "2026-06-12T10:00:00+00:00"
    assert "finished_at" not in captured["body"]


def test_register_run_includes_finished_at_when_set(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}

    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(run_register.urllib.request, "urlopen", fake_urlopen)

    run_register.register_run(
        tmp_path,
        run_id="some-id",
        agent="claude",
        branch="main",
        title="t",
        status="success",
        finished_at="2026-06-12T11:00:00+00:00",
    )

    assert captured["body"]["finished_at"] == "2026-06-12T11:00:00+00:00"
    assert "started_at" not in captured["body"]
