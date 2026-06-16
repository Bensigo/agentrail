import { eq, and, sql } from "drizzle-orm";
import { createHash, randomBytes } from "crypto";
import { db } from "../db.js";
import { deviceCodes } from "../schema/device_codes.js";
import { queueEntries } from "../schema/queue_entries.js";
import { connectors } from "../schema/connectors.js";
import type { ConnectorConfig } from "../schema/connectors.js";
import { apiKeys } from "../schema/api_keys.js";
import { runs } from "../schema/runs.js";
import { repositories } from "../schema/repositories.js";

// ---------------------------------------------------------------------------
// API-key minting (runner token)
// ---------------------------------------------------------------------------

/**
 * Mint a fresh `api_keys` row and return BOTH the persisted row and the RAW key.
 *
 * The raw key (format `ar_<64 hex>`) is the value the caller must hand to the
 * client exactly once — only the sha256 hash is stored. This mirrors the
 * console's session-authenticated key route so the runner token is an ordinary
 * api_key that `requireBearer` validates for free.
 */
export async function mintApiKey(data: {
  workspaceId: string;
  teamId?: string | null;
  name: string;
}): Promise<{ id: string; rawKey: string; keyPrefix: string }> {
  const raw = randomBytes(32).toString("hex");
  const rawKey = `ar_${raw}`;
  const keyPrefix = `ar_${raw.slice(0, 8)}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");

  const rows = await db
    .insert(apiKeys)
    .values({
      workspaceId: data.workspaceId,
      teamId: data.teamId ?? null,
      name: data.name,
      keyPrefix,
      keyHash,
    })
    .returning();
  return { id: rows[0]!.id, rawKey, keyPrefix };
}

// ---------------------------------------------------------------------------
// Device-authorization flow
// ---------------------------------------------------------------------------

/** How long a freshly-started device code stays pending before it expires. */
export const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;

const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ0123456789";

/** A short, human-typeable code like `WDJB-MJHT` (no vowels → no accidental words). */
function generateUserCode(): string {
  const pick = () => USER_CODE_ALPHABET[randomBytes(1)[0]! % USER_CODE_ALPHABET.length];
  const block = () => Array.from({ length: 4 }, pick).join("");
  return `${block()}-${block()}`;
}

export interface StartedDeviceCode {
  deviceCode: string;
  userCode: string;
  expiresAt: Date;
}

/**
 * Create a pending device-code record. `deviceCode` is an opaque random token
 * the runner polls with; `userCode` is the short code the operator approves.
 * Both are stored in plaintext (the device code is high-entropy and short-lived).
 */
export async function startDeviceCode(): Promise<StartedDeviceCode> {
  const deviceCode = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_MS);

  // Retry on the (vanishingly unlikely) user-code collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = generateUserCode();
    try {
      await db.insert(deviceCodes).values({ deviceCode, userCode, expiresAt });
      return { deviceCode, userCode, expiresAt };
    } catch (err) {
      if (attempt === 4) throw err;
    }
  }
  // Unreachable; the loop either returns or throws.
  throw new Error("failed to allocate a unique user code");
}

export type DeviceTokenResult =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "approved"; token: string; workspaceId: string };

/**
 * Exchange a `deviceCode` for the minted runner token. Returns the raw key only
 * once: the row is marked consumed atomically (the conditional UPDATE) so a
 * second poll loses the race and yields `denied`.
 *
 * - unknown / already-consumed code → `denied`
 * - past `expiresAt` (and not yet approved) → `expired`
 * - not approved yet → `pending`
 * - approved & not consumed → `approved` (the api_key is minted here and the
 *   raw key returned ONCE — approval only records intent, never the secret)
 */
export async function exchangeDeviceCode(
  deviceCode: string
): Promise<DeviceTokenResult> {
  const rows = await db
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.deviceCode, deviceCode))
    .limit(1);
  const row = rows[0];
  if (!row) return { status: "denied" };

  // Already consumed → treat as denied (single-use).
  if (row.consumedAt) return { status: "denied" };

  if (!row.approved) {
    if (row.expiresAt.getTime() <= Date.now()) return { status: "expired" };
    return { status: "pending" };
  }

  // Approved. The approving route stamped the workspace; mint the runner token
  // now (the raw secret only ever exists on this request) and claim the row so
  // only the first poll after approval wins.
  if (!row.workspaceId) return { status: "denied" };

  const claimed = await db
    .update(deviceCodes)
    .set({ consumedAt: new Date() })
    .where(
      and(eq(deviceCodes.id, row.id), sql`${deviceCodes.consumedAt} IS NULL`)
    )
    .returning({ id: deviceCodes.id });
  if (claimed.length === 0) return { status: "denied" };

  const minted = await mintApiKey({
    workspaceId: row.workspaceId,
    name: "Self-hosted runner",
  });

  // Backfill the minted key id for audit/visibility.
  await db
    .update(deviceCodes)
    .set({ apiKeyId: minted.id })
    .where(eq(deviceCodes.id, row.id));

  return {
    status: "approved",
    token: minted.rawKey,
    workspaceId: row.workspaceId,
  };
}

export type ApproveDeviceCodeResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "expired" | "already" };

/**
 * Approve a pending device code (session-authenticated path). Records approval
 * intent and stamps the operator's workspace on the matching `userCode` record.
 * The runner token (api_key) is minted lazily by {@link exchangeDeviceCode} on
 * the next poll so the raw secret is created on the request that returns it.
 */
export async function approveDeviceCode(data: {
  userCode: string;
  workspaceId: string;
}): Promise<ApproveDeviceCodeResult> {
  const normalized = data.userCode.trim().toUpperCase();
  const rows = await db
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.userCode, normalized))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.consumedAt || row.approved) return { ok: false, reason: "already" };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };

  await db
    .update(deviceCodes)
    .set({ approved: true, workspaceId: data.workspaceId })
    .where(eq(deviceCodes.id, row.id));

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Runner work-claim / result
// ---------------------------------------------------------------------------

export interface WorkItem {
  id: string;
  workspace_id: string;
  source: string;
  external_id: string;
  repo_url: string;
  ref: string;
  title: string;
  body: string;
  // The repositories row id, so the runner can link the local run's telemetry
  // (cost events, run lifecycle) back to the backend for this repo.
  repository_id: string;
}

/** Find (or create) the repositories row for a repo slug; returns its id. */
async function findOrCreateRepository(
  workspaceId: string,
  slug: string
): Promise<string> {
  const existing = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(
      and(
        eq(repositories.workspaceId, workspaceId),
        eq(repositories.name, slug)
      )
    )
    .limit(1);
  if (existing[0]) return existing[0].id;

  const inserted = await db
    .insert(repositories)
    .values({
      workspaceId,
      name: slug,
      url: repoSlugToUrl(slug),
      defaultBranch: "main",
    })
    .returning({ id: repositories.id });
  return inserted[0]!.id;
}

/** `owner/name` → `https://github.com/owner/name`; pass through full URLs. */
function repoSlugToUrl(slug: string): string {
  const trimmed = slug.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://github.com/${trimmed}`;
}

/**
 * Derive the `owner/name` slug for a claimed entry. Prefer a repo encoded on the
 * entry's `externalId` (a full issue URL or `owner/name#123`); otherwise fall
 * back to the first repo configured on the workspace's GitHub connector. "" when
 * none resolves.
 */
async function deriveRepoSlug(
  workspaceId: string,
  externalId: string
): Promise<string> {
  const urlMatch = externalId.match(/^https?:\/\/github\.com\/([^/]+\/[^/#]+)/i);
  if (urlMatch) return urlMatch[1]!;

  const slugMatch = externalId.match(/^([\w.-]+\/[\w.-]+)(?:#.*)?$/);
  if (slugMatch) return slugMatch[1]!;

  const rows = await db
    .select({ config: connectors.config })
    .from(connectors)
    .where(
      and(
        eq(connectors.workspaceId, workspaceId),
        eq(connectors.provider, "github")
      )
    )
    .limit(1);
  const cfg = rows[0]?.config as ConnectorConfig | null | undefined;
  return cfg?.repos?.[0] ?? "";
}

async function deriveRepoUrl(
  workspaceId: string,
  externalId: string
): Promise<string> {
  const slug = await deriveRepoSlug(workspaceId, externalId);
  return slug ? repoSlugToUrl(slug) : "";
}

/** The issue number for a `runs` branch/identity (trailing digits, else 0). */
function issueNumberOf(externalId: string): string {
  const m = externalId.match(/(\d+)\s*$/);
  return m ? m[1]! : "0";
}

/**
 * Atomically claim the oldest `queued` entry for a workspace, transitioning it
 * to `running`. The conditional UPDATE ... RETURNING means two concurrent
 * runners never claim the same row. Returns null when nothing is queued.
 */
export async function claimQueueEntry(
  workspaceId: string
): Promise<WorkItem | null> {
  // Single statement: select-the-oldest-queued + flip to running, atomically.
  const result = await db.execute(sql`
    UPDATE queue_entries
    SET state = 'running', updated_at = now()
    WHERE id = (
      SELECT id FROM queue_entries
      WHERE workspace_id = ${workspaceId} AND state = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, workspace_id, source, external_id, title, body
  `);

  const claimed = Array.from(result) as Array<{
    id: string;
    workspace_id: string;
    source: string;
    external_id: string;
    title: string;
    body: string;
  }>;
  const row = claimed[0];
  if (!row) return null;

  const slug = await deriveRepoSlug(workspaceId, row.external_id);
  const repoUrl = slug ? repoSlugToUrl(slug) : "";
  // Resolve a real repositories row so the local run can ingest cost/telemetry
  // against it (the dashboard joins runs/cost-events by repository_id).
  const repositoryId = slug
    ? await findOrCreateRepository(workspaceId, slug)
    : "";

  // Register a `runs` row so the dashboard shows the issue was picked up. We use
  // the queue entry id AS the run id so claim/result address the same run AND so
  // the run's ingested cost events (pushed with this run_id) join to it.
  await db
    .insert(runs)
    .values({
      id: row.id,
      workspaceId: row.workspace_id,
      repositoryId: repositoryId || slug || row.external_id,
      agent: "claude",
      runnerName: "self-hosted-runner",
      branch: `afk/github-${issueNumberOf(row.external_id)}`,
      title: row.title,
      status: "running",
      startedAt: new Date(),
      queueEntryId: row.id,
      phase: "execute",
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: runs.id,
      set: { status: "running", startedAt: new Date(), updatedAt: new Date() },
    });

  return {
    id: row.id,
    workspace_id: row.workspace_id,
    source: row.source,
    external_id: row.external_id,
    repo_url: repoUrl,
    ref: "main",
    title: row.title,
    body: row.body,
    repository_id: repositoryId,
  };
}

export type RunnerStatus = "green" | "red" | "error" | "running";

/**
 * Record a runner's result against a queue entry. Maps the runner status onto
 * the queue state-machine vocabulary (terminals: green / escalated-to-human /
 * blocked):
 *   - green  → 'green'   (terminal, done)
 *   - red    → 'queued'  (retryable: re-admit for another attempt)
 *   - error  → 'blocked' (terminal: needs intervention)
 *   - running→ 'running' (heartbeat / still in progress)
 *
 * Returns false when no entry with that id exists in the workspace.
 */
export async function recordRunnerResult(data: {
  id: string;
  workspaceId: string;
  status: RunnerStatus;
  costUsd?: number;
}): Promise<boolean> {
  // Map the outcome onto the queue state machine. The critical case is `red`:
  // it must NOT re-queue unconditionally (that loops forever, burning money and
  // opening duplicate PRs). We spend one unit of remaining_budget per red
  // attempt and, once it's exhausted, escalate to a human (terminal). green is
  // terminal; error blocks; running is a heartbeat.
  let updated = false;
  if (data.status === "red") {
    // Decrement budget; terminal `escalated-to-human` when it would hit zero,
    // else re-queue at the strong tier for another (bounded) attempt.
    const rows = await db.execute(sql`
      UPDATE queue_entries
      SET state = CASE WHEN remaining_budget <= 1 THEN 'escalated-to-human' ELSE 'queued' END,
          remaining_budget = GREATEST(remaining_budget - 1, 0),
          tier = 1,
          updated_at = now()
      WHERE id = ${data.id} AND workspace_id = ${data.workspaceId}
      RETURNING id
    `);
    updated = Array.from(rows).length > 0;
  } else {
    const nextState =
      data.status === "green"
        ? "green"
        : data.status === "error"
          ? "blocked"
          : "running";
    const rows = await db
      .update(queueEntries)
      .set({ state: nextState, updatedAt: new Date() })
      .where(
        and(
          eq(queueEntries.id, data.id),
          eq(queueEntries.workspaceId, data.workspaceId)
        )
      )
      .returning({ id: queueEntries.id });
    updated = rows.length > 0;
  }
  if (!updated) return false;

  // Mirror the outcome onto the `runs` row the dashboard shows (claim created it
  // with id = the queue entry id). green→success, red/error→failed,
  // running→running (a heartbeat). Best-effort: never fail the result on this.
  const runStatus =
    data.status === "green"
      ? "success"
      : data.status === "running"
        ? "running"
        : "failed";
  const finishedAt = data.status === "running" ? null : new Date();
  await db
    .update(runs)
    .set({
      status: runStatus,
      finishedAt,
      updatedAt: new Date(),
      ...(data.costUsd !== undefined ? { costUsd: data.costUsd } : {}),
    })
    .where(and(eq(runs.id, data.id), eq(runs.workspaceId, data.workspaceId)));

  return true;
}
