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


def test_push_skipped_when_not_linked(tmp_path):
    assert snapshot_push.load_link(tmp_path) is None
    assert snapshot_push.push_index_snapshot(tmp_path, {"commitSha": "x"}) is False


def test_push_failure_is_nonfatal(tmp_path, monkeypatch):
    _link(tmp_path)

    def boom(*a, **k):
        raise OSError("network down")

    monkeypatch.setattr(snapshot_push.urllib.request, "urlopen", boom)
    assert snapshot_push.push_index_snapshot(tmp_path, {"commitSha": "x", "indexed": 1, "graphEdges": 2}) is False
