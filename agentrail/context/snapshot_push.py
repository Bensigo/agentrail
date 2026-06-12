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


def snapshot_payload(result: Dict[str, Any], repository_id: str) -> Dict[str, Any]:
    return {
        "repository_id": repository_id,
        "commit_sha": str(result.get("commitSha") or ""),
        "indexed_at": _now_iso(),
        "source_count": int(result.get("indexed") or 0),
        "graph_edge_count": int(result.get("graphEdges") or 0),
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
