import { eq, and, sql } from "drizzle-orm";
import { createHash, randomBytes } from "crypto";
import { db } from "../db.js";
import { deviceCodes } from "../schema/device_codes.js";
import { queueEntries } from "../schema/queue_entries.js";
import { connectors } from "../schema/connectors.js";
import type { ConnectorConfig } from "../schema/connectors.js";
import { apiKeys } from "../schema/api_keys.js";

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
}

/** `owner/name` → `https://github.com/owner/name`; pass through full URLs. */
function repoSlugToUrl(slug: string): string {
  const trimmed = slug.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://github.com/${trimmed}`;
}

/**
 * Derive the repo URL for a claimed work item. Prefer a repo encoded on the
 * entry's `externalId` (e.g. `owner/name#123` or a full issue URL); otherwise
 * fall back to the first repo configured on the workspace's GitHub connector.
 */
async function deriveRepoUrl(
  workspaceId: string,
  externalId: string
): Promise<string> {
  // A full GitHub URL on the externalId → strip to the repo root.
  const urlMatch = externalId.match(
    /^https?:\/\/github\.com\/([^/]+\/[^/#]+)/i
  );
  if (urlMatch) return repoSlugToUrl(urlMatch[1]!);

  // `owner/name#123` or `owner/name` form.
  const slugMatch = externalId.match(/^([\w.-]+\/[\w.-]+)(?:#.*)?$/);
  if (slugMatch) return repoSlugToUrl(slugMatch[1]!);

  // Fall back to the GitHub connector config.
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
  const repo = cfg?.repos?.[0];
  return repo ? repoSlugToUrl(repo) : "";
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

  const repoUrl = await deriveRepoUrl(workspaceId, row.external_id);

  return {
    id: row.id,
    workspace_id: row.workspace_id,
    source: row.source,
    external_id: row.external_id,
    repo_url: repoUrl,
    ref: "main",
    title: row.title,
    body: row.body,
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
}): Promise<boolean> {
  const nextState =
    data.status === "green"
      ? "green"
      : data.status === "red"
        ? "queued"
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
  return rows.length > 0;
}
