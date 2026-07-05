"""Pull the linked server's memory_items into the local snapshot (issue #1071).

#1039 shipped the factory's READ half of shared memory:
:mod:`agentrail.context.memory_lane` consumes a local snapshot JSON at
:data:`~agentrail.context.memory_lane.MEMORY_SNAPSHOT_REL` — but nothing wrote
that snapshot on a live run, so the pack's memory lane was structurally empty
in production. This module is the missing PRODUCER half: it fetches the
repository's ``memory_items`` rows from the linked AgentRail server and writes
them to the snapshot path the lane already reads.

Transport mirrors :mod:`agentrail.context.snapshot_push` — the codebase's one
existing HTTP rail — exactly: the link (base URL + bearer key + repository id)
comes from :func:`agentrail.context.snapshot_push.load_link` (``server.json``
or the ``AGENTRAIL_SERVER_*`` env vars afk sets for ephemeral worktrees), the
timeout is short, and EVERY failure is non-fatal. The only difference is
direction: this is the first context *pull* (GET
``/api/v1/context/memory-items``), whereas snapshot_push is push-only.

Design points, each tested in ``tests/context/test_memory_fetch.py``:

* **Non-fatal, structurally (AC2).** The entire body runs inside one
  ``try/except Exception``: no network, auth, parse, or filesystem failure can
  ever raise out of :func:`fetch_memory_snapshot` and break a run. Unlinked
  repos skip the network entirely.

* **Last-known-good on failure.** A failed refresh never deletes or truncates
  an existing snapshot; the lane falls back to the previous (stale) rows, or
  renders empty if none were ever fetched. Freshness is advisory; safety is
  not.

* **TTL freshness ≈ once per run.** A run builds several packs (plan /
  execute / verify), each of which calls this producer. A snapshot younger
  than :data:`MEMORY_SNAPSHOT_TTL_SECONDS` short-circuits the fetch, so a
  normal run hits the server about once rather than once per pack. Pass
  ``ttl_seconds=0`` to force a refetch.

* **Trust boundary unchanged.** This module only moves bytes; it deliberately
  performs NO sanitization, capping, or framing. All of that stays read-side
  in :mod:`agentrail.context.memory_lane` (secret filter, byte cap, untrusted
  fencing), which treats the snapshot as untrusted input regardless of who
  wrote it. Duplicating filtering here would invite the two sides to drift.
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from agentrail.context.memory_lane import MEMORY_SNAPSHOT_REL
from agentrail.context.snapshot_push import load_link

# Short, same as snapshot_push: a slow server must never stall a pack build.
MEMORY_FETCH_TIMEOUT_SECONDS = 5

# Snapshot younger than this is considered fresh and skips the network round
# trip. 5 minutes comfortably covers one run's plan→execute→verify pack builds
# while still picking up new memories between runs.
MEMORY_SNAPSHOT_TTL_SECONDS = 300.0


def fetch_memory_snapshot(
    target: Path,
    *,
    ttl_seconds: float = MEMORY_SNAPSHOT_TTL_SECONDS,
) -> bool:
    """Refresh ``<target>/{MEMORY_SNAPSHOT_REL}`` from the linked server.

    Returns True when the snapshot is usable-fresh (just written, or already
    younger than *ttl_seconds*); False when the repo is unlinked or the fetch
    failed for any reason. Never raises, and never removes an existing
    snapshot on failure — callers may treat the result as purely advisory.
    """
    try:
        snapshot_path = Path(target) / MEMORY_SNAPSHOT_REL
        if ttl_seconds > 0 and snapshot_path.exists():
            age = time.time() - snapshot_path.stat().st_mtime
            # Negative age = mtime in the future (clock skew); treat as stale.
            if 0 <= age < ttl_seconds:
                return True

        link = load_link(Path(target))
        if link is None:
            return False

        url = (
            f"{link['base_url']}/api/v1/context/memory-items?"
            + urllib.parse.urlencode({"repository_id": link["repository_id"]})
        )
        req = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {link['api_key']}"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=MEMORY_FETCH_TIMEOUT_SECONDS) as resp:
            if int(getattr(resp, "status", 200)) != 200:
                return False
            payload = json.loads(resp.read().decode("utf-8"))

        items = payload.get("items") if isinstance(payload, dict) else None
        if not isinstance(items, list):
            return False
        # Server bytes must never be able to crash a pack build: keep only
        # dict-shaped rows (mirrors load_memory_snapshot's read-side guard).
        items = [item for item in items if isinstance(item, dict)]

        snapshot_path.parent.mkdir(parents=True, exist_ok=True)
        snapshot_path.write_text(
            json.dumps(
                {
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                    "repository_id": link["repository_id"],
                    "items": items,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        return True
    except Exception:  # noqa: BLE001 — non-fatal by design (AC2), like snapshot_push
        return False
