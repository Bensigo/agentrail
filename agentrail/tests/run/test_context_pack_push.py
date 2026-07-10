"""Tests for agentrail.run.context_pack_push — payload mapping and HTTP push.

Coverage:
- push_context_pack returns False when not linked (no server.json).
- push_context_pack returns True on HTTP 202; payload carries all required fields
  and correct Bearer header.
- push_context_pack returns False (never raises) when urlopen raises.
- push_context_pack handles empty retrieval dict gracefully (zeros).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentrail.run import context_pack_push


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_server_json(
    tmp_path: Path,
    base_url: str = "http://localhost:3000",
    api_key: str = "ar_test",
    repository_id: str = "repo-abc",
) -> None:
    d = tmp_path / ".agentrail"
    d.mkdir(parents=True, exist_ok=True)
    (d / "server.json").write_text(json.dumps({
        "base_url": base_url,
        "api_key": api_key,
        "repository_id": repository_id,
    }))


def _sample_retrieval() -> dict:
    return {
        "retrievalBudget": 8000,
        "selectedContextTokens": 3200,
        "selectedSources": ["src/a.py", "src/b.py", "src/c.py"],
    }


# ---------------------------------------------------------------------------
# AC2 — not linked → False (no network call)
# ---------------------------------------------------------------------------


def test_push_context_pack_returns_false_when_not_linked(tmp_path: Path) -> None:
    """No server.json → load_link returns None → no network, returns False."""
    result = context_pack_push.push_context_pack(
        tmp_path,
        run_id="run-001",
        retrieval=_sample_retrieval(),
    )
    assert result is False


# ---------------------------------------------------------------------------
# AC1 — mocked server: correct payload + Bearer header; 202 → True
# ---------------------------------------------------------------------------


def test_push_context_pack_returns_true_on_202(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)

    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        return FakeResp()

    monkeypatch.setattr(context_pack_push.urllib.request, "urlopen", fake_urlopen)
    result = context_pack_push.push_context_pack(
        tmp_path,
        run_id="run-202",
        retrieval=_sample_retrieval(),
    )
    assert result is True


def test_push_context_pack_payload_and_headers(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(
        tmp_path,
        base_url="http://localhost:4000",
        api_key="ar_key99",
        repository_id="repo-xyz",
    )
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

    monkeypatch.setattr(context_pack_push.urllib.request, "urlopen", fake_urlopen)

    retrieval = {
        "retrievalBudget": 10000,
        "selectedContextTokens": 4500,
        "tokensSaved": 12000,
        "selectedSources": ["a.py", "b.py"],
    }
    context_pack_push.push_context_pack(
        tmp_path,
        run_id="run-verify",
        retrieval=retrieval,
    )

    body = captured["body"]
    assert captured["url"] == "http://localhost:4000/api/v1/ingest/context-packs"
    assert captured["auth"] == "Bearer ar_key99"
    assert body["run_id"] == "run-verify"
    assert body["repository_id"] == "repo-xyz"
    assert body["token_budget"] == 10000
    assert body["tokens_used"] == 4500
    assert body["tokens_saved"] == 12000
    assert body["sources_considered"] == 2
    assert body["occurred_at"].endswith("Z")
    assert len(body["context_pack_id"]) == 36  # uuid4 format


# ---------------------------------------------------------------------------
# AC2 — urlopen raises → False (never raises)
# ---------------------------------------------------------------------------


def test_push_context_pack_returns_false_on_network_error(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)

    def boom(req, timeout):
        raise OSError("network down")

    monkeypatch.setattr(context_pack_push.urllib.request, "urlopen", boom)
    result = context_pack_push.push_context_pack(
        tmp_path,
        run_id="run-err",
        retrieval=_sample_retrieval(),
    )
    assert result is False  # never raises


# ---------------------------------------------------------------------------
# Edge case — empty retrieval dict → zeros, still sends
# ---------------------------------------------------------------------------


def test_push_context_pack_empty_retrieval_sends_zeros(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}

    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(context_pack_push.urllib.request, "urlopen", fake_urlopen)
    result = context_pack_push.push_context_pack(
        tmp_path,
        run_id="run-empty",
        retrieval={},
    )

    assert result is True
    body = captured["body"]
    assert body["token_budget"] == 0
    assert body["tokens_used"] == 0
    assert body["tokens_saved"] == 0
    assert body["sources_considered"] == 0
    assert body["precision_at_budget"] == 0.0
    assert body["citation_coverage"] == 0.0
    assert body["stale_count"] == 0
    assert body["denied_count"] == 0
    assert body["source_hash_list"] == []


def test_payload_handles_dict_retrieval_budget(tmp_path, monkeypatch):
    # retrievalBudget is a dict {maxItems, maxTokens}; token_budget must be its
    # maxTokens, not int(dict) (which used to raise and silently drop the push).
    monkeypatch.setenv("AGENTRAIL_SERVER_BASE_URL", "http://x")
    monkeypatch.setenv("AGENTRAIL_SERVER_API_KEY", "ar_k")
    monkeypatch.setenv("AGENTRAIL_SERVER_REPOSITORY_ID", "repo")
    captured = {}

    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        captured["body"] = req.data
        return FakeResp()

    monkeypatch.setattr(context_pack_push.urllib.request, "urlopen", fake_urlopen)
    ok = context_pack_push.push_context_pack(
        tmp_path, "run-1",
        {"selectedContextTokens": 743, "selectedSources": ["a", "b"],
         "tokensSaved": 9001,
         "retrievalBudget": {"maxItems": 10, "maxTokens": 5000}},
    )
    assert ok is True
    import json as _json
    payload = _json.loads(captured["body"])
    assert payload["token_budget"] == 5000
    assert payload["tokens_used"] == 743
    assert payload["tokens_saved"] == 9001
    assert payload["sources_considered"] == 2


# ---------------------------------------------------------------------------
# Item extraction (_build_items) — drill-down payload
# ---------------------------------------------------------------------------


def test_build_items_from_string_sources_with_parallel_lists() -> None:
    items = context_pack_push._build_items({
        "selectedSources": ["src/a.py", "src/b.py"],
        "reasons": ["lexical match", "graph neighbor"],
        "scores": [0.91, 0.42],
    })
    assert items == [
        {"path": "src/a.py", "reason": "lexical match", "score": 0.91, "included": True},
        {"path": "src/b.py", "reason": "graph neighbor", "score": 0.42, "included": True},
    ]


def test_build_items_from_dict_sources() -> None:
    items = context_pack_push._build_items({
        "selectedSources": [
            {"path": "src/a.py", "reason": "anchor", "score": 1.5, "included": False},
            {"path": "src/b.py"},
        ],
    })
    assert items == [
        {"path": "src/a.py", "reason": "anchor", "score": 1.5, "included": False},
        {"path": "src/b.py", "reason": "", "score": 0.0, "included": True},
    ]


def test_build_items_defensive_on_missing_or_malformed_fields() -> None:
    items = context_pack_push._build_items({
        # shorter parallel lists, None score, non-string reason, bool score,
        # plus entries with no usable path that must be dropped
        "selectedSources": ["src/a.py", {"path": ""}, {"reason": "no path"}, None, 42, "src/b.py"],
        "reasons": [None],
        "scores": ["high", None, None, None, None, True],
    })
    assert items == [
        {"path": "src/a.py", "reason": "", "score": 0.0, "included": True},
        {"path": "src/b.py", "reason": "", "score": 0.0, "included": True},
    ]


def test_build_items_handles_non_list_and_empty_retrieval() -> None:
    assert context_pack_push._build_items({}) == []
    assert context_pack_push._build_items({"selectedSources": "src/a.py"}) == []
    assert context_pack_push._build_items({"selectedSources": [], "reasons": "x"}) == []


def test_build_items_caps_at_100() -> None:
    items = context_pack_push._build_items({
        "selectedSources": [f"src/f{i}.py" for i in range(150)],
    })
    assert len(items) == 100
    assert items[0]["path"] == "src/f0.py"
    assert items[-1]["path"] == "src/f99.py"


# ---------------------------------------------------------------------------
# AC1 — quality fields present in payload when supplied
# ---------------------------------------------------------------------------


def test_push_context_pack_quality_fields_in_payload(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}

    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(context_pack_push.urllib.request, "urlopen", fake_urlopen)
    retrieval = {
        "selectedContextTokens": 1000,
        "selectedSources": ["a.py"],
        "precision_at_budget": 0.85,
        "citation_coverage": 0.72,
        "stale_count": 3,
        "denied_count": 1,
        "source_hash_list": ["abc123", "def456"],
    }
    result = context_pack_push.push_context_pack(tmp_path, "run-q", retrieval)
    assert result is True
    body = captured["body"]
    assert body["precision_at_budget"] == 0.85
    assert body["citation_coverage"] == 0.72
    assert body["stale_count"] == 3
    assert body["denied_count"] == 1
    assert body["source_hash_list"] == ["abc123", "def456"]


# AC2 — missing quality fields → safe defaults; returns True on 202


def test_push_context_pack_missing_quality_fields_use_defaults(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}

    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(context_pack_push.urllib.request, "urlopen", fake_urlopen)
    result = context_pack_push.push_context_pack(tmp_path, "run-defaults", {})
    assert result is True
    body = captured["body"]
    assert body["precision_at_budget"] == 0.0
    assert body["citation_coverage"] == 0.0
    assert body["stale_count"] == 0
    assert body["denied_count"] == 0
    assert body["source_hash_list"] == []


def test_push_context_pack_source_hash_list_filters_non_strings(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}

    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(context_pack_push.urllib.request, "urlopen", fake_urlopen)
    retrieval = {
        "source_hash_list": ["valid", 42, None, "also_valid"],
    }
    result = context_pack_push.push_context_pack(tmp_path, "run-filter", retrieval)
    assert result is True
    assert captured["body"]["source_hash_list"] == ["valid", "also_valid"]


def test_payload_includes_items(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    captured: dict = {}

    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(context_pack_push.urllib.request, "urlopen", fake_urlopen)
    ok = context_pack_push.push_context_pack(
        tmp_path, "run-items",
        {
            "selectedContextTokens": 10,
            "selectedSources": ["src/a.py"],
            "reasons": ["match"],
            "scores": [0.7],
        },
    )
    assert ok is True
    assert captured["body"]["items"] == [
        {"path": "src/a.py", "reason": "match", "score": 0.7, "included": True},
    ]


# ---------------------------------------------------------------------------
# Persisted-pack source of truth (issue #1027)
# ---------------------------------------------------------------------------


def _write_pack(tmp_path: Path, pack: dict, name: str = "pack-001.json") -> str:
    """Persist a pack JSON under .agentrail/context/packs and return its rel path."""
    packs_dir = tmp_path / ".agentrail" / "context" / "packs"
    packs_dir.mkdir(parents=True, exist_ok=True)
    (packs_dir / name).write_text(json.dumps(pack), encoding="utf-8")
    return f".agentrail/context/packs/{name}"


def _sample_pack() -> dict:
    """A persisted pack shaped like build_context_pack's output."""
    return {
        "packId": "issue-42-execute-abc",
        "retrievalBudget": {"maxItems": 20, "maxTokens": 12000},
        "included": [
            {"path": "src/a.py", "tokenEstimate": 400, "reason": "anchor", "score": 0.9},
            {"path": "src/b.py", "tokenEstimate": 350},
        ],
        "tokensSaved": 5400,
        "runId": "run-persisted",
        "precision_at_budget": 0.6125,
        "citation_coverage": 0.8333,
        "stale_count": 2,
        "denied_count": 1,
        "source_hash_list": ["sha-a", "sha-b"],
    }


# AC1 — a linked run pushes quality fields byte-equal to the persisted pack JSON.
# The assertion reads the pack file back off disk and compares against the pushed
# payload, so it proves the SOURCE is the persisted pack, not runMetadata.


def test_linked_push_reads_quality_from_persisted_pack(tmp_path: Path, monkeypatch) -> None:
    _write_server_json(tmp_path)
    pack = _sample_pack()
    pack_file = _write_pack(tmp_path, pack)
    captured: dict = {}

    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(context_pack_push.urllib.request, "urlopen", fake_urlopen)

    # A deliberately DIVERGENT retrieval dict: if the push read runMetadata
    # instead of the pack, these values would surface and the assert would fail.
    divergent_retrieval = {
        "selectedContextTokens": 99999,
        "selectedSources": ["WRONG.py"] * 7,
        "precision_at_budget": 0.111,
        "citation_coverage": 0.111,
        "stale_count": 99,
        "denied_count": 99,
        "source_hash_list": ["WRONG"],
        "retrievalBudget": {"maxTokens": 1},
    }
    result = context_pack_push.push_context_pack(
        tmp_path, "run-persisted", divergent_retrieval, pack_file=pack_file,
    )
    assert result is True

    # Read the persisted pack back off disk — the payload must match IT, not the
    # divergent retrieval dict.
    on_disk = json.loads(
        (tmp_path / pack_file).read_text(encoding="utf-8")
    )
    body = captured["body"]
    assert body["precision_at_budget"] == on_disk["precision_at_budget"] == 0.6125
    assert body["citation_coverage"] == on_disk["citation_coverage"] == 0.8333
    assert body["stale_count"] == on_disk["stale_count"] == 2
    assert body["denied_count"] == on_disk["denied_count"] == 1
    assert body["source_hash_list"] == on_disk["source_hash_list"] == ["sha-a", "sha-b"]
    # tokens + budget + sources are also read from the pack, not runMetadata
    assert body["token_budget"] == on_disk["retrievalBudget"]["maxTokens"] == 12000
    assert body["tokens_used"] == 750  # 400 + 350 from included tokenEstimate
    assert body["tokens_saved"] == on_disk["tokensSaved"] == 5400
    assert body["sources_considered"] == len(on_disk["included"]) == 2
    assert body["context_pack_id"] == on_disk["packId"] == "issue-42-execute-abc"
    assert body["items"] == [
        {"path": "src/a.py", "reason": "anchor", "score": 0.9, "included": True},
        {"path": "src/b.py", "reason": "", "score": 0.0, "included": True},
    ]


# AC2 — an unlinked (eval/canary) run produces a pack-metadata push whose payload
# identifies the run. There is no server, so delivery is a local sidecar append.


def test_unlinked_run_emits_run_identifying_pack_metadata(tmp_path: Path, monkeypatch) -> None:
    # No server.json, no env link → unlinked.
    monkeypatch.delenv("AGENTRAIL_SERVER_BASE_URL", raising=False)
    monkeypatch.delenv("AGENTRAIL_SERVER_API_KEY", raising=False)
    monkeypatch.delenv("AGENTRAIL_SERVER_REPOSITORY_ID", raising=False)

    # If any network call is attempted, fail loudly — unlinked must not POST.
    def no_network(req, timeout):
        raise AssertionError("unlinked run must not make a network call")

    monkeypatch.setattr(context_pack_push.urllib.request, "urlopen", no_network)

    pack_file = _write_pack(tmp_path, _sample_pack())
    result = context_pack_push.push_context_pack(
        tmp_path, "eval-run-77", _sample_retrieval(), pack_file=pack_file,
    )
    assert result is True

    sidecar = tmp_path / context_pack_push._UNLINKED_SIDECAR
    assert sidecar.exists()
    records = [json.loads(line) for line in sidecar.read_text().splitlines() if line.strip()]
    assert len(records) == 1
    rec = records[0]
    # The record identifies the run so PRD4 canary reports can join it.
    assert rec["run_id"] == "eval-run-77"
    assert rec["context_pack_id"] == "issue-42-execute-abc"
    assert rec["delivery"] == "unlinked"
    # Quality proxies come from the persisted pack, same as the linked path.
    assert rec["precision_at_budget"] == 0.6125
    assert rec["source_hash_list"] == ["sha-a", "sha-b"]


def test_unlinked_run_without_pack_returns_false(tmp_path: Path, monkeypatch) -> None:
    # Legacy contract: unlinked AND no persisted pack → False, nothing emitted,
    # no network call.
    monkeypatch.delenv("AGENTRAIL_SERVER_BASE_URL", raising=False)
    monkeypatch.delenv("AGENTRAIL_SERVER_API_KEY", raising=False)
    monkeypatch.delenv("AGENTRAIL_SERVER_REPOSITORY_ID", raising=False)

    result = context_pack_push.push_context_pack(
        tmp_path, "eval-run-nopack", _sample_retrieval(),
    )
    assert result is False
    assert not (tmp_path / context_pack_push._UNLINKED_SIDECAR).exists()


def test_missing_pack_file_falls_back_to_retrieval(tmp_path: Path, monkeypatch) -> None:
    # A pack_file that doesn't exist on disk must not crash: the linked push
    # degrades to the legacy retrieval source.
    _write_server_json(tmp_path)
    captured: dict = {}

    class FakeResp:
        status = 202
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(context_pack_push.urllib.request, "urlopen", fake_urlopen)
    retrieval = {
        "selectedContextTokens": 321,
        "selectedSources": ["a.py"],
        "precision_at_budget": 0.5,
    }
    result = context_pack_push.push_context_pack(
        tmp_path, "run-fallback", retrieval,
        pack_file=".agentrail/context/packs/does-not-exist.json",
    )
    assert result is True
    body = captured["body"]
    assert body["tokens_used"] == 321
    assert body["precision_at_budget"] == 0.5
