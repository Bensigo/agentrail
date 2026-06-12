import json
from pathlib import Path

from agentrail.context import snapshot_push


def _link(tmp_path: Path) -> None:
    d = tmp_path / ".agentrail"
    d.mkdir(parents=True)
    (d / "server.json").write_text(json.dumps({
        "base_url": "http://localhost:3000",
        "workspace_id": "ws",
        "repository_id": "repo-1",
        "api_key": "ar_test",
    }))


def test_payload_maps_build_result_fields(tmp_path):
    result = {"commitSha": "abc123", "indexed": 402, "graphEdges": 8381}
    payload = snapshot_push.snapshot_payload(result, "repo-1")
    assert payload["repository_id"] == "repo-1"
    assert payload["commit_sha"] == "abc123"
    assert payload["source_count"] == 402
    assert payload["graph_edge_count"] == 8381
    assert payload["indexed_at"].endswith("Z")


def test_payload_reads_cached_index_shape(tmp_path):
    # A build_index cache hit returns the persisted index.json, where the fields
    # live under a nested "snapshot" dict instead of at the top level. The payload
    # must still carry real numbers, not zeros.
    cached = {
        "snapshot": {
            "commitSha": "cafef00d",
            "ingestionHealth": {"indexedCount": 410, "graphEdgeCount": 8604},
        },
    }
    payload = snapshot_push.snapshot_payload(cached, "repo-1")
    assert payload["commit_sha"] == "cafef00d"
    assert payload["source_count"] == 410
    assert payload["graph_edge_count"] == 8604


def test_push_skipped_when_not_linked(tmp_path):
    assert snapshot_push.load_link(tmp_path) is None
    assert snapshot_push.push_index_snapshot(tmp_path, {"commitSha": "x"}) is False


def test_push_failure_is_nonfatal(tmp_path, monkeypatch):
    _link(tmp_path)

    def boom(*a, **k):
        raise OSError("network down")

    monkeypatch.setattr(snapshot_push.urllib.request, "urlopen", boom)
    assert snapshot_push.push_index_snapshot(tmp_path, {"commitSha": "x", "indexed": 1, "graphEdges": 2}) is False


def test_push_returns_true_on_202(tmp_path, monkeypatch):
    _link(tmp_path)
    captured = {}

    class FakeResp:
        status = 202
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["auth"] = req.get_header("Authorization")
        return FakeResp()

    monkeypatch.setattr(snapshot_push.urllib.request, "urlopen", fake_urlopen)
    assert snapshot_push.push_index_snapshot(tmp_path, {"commitSha": "x", "indexed": 1, "graphEdges": 2}) is True
    assert captured["url"] == "http://localhost:3000/api/v1/ingest/index-snapshots"
    assert captured["auth"] == "Bearer ar_test"
