"""Register a Postgres run record per afk issue + derive the canonical run id.

NON-FATAL: every failure is swallowed; the afk run is never affected.
"""
from __future__ import annotations

import json
import urllib.request
import uuid
from pathlib import Path
from typing import Optional

from agentrail.context.snapshot_push import load_link


def run_uuid(session_id: str, issue: int) -> str:
    """Stable canonical run id for an afk issue-run (same for start + finish)."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"agentrail-run:{session_id}:{issue}"))


def register_run(
    target: Path,
    *,
    run_id: str,
    agent: str,
    branch: str,
    title: str,
    status: str,
    started_at: Optional[str] = None,
    finished_at: Optional[str] = None,
    cost_usd: float = 0.0,
) -> bool:
    """Upsert a run record on the server. Returns True only on HTTP 202."""
    link = load_link(target)
    if link is None:
        return False
    payload = {
        "id": run_id,
        "repository_id": link["repository_id"],
        "agent": agent,
        "branch": branch,
        "title": title,
        "status": status,
        "cost_usd": cost_usd,
    }
    if started_at:
        payload["started_at"] = started_at
    if finished_at:
        payload["finished_at"] = finished_at
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{link['base_url']}/api/v1/ingest/runs",
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
