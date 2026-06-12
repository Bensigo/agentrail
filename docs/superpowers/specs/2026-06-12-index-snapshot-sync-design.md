# CLI → dashboard index-snapshot sync (repo health) + manual re-index

Status: approved design (2026-06-12)

## Problem

A repo linked to the dashboard (`agentrail link`) shows **repo health = "critical"**
forever, even immediately after linking.

Root cause (verified):

- The dashboard's repo health is computed **only** from index-snapshot freshness
  (`apps/console/app/api/v1/workspaces/[workspaceId]/repos/route.ts`,
  `computeHealth`): `null → critical`, `<1h → healthy`, `<24h → stale`,
  `≥24h → critical`. Staleness is `now - latest index_snapshots.indexed_at`.
- The ClickHouse `index_snapshots` table is **empty for every repo**. Nothing ever
  populates it:
  - The only ingest HTTP endpoint is `POST /api/v1/ingest/run-events`. There is
    **no** `/api/v1/ingest/index-snapshots` route.
  - `agentrail context index` builds the index **locally** and never reads
    `server.json` or POSTs anything.
  - `agentrail link` only validates the API key and writes
    `.agentrail/server.json`. It pushes no data and triggers no indexing.

So `stalenessSeconds` is always `null` → **critical**. This is a wiring gap: the
dashboard reads a metric the CLI has no way to populate.

Note: the *contract* for index-snapshot ingestion already exists
(`agentrail/server/ingestion.py` defines an `index_snapshot` envelope with an
idempotency identity). The missing pieces are the **HTTP endpoint** and the
**CLI push**.

## Goal

Make `agentrail context index` push an **index snapshot** (metadata only — never
source) to the server so repo health reflects reality, have `link` auto-run that
first index so health goes green right after linking, and give the dashboard a
**manual "Re-index" affordance** that surfaces the command to run.

Non-source-leaking by construction: only snapshot **metadata** is sent
(repo id, indexed-at, commit sha, index hash, source count, ingestion health),
consistent with the control-plane principle that full source stays repo-adjacent.

## Scope

In scope:

1. Server: `POST /api/v1/ingest/index-snapshots` ingest endpoint → ClickHouse
   `index_snapshots`.
2. CLI: `agentrail context index` pushes a snapshot when `.agentrail/server.json`
   is present (`--no-push` to opt out).
3. CLI: `agentrail link` auto-runs the first `context index` (foreground) on
   success so health goes green immediately.
4. Dashboard: a "Re-index" button on the repo page that opens a popover showing
   the copy-pasteable command (`agentrail context index`) and the repo path.

Explicitly **out of scope** (separate sibling spec, reuses the same push rail):

- Token-usage / cost-event recording → dashboard (#398). It rides the same
  "CLI pushes data to the dashboard" rail but is its own feature.

## Architecture / data flow

```
agentrail context index
  → build local index            (unchanged)
  → read .agentrail/server.json  (if absent: skip push, no error)
  → POST /api/v1/ingest/index-snapshots  (Authorization: Bearer ar_…)
        body: index_snapshot envelope (metadata only)
  → server: requireBearer → validate workspace + repo → insert ClickHouse
            index_snapshots row (idempotent on the existing identity)
  → repos route computes staleness from latest snapshot → health = healthy
```

The CLI push reuses the exact rail proven working for `run-events`:
`server.json` (`base_url`, `api_key`, `workspace_id`, `repository_id`) +
Bearer auth + the ingest endpoint pattern.

## Components

### Server — new ingest route

`apps/console/app/api/v1/ingest/index-snapshots/route.ts`, mirroring
`run-events/route.ts`:

- `requireBearer(req)` → 401 on missing/invalid key.
- Validate body shape (single object or array, bounded batch size).
- `workspace_id` / `repository_id` are taken from the **authenticated key**, not
  trusted from the body (same rule run-events uses).
- Insert into ClickHouse `index_snapshots` via the db-clickhouse package
  (`insertIndexSnapshots`, paralleling `insertAfkRunEvents`).
- Idempotent: dedupe on the existing `_index_snapshot_identity`
  (workspace, repo, indexer, snapshot id, commit sha, index hash).
- Returns `{ accepted: N }`, HTTP 202.

### CLI — push on index

`agentrail/context/index.py` (and/or `cli/commands/context.py`):

- After a successful local index build, if `.agentrail/server.json` exists and
  push is not disabled, construct an `index_snapshot` envelope from the build
  result:
  - `repository_id`, `indexed_at` (now, UTC), `commit_sha` (current HEAD),
    `index_hash` (existing index audit hash if available), `source_count`
    (indexed file count), `ingestion_health` (the health block the index command
    already computes — `indexedCount`/`skippedCount`/`redactionCount`/graph
    counts).
- POST it to `{base_url}/api/v1/ingest/index-snapshots` with Bearer auth,
  short timeout, reusing the existing telemetry POST helper pattern in
  `agentrail/afk/telemetry.py`.
- **Non-fatal:** the local index always succeeds; a push failure (server down,
  not linked, rejected) prints a one-line warning and exits 0. Health simply
  stays stale until a later successful push.
- `--no-push` flag (and/or `AGENTRAIL_NO_PUSH=1`) to skip the push.

### CLI — `link` auto-index

`agentrail/cli/commands/link.py`: after writing `server.json` and printing the
success line, run the first `context index` (foreground, normal output) so the
repo gets an initial snapshot and health goes green right after linking.

- If that index fails, link still succeeds (server.json is written); print a
  hint to run `agentrail context index` manually.
- `--no-index` flag to skip the auto-index (e.g. CI linking).

### Dashboard — manual re-index button

Repo page (`app/(dashboard)/dashboard/[workspaceId]/repos/components/repos-table.tsx`):

- A "Re-index" button per repo row. Clicking opens a small popover/modal that
  shows the exact command to copy: `agentrail context index` (plus a note to run
  it from the repo root). It does **not** execute anything server-side — indexing
  is local; this is a guided command, the agreed model.

## Error handling

| Situation | Behavior |
| --- | --- |
| Not linked (no `server.json`) | `context index` skips push silently; no error |
| Server unreachable / 5xx | Local index succeeds; one-line warning; exit 0 |
| Bad key / repo (401/403/404) | Local index succeeds; clear warning naming the cause; exit 0 |
| `link` auto-index fails | `link` still succeeds; hint to run `context index` manually |
| Duplicate snapshot | Server dedupes on existing idempotency identity; `accepted` reflects it |

## Testing

- **CLI push** (unit, mocked server): asserts the envelope shape and fields,
  that push only happens when linked, `--no-push` skips it, and that a push
  failure is non-fatal (index still exits 0).
- **Server route** (mirrors `run-events/route.test.ts`): 401 without key; 202 with
  valid key; workspace/repo derived from key not body; bad batch → 400;
  idempotent insert.
- **`link` auto-index** (unit): success path runs index once; index failure still
  writes `server.json`; `--no-index` skips.
- **Health recompute** (integration-ish): after a snapshot is inserted, the repos
  route reports `healthy`.

## Rollout

1. Server endpoint + db-clickhouse `insertIndexSnapshots`.
2. CLI push from `context index` (behind linked-detection; `--no-push`).
3. `link` auto-index (`--no-index`).
4. Dashboard re-index button (command popover).

Each step is independently shippable; (1)+(2) alone already turn repo health green
for anyone who runs `context index` while linked.
