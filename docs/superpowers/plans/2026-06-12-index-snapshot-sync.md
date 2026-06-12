# Index-Snapshot Sync (Repo Health) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agentrail context index` push a metadata-only index snapshot to the linked dashboard so repo health stops showing "critical"; have `link` auto-index; add a dashboard "Re-index" command popover.

**Architecture:** Reuse the proven `server.json` + Bearer + ingest-endpoint rail (today only `run-events` flows). Add a sibling ingest endpoint `POST /api/v1/ingest/index-snapshots` that writes the existing-but-empty ClickHouse `index_snapshots` table; the CLI POSTs a snapshot after each local index build. Source never leaves the machine — only `{repository_id, commit_sha, indexed_at, source_count, graph_edge_count}`.

**Tech Stack:** Next.js (App Router, route handlers) + vitest; ClickHouse via `@agentrail/db-clickhouse`; Postgres via `@agentrail/db-postgres`; Python 3 stdlib CLI (`urllib`), pytest.

**Spec:** `docs/superpowers/specs/2026-06-12-index-snapshot-sync-design.md`

---

## File Structure

- Create `packages/db-clickhouse/src/queries.ts` → add `insertIndexSnapshots` + `deriveSnapshotEventId` (export). Mirrors existing `insertAfkRunEvents`.
- Create `apps/console/app/api/v1/ingest/index-snapshots/route.ts` — ingest endpoint (mirrors `run-events/route.ts`, adds repo-belongs-to-workspace check).
- Create `apps/console/app/api/v1/ingest/index-snapshots/route.test.ts` — vitest route test.
- Create `agentrail/context/snapshot_push.py` — server.json reader + payload builder + non-fatal POST.
- Modify `agentrail/cli/commands/context.py` — `index` branch calls the push (unless `--no-push`).
- Modify `agentrail/cli/commands/link.py` — auto-run `build_index` + push after linking (unless `--no-index`).
- Create `tests/context/test_snapshot_push.py` — pytest for payload + skip/failure behavior.
- Modify `apps/console/app/(dashboard)/dashboard/[workspaceId]/repos/components/repos-table.tsx` — per-row "Re-index" button + command popover, backed by a pure `reindexCommand()` helper.
- Create `apps/console/app/(dashboard)/dashboard/[workspaceId]/repos/components/reindex-command.ts` — `reindexCommand()` helper.
- Create `apps/console/app/(dashboard)/dashboard/[workspaceId]/repos/components/reindex-command.test.ts` — vitest unit test.

---

## Task 1: ClickHouse `insertIndexSnapshots`

**Files:**
- Modify: `packages/db-clickhouse/src/queries.ts`
- Test: `packages/db-clickhouse/src/queries.test.ts` (create if absent)

Reference — the `index_snapshots` table columns (verified): `workspace_id String, repository_id String, commit_sha String, indexed_at DateTime64(3,'UTC'), source_count UInt32, graph_edge_count UInt32, event_id String`. Mirror the existing `insertAfkRunEvents` (same file) for the dedupe-then-insert shape.

- [ ] **Step 1: Write the failing test** for the event-id helper determinism + idempotency key.

`packages/db-clickhouse/src/queries.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveSnapshotEventId } from "./queries";

describe("deriveSnapshotEventId", () => {
  it("is deterministic for the same inputs", () => {
    const a = deriveSnapshotEventId("ws", "repo", "abc123", "2026-06-12T00:00:00.000Z");
    const b = deriveSnapshotEventId("ws", "repo", "abc123", "2026-06-12T00:00:00.000Z");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });

  it("differs when any field differs", () => {
    const base = deriveSnapshotEventId("ws", "repo", "abc123", "2026-06-12T00:00:00.000Z");
    expect(deriveSnapshotEventId("ws", "repo", "abc123", "2026-06-12T00:00:01.000Z")).not.toBe(base);
    expect(deriveSnapshotEventId("ws", "repo2", "abc123", "2026-06-12T00:00:00.000Z")).not.toBe(base);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentrail/db-clickhouse test -- queries.test.ts`
Expected: FAIL — `deriveSnapshotEventId` is not exported.

- [ ] **Step 3: Add the helper and insert function** to `packages/db-clickhouse/src/queries.ts` (the file already imports `createHash` from `crypto` and has a module-level `client`).

```ts
export interface IndexSnapshotInput {
  workspace_id: string;
  repository_id: string;
  commit_sha: string;
  indexed_at: string; // ISO 8601
  source_count: number;
  graph_edge_count: number;
}

export function deriveSnapshotEventId(
  workspaceId: string,
  repositoryId: string,
  commitSha: string,
  indexedAt: string
): string {
  return createHash("sha1")
    .update(`${workspaceId}:${repositoryId}:${commitSha}:${indexedAt}`)
    .digest("hex");
}

export async function insertIndexSnapshots(
  snapshots: IndexSnapshotInput[]
): Promise<number> {
  if (snapshots.length === 0) return 0;

  const candidates = snapshots.map((s) => ({
    s,
    event_id: deriveSnapshotEventId(
      s.workspace_id,
      s.repository_id,
      s.commit_sha,
      s.indexed_at
    ),
  }));

  const eventIds = candidates.map((c) => c.event_id);
  const checkResult = await client.query({
    query: `
      SELECT event_id
      FROM index_snapshots
      WHERE workspace_id = {workspaceId: String}
        AND event_id IN ({eventIds: Array(String)})
    `,
    query_params: { workspaceId: snapshots[0].workspace_id, eventIds },
    format: "JSONEachRow",
  });
  const existing = new Set(
    (await checkResult.json<{ event_id: string }>()).map((r) => r.event_id)
  );

  const toInsert = candidates.filter((c) => !existing.has(c.event_id));
  if (toInsert.length === 0) return 0;

  const rows = toInsert.map(({ s, event_id }) => ({
    workspace_id: s.workspace_id,
    repository_id: s.repository_id,
    commit_sha: s.commit_sha,
    indexed_at: new Date(s.indexed_at)
      .toISOString()
      .replace("T", " ")
      .replace("Z", ""),
    source_count: s.source_count,
    graph_edge_count: s.graph_edge_count,
    event_id,
  }));

  await client.insert({
    table: "index_snapshots",
    values: rows,
    format: "JSONEachRow",
  });

  return toInsert.length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentrail/db-clickhouse test -- queries.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db-clickhouse/src/queries.ts packages/db-clickhouse/src/queries.test.ts
git commit -m "feat(db-clickhouse): insertIndexSnapshots + deriveSnapshotEventId"
```

---

## Task 2: Ingest endpoint `POST /api/v1/ingest/index-snapshots`

**Files:**
- Create: `apps/console/app/api/v1/ingest/index-snapshots/route.ts`
- Test: `apps/console/app/api/v1/ingest/index-snapshots/route.test.ts`

Mirrors `apps/console/app/api/v1/ingest/run-events/route.ts`. Difference: snapshots are per-repo, so `repository_id` comes from the body and must be validated against the key's workspace via `getRepository(workspaceId, repository_id)` (same call the `cli/link` route uses).

- [ ] **Step 1: Write the failing test** (`route.test.ts`), mirroring the mocking style of `apps/console/app/api/v1/workspaces/[workspaceId]/repos/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-clickhouse", () => ({
  insertIndexSnapshots: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getRepository: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { POST } from "./route";
import { insertIndexSnapshots } from "@agentrail/db-clickhouse";
import { getRepository } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const WS = "00000000-0000-0000-0000-000000000001";
const REPO = "00000000-0000-0000-0000-000000000010";

function req(body: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/ingest/index-snapshots", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: "Bearer ar_test" } : {}),
    },
    body: JSON.stringify(body),
  });
}

const valid = {
  repository_id: REPO,
  commit_sha: "abc123",
  indexed_at: "2026-06-12T00:00:00.000Z",
  source_count: 402,
  graph_edge_count: 8381,
};

beforeEach(() => {
  vi.clearAllMocks();
  (requireBearer as any).mockResolvedValue({ workspaceId: WS, apiKeyId: "k1", teamId: null });
  (getRepository as any).mockResolvedValue({ id: REPO, workspaceId: WS });
  (insertIndexSnapshots as any).mockResolvedValue(1);
});

describe("POST /api/v1/ingest/index-snapshots", () => {
  it("401 when requireBearer rejects", async () => {
    const { NextResponse } = await import("next/server");
    (requireBearer as any).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
    const res = await POST(req(valid, false));
    expect(res.status).toBe(401);
  });

  it("202 + accepted count on valid snapshot", async () => {
    const res = await POST(req(valid));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(insertIndexSnapshots).toHaveBeenCalledWith([
      { workspace_id: WS, ...valid },
    ]);
  });

  it("404 when repo not in the key's workspace", async () => {
    (getRepository as any).mockResolvedValue(null);
    const res = await POST(req(valid));
    expect(res.status).toBe(404);
    expect(insertIndexSnapshots).not.toHaveBeenCalled();
  });

  it("400 on malformed snapshot", async () => {
    const res = await POST(req({ repository_id: REPO }));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentrail/console test -- index-snapshots/route.test.ts`
Expected: FAIL — `./route` does not exist.

- [ ] **Step 3: Create the route** (`route.ts`):

```ts
/**
 * POST /api/v1/ingest/index-snapshots
 *
 * Accepts a single index snapshot or an array of up to 100.
 * Authenticates via bearer API key (see lib/bearer-auth.ts).
 * workspace_id comes from the API key; repository_id is validated to belong
 * to that workspace. Source is never sent — only snapshot metadata.
 *
 * Returns: 202 { accepted: N }
 */
import { NextRequest, NextResponse } from "next/server";
import { insertIndexSnapshots } from "@agentrail/db-clickhouse";
import { getRepository } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

interface RawSnapshot {
  repository_id: string;
  commit_sha: string;
  indexed_at: string;
  source_count: number;
  graph_edge_count: number;
}

function isRawSnapshot(v: unknown): v is RawSnapshot {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.repository_id === "string" &&
    typeof o.commit_sha === "string" &&
    typeof o.indexed_at === "string" &&
    typeof o.source_count === "number" &&
    typeof o.graph_edge_count === "number"
  );
}

export async function POST(req: NextRequest) {
  const auth = await requireBearer(req);
  if (auth instanceof NextResponse) return auth;
  const { workspaceId } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const raw: unknown[] = Array.isArray(body) ? body : [body];
  if (raw.length === 0 || raw.length > 100) {
    return NextResponse.json(
      { error: "Batch must contain 1–100 snapshots" },
      { status: 400 }
    );
  }

  const valid: RawSnapshot[] = [];
  for (const item of raw) {
    if (!isRawSnapshot(item)) {
      return NextResponse.json(
        {
          error:
            "Each snapshot must have repository_id (string), commit_sha (string), indexed_at (string), source_count (number), graph_edge_count (number)",
        },
        { status: 400 }
      );
    }
    valid.push(item);
  }

  for (const s of valid) {
    const repo = await getRepository(workspaceId, s.repository_id);
    if (!repo) {
      return NextResponse.json(
        { error: `Repository ${s.repository_id} not found in this workspace` },
        { status: 404 }
      );
    }
  }

  const inputs = valid.map((s) => ({
    workspace_id: workspaceId,
    repository_id: s.repository_id,
    commit_sha: s.commit_sha,
    indexed_at: s.indexed_at,
    source_count: s.source_count,
    graph_edge_count: s.graph_edge_count,
  }));

  let accepted = 0;
  try {
    accepted = await insertIndexSnapshots(inputs);
  } catch (err) {
    console.error("[ingest/index-snapshots] ClickHouse insert failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  return NextResponse.json({ accepted }, { status: 202 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentrail/console test -- index-snapshots/route.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add "apps/console/app/api/v1/ingest/index-snapshots/route.ts" "apps/console/app/api/v1/ingest/index-snapshots/route.test.ts"
git commit -m "feat(console): POST /api/v1/ingest/index-snapshots ingest endpoint"
```

---

## Task 3: CLI push from `context index`

**Files:**
- Create: `agentrail/context/snapshot_push.py`
- Modify: `agentrail/cli/commands/context.py` (the `kind == "index"` branch, ~line 104)
- Test: `tests/context/test_snapshot_push.py`

Reference — `build_index(target)` returns a dict whose relevant keys are (verified): `"commitSha"`, `"indexed"` (source count), `"graphEdges"` (graph edge count). `server.json` shape: `{ base_url, workspace_id, repository_id, api_key }`.

- [ ] **Step 1: Write the failing test** (`tests/context/test_snapshot_push.py`):

```python
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
    # No server.json → load_link returns None → push returns False, no network.
    assert snapshot_push.load_link(tmp_path) is None
    assert snapshot_push.push_index_snapshot(tmp_path, {"commitSha": "x"}) is False


def test_push_failure_is_nonfatal(tmp_path, monkeypatch):
    _link(tmp_path)

    def boom(*a, **k):
        raise OSError("network down")

    monkeypatch.setattr(snapshot_push.urllib.request, "urlopen", boom)
    # Must not raise; returns False on failure.
    assert snapshot_push.push_index_snapshot(tmp_path, {"commitSha": "x", "indexed": 1, "graphEdges": 2}) is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/context/test_snapshot_push.py -q`
Expected: FAIL — module `agentrail.context.snapshot_push` does not exist.

- [ ] **Step 3: Create `agentrail/context/snapshot_push.py`:**

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/context/test_snapshot_push.py -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the push into the `index` branch** of `agentrail/cli/commands/context.py`. Replace the existing `kind == "index"` block:

```python
        if kind == "index":
            target, remaining = _parse_target(rest)
            no_push = "--no-push" in remaining
            remaining = [a for a in remaining if a != "--no-push"]
            if remaining:
                raise SystemExit(f"Unknown option: {remaining[0]}")
            result = build_index(target)
            _print_json(result)
            if not no_push:
                from agentrail.context.snapshot_push import load_link, push_index_snapshot
                if push_index_snapshot(target, result):
                    print("pushed index snapshot to dashboard", file=sys.stderr)
                elif load_link(target) is not None:
                    print(
                        "warning: failed to push index snapshot; repo health may stay stale",
                        file=sys.stderr,
                    )
            return 0
```

Note: `sys` is already imported in `context.py`; `target` is already a `Path` (from `_parse_target`).

- [ ] **Step 6: Run the full context test suite + the CLI smoke**

Run: `python3 -m pytest tests/context/ tests/cli/ -q`
Expected: PASS (no regressions).

- [ ] **Step 7: Commit**

```bash
git add agentrail/context/snapshot_push.py agentrail/cli/commands/context.py tests/context/test_snapshot_push.py
git commit -m "feat(cli): push index snapshot to dashboard after context index (--no-push to skip)"
```

---

## Task 4: `link` auto-index

**Files:**
- Modify: `agentrail/cli/commands/link.py` (after `server.json` is written, ~line 171–176)
- Test: `tests/cli/test_link_cli.py` (add cases; create if absent)

Goal: after a successful link, build the index once and push it so health goes green immediately. `--no-index` skips it. Index/push failures never fail the link (server.json is already written).

- [ ] **Step 1: Write the failing test** (add to `tests/cli/test_link_cli.py`):

```python
from unittest.mock import patch
from pathlib import Path

from agentrail.cli.commands import link as link_mod


def test_link_auto_indexes_on_success(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with patch.object(link_mod, "_post_link", return_value={"workspace": {"name": "W"}, "repository": {"name": "R"}}), \
         patch.object(link_mod, "build_index", return_value={"commitSha": "x", "indexed": 1, "graphEdges": 2}) as bi, \
         patch.object(link_mod, "push_index_snapshot", return_value=True) as push:
        rc = link_mod.run_link([
            "--workspace", "ws", "--repo", "repo", "--key", "ar_k",
            "--base-url", "http://localhost:3000",
        ])
    assert rc == 0
    bi.assert_called_once()
    push.assert_called_once()


def test_link_no_index_flag_skips_indexing(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with patch.object(link_mod, "_post_link", return_value={"workspace": {"name": "W"}, "repository": {"name": "R"}}), \
         patch.object(link_mod, "build_index") as bi:
        rc = link_mod.run_link([
            "--workspace", "ws", "--repo", "repo", "--key", "ar_k",
            "--base-url", "http://localhost:3000", "--no-index",
        ])
    assert rc == 0
    bi.assert_not_called()
```

(If `link.py`'s server POST is not already a helper named `_post_link`, the first refactor step below extracts it so the test can mock the network.)

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/cli/test_link_cli.py -q`
Expected: FAIL — `build_index`/`push_index_snapshot`/`_post_link` not present on the module, or `--no-index` unknown.

- [ ] **Step 3: Edit `agentrail/cli/commands/link.py`:**

1. Add imports near the top:

```python
from agentrail.context.index import build_index
from agentrail.context.snapshot_push import push_index_snapshot
```

2. Add `--no-index` to the arg parser (alongside the existing `--force` handling): set a local `no_index = False`, and when the arg is `--no-index`, set `no_index = True`.

3. After the existing success block that writes server.json and prints `config written to …`, append:

```python
    # Auto-index so the dashboard gets an initial snapshot and repo health goes
    # green immediately. Never fails the link — server.json is already written.
    if not no_index:
        try:
            result = build_index(cwd)
            if push_index_snapshot(cwd, result):
                print("indexed and pushed snapshot — repo health will update shortly")
            else:
                print("indexed locally, but snapshot push failed; run `agentrail context index` to retry")
        except Exception as exc:  # noqa: BLE001
            print(f"linked, but initial index failed ({exc}); run `agentrail context index` manually")
```

Here `cwd` is the same `Path` the function already uses to locate `server.json` (the repo root). If the network POST in `run_link` is inline rather than a `_post_link` helper, first extract it into a module-level `def _post_link(base_url, workspace, repo, key) -> dict:` returning the parsed JSON response, and call that from `run_link`, so the test can mock it.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/cli/test_link_cli.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agentrail/cli/commands/link.py tests/cli/test_link_cli.py
git commit -m "feat(cli): link auto-runs first index + snapshot push (--no-index to skip)"
```

---

## Task 5: Dashboard "Re-index" command popover

**Files:**
- Create: `apps/console/app/(dashboard)/dashboard/[workspaceId]/repos/components/reindex-command.ts`
- Test: `apps/console/app/(dashboard)/dashboard/[workspaceId]/repos/components/reindex-command.test.ts`
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/repos/components/repos-table.tsx`

The button does not execute anything server-side (indexing is local) — it reveals the command to copy/run. Keep the command string in a pure helper so it is unit-testable without RTL (the console has no component-test setup, only route tests).

- [ ] **Step 1: Write the failing test** (`reindex-command.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { reindexCommand } from "./reindex-command";

describe("reindexCommand", () => {
  it("returns the context index command", () => {
    expect(reindexCommand()).toBe("agentrail context index");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentrail/console test -- reindex-command.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `reindex-command.ts`:**

```ts
/** The command a user runs locally to re-index a repo and refresh its health. */
export function reindexCommand(): string {
  return "agentrail context index";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentrail/console test -- reindex-command.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the button + popover to `repos-table.tsx`.** It is already a client component (`"use client"` with `useState`). Add near the other imports:

```tsx
import { reindexCommand } from "./reindex-command";
```

Add popover state inside `ReposTable` (next to the existing `rows` state):

```tsx
  const [reindexOpenFor, setReindexOpenFor] = useState<string | null>(null);
```

In the per-row markup (inside the `rows.map(...)` row), add a cell with the button and an inline popover:

```tsx
        <td className="px-3 py-2 text-right relative">
          <button
            type="button"
            onClick={() => setReindexOpenFor(reindexOpenFor === row.id ? null : row.id)}
            className="text-[#70b8ff] hover:underline text-sm"
          >
            Re-index
          </button>
          {reindexOpenFor === row.id && (
            <div className="absolute right-0 mt-1 z-10 w-72 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3 text-left shadow">
              <p className="text-xs text-[var(--gray-09)] mb-1">
                Run this from the repo root to re-index and refresh health:
              </p>
              <code className="block text-xs bg-black/30 rounded px-2 py-1 select-all">
                {reindexCommand()}
              </code>
            </div>
          )}
        </td>
```

(Match the existing table's column count — add a matching empty `<th></th>` to the header row so the columns line up.)

- [ ] **Step 6: Verify the suite + lint + typecheck**

Run: `pnpm --filter @agentrail/console test && pnpm --filter @agentrail/console lint`
Expected: PASS. Then manually confirm in `agentrail console`: the repo page shows a "Re-index" button whose popover displays `agentrail context index`.

- [ ] **Step 7: Commit**

```bash
git add "apps/console/app/(dashboard)/dashboard/[workspaceId]/repos/components/reindex-command.ts" "apps/console/app/(dashboard)/dashboard/[workspaceId]/repos/components/reindex-command.test.ts" "apps/console/app/(dashboard)/dashboard/[workspaceId]/repos/components/repos-table.tsx"
git commit -m "feat(console): re-index command popover on the repos page"
```

---

## Task 6: End-to-end verification (manual, with the live local stack)

**Files:** none (verification only).

- [ ] **Step 1:** With `agentrail console` running and the repo linked, run `agentrail context index` from the repo root. Expected stderr: `pushed index snapshot to dashboard`.

- [ ] **Step 2:** Confirm the snapshot landed:

Run: `docker exec -i bensigo-ai-workflow-clickhouse-1 clickhouse-client -u agentrail --password agentrail -d agentrail -q "select repository_id, source_count, graph_edge_count, indexed_at from index_snapshots order by indexed_at desc limit 3"`
Expected: a row for the linked repo with non-zero `source_count`.

- [ ] **Step 3:** Reload the dashboard repos page. Expected: repo health is **healthy** (was "critical").

- [ ] **Step 4:** Re-run `agentrail context index` immediately; confirm the dashboard still shows one fresh snapshot (idempotency — same commit/second dedupes) and health stays healthy.

---

## Self-Review

- **Spec coverage:** ingest endpoint (Task 2 + Task 1), CLI push when linked + `--no-push` (Task 3), `link` auto-index + `--no-index` (Task 4), dashboard re-index command popover (Task 5), health-goes-green verification (Task 6). Error handling (non-fatal push, not-linked-no-error, repo-not-in-workspace 404) covered in Tasks 2–4 tests. All spec sections map to a task.
- **Type consistency:** `IndexSnapshotInput` (Task 1) fields match the route's `inputs` object (Task 2) and the Python `snapshot_payload` keys (`repository_id, commit_sha, indexed_at, source_count, graph_edge_count`) (Task 3). `build_index` keys used (`commitSha, indexed, graphEdges`) are the verified return keys. `reindexCommand()` name matches between Task 5 helper, test, and component import.
- **No placeholders:** every code step contains complete code; commands have expected output.
