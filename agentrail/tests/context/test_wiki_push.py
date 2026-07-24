"""Tests for agentrail/context/wiki_push.py (Repo Wiki spec §4.4 contract 1,
delivery plan §7 row 4). Mirrors test_snapshot_push.py's structure: every
external I/O (urllib.request.urlopen) is mocked, hermetic, no live server.
"""
import json
from pathlib import Path

from agentrail.context import wiki_push


def _link(tmp_path: Path) -> None:
    d = tmp_path / ".agentrail"
    d.mkdir(parents=True, exist_ok=True)
    (d / "server.json").write_text(
        json.dumps(
            {
                "base_url": "http://localhost:3000",
                "workspace_id": "ws",
                "repository_id": "repo-1",
                "api_key": "ar_test",
            }
        )
    )


def _set_custody(tmp_path: Path, upload: bool) -> None:
    d = tmp_path / ".agentrail"
    d.mkdir(parents=True, exist_ok=True)
    (d / "config.json").write_text(json.dumps({"context": {"wiki": {"upload": upload}}}))


class FakeResp:
    def __init__(self, status: int = 200) -> None:
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


PAGE = {
    "slug": "wiki/overview",
    "title": "acme/widgets — overview",
    "kind": "overview",
    "bodyMd": "# Overview",
    "commitSha": "abc123",
    "inputsHash": "sha256:deadbeef",
    "generatedAt": "2026-07-24T00:00:00.000Z",
}

COMPILE_EVENT = {
    "commitSha": "abc123",
    "pagesWritten": 1,
    "pagesReused": 0,
    "costUsd": 0.01,
    "model": "claude-haiku-4-5",
    "durationMs": 900,
}


def test_push_skipped_when_not_linked(tmp_path):
    assert wiki_push.push_wiki_pages(tmp_path, "acme/widgets", [PAGE]) is False


def test_push_skipped_when_nothing_to_send(tmp_path, monkeypatch):
    _link(tmp_path)
    captured = {}

    def fake_urlopen(req, timeout):
        captured["called"] = True
        return FakeResp(200)

    monkeypatch.setattr(wiki_push.urllib.request, "urlopen", fake_urlopen)
    # No pages AND no compile_event -> nothing to communicate, skip entirely.
    assert wiki_push.push_wiki_pages(tmp_path, "acme/widgets", []) is False
    assert "called" not in captured


def test_push_proceeds_with_zero_pages_but_a_compile_event(tmp_path, monkeypatch):
    _link(tmp_path)
    captured = {}

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return FakeResp(200)

    monkeypatch.setattr(wiki_push.urllib.request, "urlopen", fake_urlopen)
    result = wiki_push.push_wiki_pages(tmp_path, "acme/widgets", [], compile_event=COMPILE_EVENT)
    assert result is True
    assert captured["body"]["pages"] == []
    assert captured["body"]["compileEvent"] == COMPILE_EVENT


def test_push_returns_true_on_200(tmp_path, monkeypatch):
    _link(tmp_path)
    captured = {}

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["auth"] = req.get_header("Authorization")
        captured["content_type"] = req.get_header("Content-type")
        captured["body"] = json.loads(req.data.decode("utf-8"))
        captured["timeout"] = timeout
        return FakeResp(200)

    monkeypatch.setattr(wiki_push.urllib.request, "urlopen", fake_urlopen)
    result = wiki_push.push_wiki_pages(tmp_path, "acme/widgets", [PAGE], compile_event=COMPILE_EVENT)

    assert result is True
    assert captured["url"] == "http://localhost:3000/api/v1/ingest/wiki-pages"
    assert captured["auth"] == "Bearer ar_test"
    assert captured["content_type"] == "application/json"
    assert captured["timeout"] == wiki_push.WIKI_PUSH_TIMEOUT_SECONDS
    assert captured["body"] == {
        "repoFullName": "acme/widgets",
        "pages": [PAGE],
        "compileEvent": COMPILE_EVENT,
    }


def test_push_omits_compile_event_key_when_none(tmp_path, monkeypatch):
    _link(tmp_path)
    captured = {}

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return FakeResp(200)

    monkeypatch.setattr(wiki_push.urllib.request, "urlopen", fake_urlopen)
    wiki_push.push_wiki_pages(tmp_path, "acme/widgets", [PAGE])
    assert "compileEvent" not in captured["body"]


def test_push_returns_false_on_non_200_status(tmp_path, monkeypatch):
    _link(tmp_path)
    monkeypatch.setattr(wiki_push.urllib.request, "urlopen", lambda req, timeout: FakeResp(500))
    assert wiki_push.push_wiki_pages(tmp_path, "acme/widgets", [PAGE]) is False


def test_push_failure_is_nonfatal(tmp_path, monkeypatch):
    _link(tmp_path)

    def boom(*a, **k):
        raise OSError("network down")

    monkeypatch.setattr(wiki_push.urllib.request, "urlopen", boom)
    assert wiki_push.push_wiki_pages(tmp_path, "acme/widgets", [PAGE]) is False


def test_push_skipped_when_custody_switch_off(tmp_path, monkeypatch):
    _link(tmp_path)
    _set_custody(tmp_path, upload=False)
    captured = {}

    def fake_urlopen(req, timeout):
        captured["called"] = True
        return FakeResp(200)

    monkeypatch.setattr(wiki_push.urllib.request, "urlopen", fake_urlopen)
    result = wiki_push.push_wiki_pages(tmp_path, "acme/widgets", [PAGE])

    assert result is False
    assert "called" not in captured


def test_push_proceeds_when_custody_switch_explicitly_on(tmp_path, monkeypatch):
    _link(tmp_path)
    _set_custody(tmp_path, upload=True)
    monkeypatch.setattr(wiki_push.urllib.request, "urlopen", lambda req, timeout: FakeResp(200))
    assert wiki_push.push_wiki_pages(tmp_path, "acme/widgets", [PAGE]) is True


def test_push_proceeds_by_default_when_no_config_file_exists(tmp_path, monkeypatch):
    _link(tmp_path)  # no config.json written at all
    monkeypatch.setattr(wiki_push.urllib.request, "urlopen", lambda req, timeout: FakeResp(200))
    assert wiki_push.push_wiki_pages(tmp_path, "acme/widgets", [PAGE]) is True
