"""Push a metadata-only index snapshot to the linked AgentRail server.

Reuses the .agentrail/server.json + Bearer + ingest-endpoint rail. Source is
never sent — only {repository_id, commit_sha, indexed_at, source_count,
graph_edge_count}. Every failure is non-fatal: the local index build always
stands on its own.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# NOTE: parallels agentrail/afk/telemetry.py:load_server_config (same server.json
# read + error handling) but additionally returns repository_id, which index
# snapshots require. Kept separate to avoid a context->afk layer dependency;
# unify into a neutral shared loader if a third reader appears.
def load_link(target: Path) -> Optional[Dict[str, str]]:
    """Return {base_url, api_key, repository_id} from server.json, or None."""
    path = target / ".agentrail" / "server.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        return {
            "base_url": str(data["base_url"]).rstrip("/"),
            "api_key": str(data["api_key"]),
            "repository_id": str(data["repository_id"]),
        }
    except (KeyError, ValueError, OSError):
        return None


def _summarize(result: Dict[str, Any]) -> tuple[str, int, int]:
    """Extract (commit_sha, source_count, graph_edge_count) from a build_index result.

    build_index returns two shapes: a fresh build exposes commitSha/indexed/
    graphEdges/ingestionHealth at the top level, while a cache hit returns the
    persisted index.json, where those live under a nested ``snapshot`` dict.
    Read whichever is present so a cached build still pushes real numbers.
    """
    snapshot = result.get("snapshot")
    snapshot = snapshot if isinstance(snapshot, dict) else {}
    health = result.get("ingestionHealth") or snapshot.get("ingestionHealth") or {}

    commit_sha = result.get("commitSha") or snapshot.get("commitSha") or ""

    source_count = result.get("indexed")
    if source_count is None:
        source_count = health.get("indexedCount")

    graph_edge_count = result.get("graphEdges")
    if graph_edge_count is None:
        graph_edge_count = health.get("graphEdgeCount")

    return str(commit_sha), int(source_count or 0), int(graph_edge_count or 0)


def snapshot_payload(result: Dict[str, Any], repository_id: str) -> Dict[str, Any]:
    commit_sha, source_count, graph_edge_count = _summarize(result)
    return {
        "repository_id": repository_id,
        "commit_sha": commit_sha,
        "indexed_at": _now_iso(),
        "source_count": source_count,
        "graph_edge_count": graph_edge_count,
    }


def push_index_snapshot(target: Path, result: Dict[str, Any]) -> bool:
    """POST one snapshot to the linked server. Returns True only on HTTP 202."""
    link = load_link(target)
    if link is None:
        return False
    payload = snapshot_payload(result, link["repository_id"])
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{link['base_url']}/api/v1/ingest/index-snapshots",
        data=body,
        headers={
            "Authorization": f"Bearer {link['api_key']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return int(resp.status) == 202
    except Exception:  # noqa: BLE001 — non-fatal by design
        return False
