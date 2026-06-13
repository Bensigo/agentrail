"""
Tests for flush_afk_events — AC1..AC5 from issue #566.
"""
from __future__ import annotations

import json
from pathlib import Path
import asyncio

import pytest

from agentrail.afk.runner import Runner
from agentrail.afk.state import AfkState, Store
from agentrail.afk.telemetry import ServerConfig, flush_afk_events


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_config() -> ServerConfig:
    return ServerConfig(base_url="http://localhost:3000", api_key="ar_test")


def _write_events(target: Path, n: int) -> None:
    """Write n well-formed journal event lines to .agentrail/afk/events.jsonl."""
    path = target / ".agentrail" / "afk" / "events.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as fh:
        for i in range(n):
            fh.write(json.dumps({
                "v": 1,
                "session": "sess",
                "seq": i,
                "ts": "2026-06-13T00:00:00+00:00",
                "kind": "action",
                "action": {"type": "Tick"},
                "digest": f"d{i}",
            }) + "\n")


class FakeResp:
    def __init__(self, status: int = 200) -> None:
        self.status = status

    def __enter__(self) -> "FakeResp":
        return self

    def __exit__(self, *a: object) -> bool:
        return False


# ---------------------------------------------------------------------------
# AC1: importable
# ---------------------------------------------------------------------------


def test_flush_afk_events_importable() -> None:
    assert callable(flush_afk_events)


# ---------------------------------------------------------------------------
# AC2: 150 lines → exactly two POSTs (100 + 50) to /api/v1/ingest/afk-events
# ---------------------------------------------------------------------------


def test_flush_afk_events_batches_150_into_two_posts(tmp_path: Path, monkeypatch) -> None:
    _write_events(tmp_path, 150)
    cfg = _make_config()

    calls: list[dict] = []

    def fake_urlopen(req, timeout):
        calls.append({
            "url": req.full_url,
            "auth": req.get_header("Authorization"),
            "body": json.loads(req.data),
        })
        return FakeResp(200)

    import agentrail.afk.telemetry as tel
    monkeypatch.setattr(tel.urllib.request, "urlopen", fake_urlopen)

    result = flush_afk_events(cfg, tmp_path)

    assert result is True
    assert len(calls) == 2
    assert len(calls[0]["body"]) == 100
    assert len(calls[1]["body"]) == 50
    assert calls[0]["url"] == "http://localhost:3000/api/v1/ingest/afk-events"
    assert calls[0]["auth"] == "Bearer ar_test"


# ---------------------------------------------------------------------------
# AC3: missing events.jsonl → True, no HTTP call
# ---------------------------------------------------------------------------


def test_flush_afk_events_missing_file_returns_true_no_http(tmp_path: Path, monkeypatch) -> None:
    cfg = _make_config()

    http_called = []

    def boom(*a, **k):
        http_called.append(True)

    import agentrail.afk.telemetry as tel
    monkeypatch.setattr(tel.urllib.request, "urlopen", boom)

    result = flush_afk_events(cfg, tmp_path)

    assert result is True
    assert http_called == []


# ---------------------------------------------------------------------------
# AC4: network error → False, never raises
# ---------------------------------------------------------------------------


def test_flush_afk_events_network_error_returns_false(tmp_path: Path, monkeypatch) -> None:
    _write_events(tmp_path, 5)
    cfg = _make_config()

    def boom(*a, **k):
        raise OSError("network down")

    import agentrail.afk.telemetry as tel
    monkeypatch.setattr(tel.urllib.request, "urlopen", boom)

    result = flush_afk_events(cfg, tmp_path)

    assert result is False  # never raises; returns False


# ---------------------------------------------------------------------------
# AC4b: non-2xx HTTP response → False
# ---------------------------------------------------------------------------


def test_flush_afk_events_non_2xx_returns_false(tmp_path: Path, monkeypatch) -> None:
    _write_events(tmp_path, 3)
    cfg = _make_config()

    def fake_urlopen(req, timeout):
        return FakeResp(500)

    import agentrail.afk.telemetry as tel
    monkeypatch.setattr(tel.urllib.request, "urlopen", fake_urlopen)

    result = flush_afk_events(cfg, tmp_path)

    assert result is False


# ---------------------------------------------------------------------------
# AC4c: 2xx range (201, 204) accepted as success
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("status", [200, 201, 204])
def test_flush_afk_events_accepts_2xx_range(tmp_path: Path, monkeypatch, status: int) -> None:
    _write_events(tmp_path, 2)
    cfg = _make_config()

    def fake_urlopen(req, timeout):
        return FakeResp(status)

    import agentrail.afk.telemetry as tel
    monkeypatch.setattr(tel.urllib.request, "urlopen", fake_urlopen)

    assert flush_afk_events(cfg, tmp_path) is True


# ---------------------------------------------------------------------------
# AC5: Runner.run() calls flush_afk_events at completion when configured
# ---------------------------------------------------------------------------


def test_runner_run_flushes_afk_events_when_server_config_exists(
    tmp_path: Path, monkeypatch
) -> None:
    cfg = _make_config()
    calls: list[tuple[ServerConfig, Path]] = []

    import agentrail.afk.telemetry as tel

    monkeypatch.setattr(tel, "load_server_config", lambda target: cfg)
    monkeypatch.setattr(
        tel,
        "flush_afk_events",
        lambda config, target: calls.append((config, target)) or True,
    )

    store = Store(AfkState(concurrency=1, slots={0: None}))
    runner = Runner(
        tmp_path,
        engine="codex",
        base="main",
        concurrency=1,
        afk_label="codex",
        queue_labels=["ready-for-agent"],
        run_dir=tmp_path / "run",
        store=store,
    )

    asyncio.run(runner.run())

    assert calls == [(cfg, tmp_path)]
