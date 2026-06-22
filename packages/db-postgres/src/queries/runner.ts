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
import { unparkDependents } from "./github_intake.js";

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
  // The escalation tier (0 = cheap/config-default, 1+ = stronger model). The
  // runner maps this to a model override so a re-queued (previously red/error)
  // attempt actually escalates instead of re-running at the same failing model.
  tier: number;
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

/** Runs older than this with no terminal status are considered dead/abandoned. */
export const STALE_RUN_MINUTES = 90;

/**
 * Mark runs stuck in `running` past {@link STALE_RUN_MINUTES} as `failed`. A
 * killed or crashed runner never reports a result, so without this the run shows
 * `running` forever on the dashboard. Called on every claim so the sweep is
 * automatic. The threshold sits above the run timeout (1h) so a legitimately
 * long run is never reaped. Returns the number reconciled.
 */
export async function reconcileStaleRuns(workspaceId: string): Promise<number> {
  const rows = await db.execute(sql`
    UPDATE runs
    SET status = 'failed', finished_at = now(), updated_at = now()
    WHERE workspace_id = ${workspaceId}
      AND status = 'running'
      AND started_at < now() - (${STALE_RUN_MINUTES} || ' minutes')::interval
    RETURNING id
  `);

  // Mirror the sweep onto the durable queue: a queue entry stuck in `running`
  // past the threshold (its runner died mid-flight) would otherwise sit in the
  // active queue forever. Re-admit it as `queued` so it gets another attempt
  // rather than masquerading as in-progress. `updated_at` gates the staleness so
  // a fresh claim is never reaped.
  await db.execute(sql`
    UPDATE queue_entries
    SET state = 'queued', updated_at = now()
    WHERE workspace_id = ${workspaceId}
      AND state = 'running'
      AND updated_at < now() - (${STALE_RUN_MINUTES} || ' minutes')::interval
  `);

  return Array.from(rows).length;
}

/** A durable queue entry as the console queue view consumes it. */
export interface QueueEntryListItem {
  id: string;
  externalId: string;
  title: string;
  tier: number;
  remainingBudget: number;
  state: string;
  updatedAt: string;
}

/** Non-terminal states — an issue still in the queue (terminals have left). */
const ACTIVE_QUEUE_STATES = ["queued", "parked", "running"] as const;

/**
 * List durable `queue_entries` for a workspace, newest activity first. This is
 * the authoritative queue the runner claims from — unlike the legacy runs
 * projection, it never shows phantom-queued or already-finished issues.
 *
 * `activeOnly` (default true) returns only non-terminal entries, so the queue
 * surface self-flushes: an entry leaves the moment it reaches a terminal
 * (green / escalated-to-human / blocked). Pass false to include history.
 */
export async function listQueueEntries(
  workspaceId: string,
  opts: { activeOnly?: boolean } = {}
): Promise<QueueEntryListItem[]> {
  const activeOnly = opts.activeOnly ?? true;
  const rows = await db
    .select({
      id: queueEntries.id,
      externalId: queueEntries.externalId,
      title: queueEntries.title,
      tier: queueEntries.tier,
      remainingBudget: queueEntries.remainingBudget,
      state: queueEntries.state,
      updatedAt: queueEntries.updatedAt,
    })
    .from(queueEntries)
    .where(
      activeOnly
        ? and(
            eq(queueEntries.workspaceId, workspaceId),
            sql`${queueEntries.state} IN (${sql.join(
              ACTIVE_QUEUE_STATES.map((s) => sql`${s}`),
              sql`, `
            )})`
          )
        : eq(queueEntries.workspaceId, workspaceId)
    )
    .orderBy(sql`${queueEntries.updatedAt} DESC`);

  return rows.map((r) => ({
    id: r.id,
    externalId: r.externalId,
    title: r.title,
    tier: r.tier,
    remainingBudget: r.remainingBudget,
    state: r.state,
    updatedAt:
      r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
  }));
}

/**
 * Atomically claim the oldest `queued` entry for a workspace, transitioning it
 * to `running`. The conditional UPDATE ... RETURNING means two concurrent
 * runners never claim the same row. Returns null when nothing is queued.
 */
export async function claimQueueEntry(
  workspaceId: string
): Promise<WorkItem | null> {
  // Sweep dead runs first so the dashboard never shows a killed run as running.
  try {
    await reconcileStaleRuns(workspaceId);
  } catch {
    // best-effort — never fail a claim on reconciliation
  }
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
    RETURNING id, workspace_id, source, external_id, title, body, tier
  `);

  const claimed = Array.from(result) as Array<{
    id: string;
    workspace_id: string;
    source: string;
    external_id: string;
    title: string;
    body: string;
    tier: number;
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
    // Coerce to a number; a malformed/absent column must never become NaN on
    // the wire (the runner defaults to tier 0 = config model when it can't read it).
    tier: Number(row.tier) || 0,
  };
}

export type RunnerStatus = "green" | "red" | "error" | "running";

/** The maximum escalation tier. The runner's model map is bounded to this, so
 * bumping tier past it is pointless — we cap so the map stays small/deterministic. */
export const MAX_TIER = 2;

/**
 * The PURE result→queue-transition decision, extracted so it is unit-testable
 * without a live Postgres. Given the current `remainingBudget`/`tier` and the
 * runner `status`, returns the next durable `state` plus the new budget/tier.
 *
 * Semantics:
 *   - green   → terminal 'green' (budget/tier unchanged).
 *   - running → 'running' heartbeat (budget/tier unchanged).
 *   - red OR error → a non-green outcome is retryable AND bounded:
 *       spend one unit of budget and re-admit as 'queued'. When the budget would
 *       be exhausted (<= 1 remaining before this attempt), transition to the
 *       terminal 'escalated-to-human' instead of looping forever.
 *       tier (the model-escalation level) is bumped ONLY for `red`: a gate
 *       failure may be fixable by a stronger model. An `error` is an infra/
 *       timeout failure that a bigger, slower model would not fix (and on a
 *       timeout would make worse), so error retries at the SAME tier.
 *
 * The "max N attempts" bound is governed by the initial `remainingBudget` the
 * enqueue path seeds (see github_intake.ts / the queue_entries default).
 */
export function nextQueueTransition(input: {
  status: RunnerStatus;
  remainingBudget: number;
  tier: number;
}): { state: string; remainingBudget: number; tier: number } {
  const { status, remainingBudget, tier } = input;
  if (status === "green") {
    return { state: "green", remainingBudget, tier };
  }
  if (status === "running") {
    return { state: "running", remainingBudget, tier };
  }
  // red OR error: retryable + bounded. Spend one unit of budget; escalate to a
  // human when this attempt exhausts it.
  const nextBudget = Math.max(remainingBudget - 1, 0);
  // Model escalation (tier bump) is for gate failures only — a stronger model
  // can't fix an infra/timeout error, so `error` retries at the same tier.
  const nextTier = status === "red" ? Math.min(tier + 1, MAX_TIER) : tier;
  const state = remainingBudget <= 1 ? "escalated-to-human" : "queued";
  return { state, remainingBudget: nextBudget, tier: nextTier };
}

/**
 * Record a runner's result against a queue entry. Maps the runner status onto
 * the queue state-machine vocabulary via the pure {@link nextQueueTransition}
 * (terminals: green / escalated-to-human):
 *   - green   → 'green'              (terminal, done)
 *   - red     → 'queued' (bounded)   (retryable: spend budget, bump tier, re-admit)
 *   - error   → 'queued' (bounded)   (transient errors are retryable too, #890)
 *   - running → 'running'            (heartbeat / still in progress)
 *
 * red/error both decrement remaining_budget and re-admit; once the budget is
 * exhausted they transition to terminal 'escalated-to-human'. tier (the model
 * escalation level) is bumped for `red` only — see {@link nextQueueTransition}.
 *
 * Returns false when no entry with that id exists in the workspace.
 */
export async function recordRunnerResult(data: {
  id: string;
  workspaceId: string;
  status: RunnerStatus;
  costUsd?: number;
  prUrl?: string;
}): Promise<boolean> {
  // Map the outcome onto the queue state machine. The critical cases are `red`
  // AND `error` (#890): a non-green outcome must NOT re-queue unconditionally
  // (that loops forever, burning money and opening duplicate PRs) and must NOT
  // terminally block on a transient error. Both spend one unit of
  // remaining_budget and re-admit; once the budget is exhausted they escalate to
  // a human (terminal). tier (model escalation) is bumped for `red` only — a
  // stronger model can't fix an infra/timeout error. green is terminal; running
  // is a heartbeat. This SQL MUST stay in lockstep with nextQueueTransition
  // (the unit-tested spec); the DB integration test guards their equivalence.
  let updated = false;
  let completedExternalId = "";
  if (data.status === "red" || data.status === "error") {
    // Single conditional UPDATE so two concurrent results never double-decrement.
    // tier bumps only for red (mirrors nextQueueTransition's status==='red').
    const tierExpr =
      data.status === "red" ? sql`LEAST(tier + 1, ${MAX_TIER})` : sql`tier`;
    const rows = await db.execute(sql`
      UPDATE queue_entries
      SET state = CASE WHEN remaining_budget <= 1 THEN 'escalated-to-human' ELSE 'queued' END,
          remaining_budget = GREATEST(remaining_budget - 1, 0),
          tier = ${tierExpr},
          updated_at = now()
      WHERE id = ${data.id} AND workspace_id = ${data.workspaceId}
      RETURNING id
    `);
    updated = Array.from(rows).length > 0;
  } else {
    const { state: nextState } = nextQueueTransition({
      status: data.status,
      // budget/tier are unchanged for green/running so any value is inert here.
      remainingBudget: 0,
      tier: 0,
    });
    const rows = await db
      .update(queueEntries)
      .set({ state: nextState, updatedAt: new Date() })
      .where(
        and(
          eq(queueEntries.id, data.id),
          eq(queueEntries.workspaceId, data.workspaceId)
        )
      )
      .returning({ id: queueEntries.id, externalId: queueEntries.externalId });
    updated = rows.length > 0;
    if (updated) completedExternalId = rows[0]!.externalId;
  }
  if (!updated) return false;

  // Dependency awareness: a green entry may release parked dependents that were
  // blocked on it. Best-effort — never fail the result on this.
  if (data.status === "green" && completedExternalId) {
    try {
      await unparkDependents(data.workspaceId, completedExternalId);
    } catch {
      // non-fatal
    }
  }

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
      // Persist the PR the run opened (#891a) so the dashboard can surface it
      // and (#891b) reconcile status against the PR's real CI. Only overwrite
      // with a non-empty value — a later heartbeat with no PR must not clear it.
      ...(data.prUrl ? { prUrl: data.prUrl } : {}),
    })
    .where(and(eq(runs.id, data.id), eq(runs.workspaceId, data.workspaceId)));

  return true;
}
