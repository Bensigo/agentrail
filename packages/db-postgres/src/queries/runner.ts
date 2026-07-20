import { eq, and, sql, inArray } from "drizzle-orm";
import { createHash, randomBytes } from "crypto";
import { db } from "../db.js";
import { deviceCodes } from "../schema/device_codes.js";
import { queueEntries } from "../schema/queue_entries.js";
import { connectors } from "../schema/connectors.js";
import type { ConnectorConfig } from "../schema/connectors.js";
import { apiKeys } from "../schema/api_keys.js";
import type { ApiKeyKind } from "../schema/api_keys.js";
import { runs } from "../schema/runs.js";
import { repositories } from "../schema/repositories.js";
import {
  unparkDependents,
  ONBOARD_EXTERNAL_ID_PREFIX,
} from "./github_intake.js";

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
 *
 * `kind` (#1267 PR ①) defaults to `'self_hosted'` — every pre-existing caller
 * (the device-flow exchange below) stays byte-stable. The hosted fleet's sync
 * endpoint is the only caller that passes `kind: 'fleet'` explicitly. A
 * concurrent second `'fleet'` mint for the SAME workspace violates
 * `api_keys_one_active_fleet_key_idx` (migration 0033) — the caller must
 * catch that unique-violation itself; this function does not.
 */
export async function mintApiKey(data: {
  workspaceId: string;
  teamId?: string | null;
  name: string;
  kind?: ApiKeyKind;
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
      kind: data.kind ?? "self_hosted",
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
  // What kind of work this claim is: 'issue' (default — run the SDLC spine) or
  // 'onboard' (index a freshly connected repo and seed workspace memory). The
  // runner dispatches on it; older runners that don't read it keep running the
  // issue path unchanged.
  kind: string;
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
  // #1275: the alignment brief's confirmed per-issue $ ceiling (owner rule:
  // "confirming the brief = sanctioning the ceiling"). The runner passes this
  // straight through as `--budget-usd <value> --budget-source brief`, which
  // wins over every other budget tier (see
  // agentrail.cli.commands.run.effective_budget). Null when no brief has
  // priced this entry yet — true for every entry today; #1274's
  // brief-generation lane is what starts writing a value here.
  estimated_budget_usd: number | null;
  // #1275: the coding-phase model chosen when confirming the alignment
  // brief. Null when no brief/no override (true for every entry today).
  // CONTROLLER-DECIDED precedence (see _make_execute in
  // agentrail/cli/commands/runner.py): a tier >= 1 escalation always wins
  // over this value — a re-queued failing attempt escalates as designed
  // (#890), it does not keep re-running a user's pick that already failed.
  model_override: string | null;
}

/**
 * Defensively coerce a raw SQL `numeric` column value to a JS number, or
 * `null`. A manual `RETURNING` clause (this file does not use Drizzle's typed
 * query builder for `claimQueueEntry`) hands back whatever the driver returns
 * for `numeric` — typically a string, to avoid float-precision surprises — so
 * this must parse it explicitly; unlike `tier` elsewhere in this file, a
 * missing/malformed value falls back to `null` (a MEANINGFUL "no estimate"),
 * never to `0` (a real, if unusual, $0 estimate), and a value that fails to
 * parse to a finite number is never forwarded as `NaN` on the wire.
 */
function parseNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
  // Onboard entries encode their repo as `onboard:owner/name` (no issue number,
  // shared ONBOARD_EXTERNAL_ID_PREFIX — the writer's own constant, so this
  // reader can never drift from what enqueueOnboard actually writes).
  // Strip the prefix so the slug match below resolves the repo from the entry
  // itself; otherwise the colon fails both patterns and we'd fall back to the
  // workspace's first configured repo — onboarding the wrong repo on a
  // multi-repo workspace (#1149).
  const id = externalId.startsWith(ONBOARD_EXTERNAL_ID_PREFIX)
    ? externalId.slice(ONBOARD_EXTERNAL_ID_PREFIX.length)
    : externalId;

  const urlMatch = id.match(/^https?:\/\/github\.com\/([^/]+\/[^/#]+)/i);
  if (urlMatch) return urlMatch[1]!;

  const slugMatch = id.match(/^([\w.-]+\/[\w.-]+)(?:#.*)?$/);
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

/** A run resolved for a specific issue — the shape a reply-context preface needs. */
export interface LatestRunForIssue {
  runId: string;
  state: string;
}

/**
 * Resolve the most recently created run for a workspace's issue number
 * (#1277 — replyable run-outcome threads: a human replies to a run-outcome
 * ping, and the reply's parsed issue number needs a run_id to hand triage).
 *
 * Joins `runs` back to its `queue_entries` row via `runs.queueEntryId` and
 * matches `external_id` on an EXACT `#<issueNumber>` suffix. `LIKE '%#10'`
 * (a leading wildcard, NO trailing one) is anchored to the very end of the
 * string — Postgres LIKE requires the match to terminate exactly where the
 * pattern does — so issue 10 can never match a stored `owner/repo#101` (whose
 * last three characters are "101", not "#10"). `issueNumber` is always a
 * validated positive integer by the time it reaches here (see
 * `outcome-format.ts`'s `parseOutcomeIssueNumber`), so the interpolated
 * pattern can never carry a stray `%`/`_` LIKE metacharacter.
 *
 * "Latest" = newest `runs.createdAt`. Today this is at most ONE row per
 * issue: `claimQueueEntry` upserts the `runs` row keyed by the queue entry
 * id (`onConflictDoUpdate`), so retries reuse the same row rather than
 * accumulating history. The ORDER BY/LIMIT is future-proofing for a
 * multi-run-per-entry world, not a description of current data.
 *
 * WORKSPACE-SCOPED on both sides of the join (defense in depth) — the only
 * caller (`apps/console/lib/channel-dispatch.ts`'s reply-context injection)
 * passes the conversation's own SERVER-RESOLVED workspace, never anything
 * read out of a message. See that file's threat-model note.
 */
export async function latestRunForIssue(
  workspaceId: string,
  issueNumber: number
): Promise<LatestRunForIssue | null> {
  const rows = await db
    .select({ runId: runs.id, state: runs.status })
    .from(runs)
    .innerJoin(queueEntries, eq(runs.queueEntryId, queueEntries.id))
    .where(
      and(
        eq(runs.workspaceId, workspaceId),
        eq(queueEntries.workspaceId, workspaceId),
        sql`${queueEntries.externalId} LIKE ${`%#${issueNumber}`}`
      )
    )
    .orderBy(sql`${runs.createdAt} DESC`)
    .limit(1);
  const row = rows[0];
  return row ? { runId: row.runId, state: row.state } : null;
}

/** A durable queue entry as the console queue view consumes it. */
export interface QueueEntryListItem {
  id: string;
  externalId: string;
  title: string;
  tier: number;
  remainingBudget: number;
  state: string;
  /** Issue numbers this entry is blocked by (parked while any is unmet). */
  blockedBy: number[];
  /** Human-readable reason the entry is CURRENTLY parked (issue #1239): a
   * guardrail park (duplicate content / rate limit / injection screen) or a
   * dependency park ("Waiting on #12, #14"). Null when not parked, or for a
   * legacy/reasonless row — `formatParkReason` in the console falls back to
   * formatting `blockedBy` in that case. */
  parkReason: string | null;
  /** 'issue' | 'onboard' — see the schema's `kind` column. Added (#1276 fix
   * round) with `estimatedBudgetUsd` so the approvals page can compute the
   * SAME "alignment-held" predicate `requeueParkedQueueEntry` enforces
   * server-side, instead of guessing from `parkReason` strings. */
  kind: string;
  /** The alignment brief's confirmed ceiling (#1275); null until a brief is
   * confirmed. Non-null IS the "aligned" marker — see `unparkDependents`. */
  estimatedBudgetUsd: number | null;
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
 *
 * `states`, when given, overrides `activeOnly` and returns only entries in
 * that exact set (e.g. the Home digest wants queued/running for "in progress"
 * and escalated-to-human/parked for "needs you" — a targeted filter instead
 * of pulling the entire history and filtering client-side).
 */
export async function listQueueEntries(
  workspaceId: string,
  opts: { activeOnly?: boolean; states?: string[] } = {}
): Promise<QueueEntryListItem[]> {
  const activeOnly = opts.activeOnly ?? true;
  const whereClause =
    opts.states && opts.states.length > 0
      ? and(eq(queueEntries.workspaceId, workspaceId), inArray(queueEntries.state, opts.states))
      : activeOnly
        ? and(
            eq(queueEntries.workspaceId, workspaceId),
            sql`${queueEntries.state} IN (${sql.join(
              ACTIVE_QUEUE_STATES.map((s) => sql`${s}`),
              sql`, `
            )})`
          )
        : eq(queueEntries.workspaceId, workspaceId);

  const rows = await db
    .select({
      id: queueEntries.id,
      externalId: queueEntries.externalId,
      title: queueEntries.title,
      tier: queueEntries.tier,
      remainingBudget: queueEntries.remainingBudget,
      state: queueEntries.state,
      blockedBy: queueEntries.blockedBy,
      parkReason: queueEntries.parkReason,
      kind: queueEntries.kind,
      estimatedBudgetUsd: queueEntries.estimatedBudgetUsd,
      updatedAt: queueEntries.updatedAt,
    })
    .from(queueEntries)
    .where(whereClause)
    .orderBy(sql`${queueEntries.updatedAt} DESC`);

  return rows.map((r) => ({
    id: r.id,
    externalId: r.externalId,
    title: r.title,
    tier: r.tier,
    remainingBudget: r.remainingBudget,
    state: r.state,
    blockedBy: (r.blockedBy ?? []) as number[],
    parkReason: r.parkReason ?? null,
    kind: r.kind,
    estimatedBudgetUsd: r.estimatedBudgetUsd ?? null,
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
    RETURNING id, workspace_id, source, kind, external_id, title, body, tier,
              estimated_budget_usd, model_override
  `);

  const claimed = Array.from(result) as Array<{
    id: string;
    workspace_id: string;
    source: string;
    kind: string;
    external_id: string;
    title: string;
    body: string;
    tier: number;
    // Raw driver value for a `numeric` column — string (or null) in practice;
    // typed loosely here since parseNullableNumber accepts any input.
    estimated_budget_usd: unknown;
    model_override: string | null;
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
    // Default to 'issue' when the column is absent/null so a row written before
    // this migration (or by an older path) still dispatches down the issue spine.
    kind: row.kind || "issue",
    external_id: row.external_id,
    repo_url: repoUrl,
    ref: "main",
    title: row.title,
    body: row.body,
    repository_id: repositoryId,
    // Coerce to a number; a malformed/absent column must never become NaN on
    // the wire (the runner defaults to tier 0 = config model when it can't read it).
    tier: Number(row.tier) || 0,
    // #1275: dormant — null on every entry until #1274's brief-generation
    // lane starts writing values. See parseNullableNumber's own doc-comment
    // for why this defaults to null (not 0) on a malformed/absent value.
    estimated_budget_usd: parseNullableNumber(row.estimated_budget_usd),
    model_override: row.model_override || null,
  };
}

export type RunnerStatus = "green" | "red" | "error" | "running";

/** The maximum escalation tier. The runner's model map is bounded to this, so
 * bumping tier past it is pointless — we cap so the map stays small/deterministic. */
export const MAX_TIER = 2;

/**
 * #1267 PR③: the deterministic prefix a hosted-refusal `gate_reason` always
 * starts with. This is the cross-process CONTRACT the Python sandbox side
 * defines (agentrail/sandbox/native_runner.py's byte-identical
 * `HOSTED_REFUSAL_PREFIX` constant) when it recognizes a hosted run's startup
 * refusal (no Independent Reviewer configured, #1270) — a static per-repo
 * config gap that no retry or stronger model can fix. Keep the two constants
 * in lockstep if you ever change one; a mismatch silently turns every refusal
 * back into an ordinary retried gate failure.
 */
export const HOSTED_REFUSAL_PREFIX = "hosted-refusal: ";

/** Is this `error` outcome a hosted startup refusal, per the shared prefix
 * contract? `gateReason` is optional (additive — most callers don't pass it
 * yet, see recordRunnerResult's route caller), so absence is simply "no". */
function isHostedRefusal(status: RunnerStatus, gateReason?: string): boolean {
  return status === "error" && !!gateReason && gateReason.startsWith(HOSTED_REFUSAL_PREFIX);
}

/**
 * The PURE result→queue-transition decision, extracted so it is unit-testable
 * without a live Postgres. Given the current `remainingBudget`/`tier` and the
 * runner `status`, returns the next durable `state` plus the new budget/tier.
 *
 * Semantics:
 *   - green   → terminal 'green' (budget/tier unchanged).
 *   - running → 'running' heartbeat (budget/tier unchanged).
 *   - hosted refusal (error whose gateReason carries HOSTED_REFUSAL_PREFIX,
 *     #1267 PR③) → terminal 'escalated-to-human' IMMEDIATELY, budget/tier
 *     UNCHANGED: a startup refusal is a static config gap, not a transient or
 *     fixable-by-a-stronger-model failure, so retrying it (let alone 5 times)
 *     only delays the human who actually needs to act.
 *   - red OR error (ordinary) → a non-green outcome is retryable AND bounded:
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
  /** The runner's reported gate_reason (#1267 PR③, additive — optional so
   * every existing caller that never passed it keeps byte-identical
   * behavior). Only consulted to detect a hosted-refusal `error`. */
  gateReason?: string;
}): { state: string; remainingBudget: number; tier: number } {
  const { status, remainingBudget, tier, gateReason } = input;
  if (status === "green") {
    return { state: "green", remainingBudget, tier };
  }
  if (status === "running") {
    return { state: "running", remainingBudget, tier };
  }
  if (isHostedRefusal(status, gateReason)) {
    // Jump straight to a human — spend NEITHER budget nor tier (#1267 PR③).
    return { state: "escalated-to-human", remainingBudget, tier };
  }
  // red OR error (ordinary): retryable + bounded. Spend one unit of budget;
  // escalate to a human when this attempt exhausts it.
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
 * Returns `{ updated, terminalState, externalId }`:
 *   - `updated`      — false when no entry with that id exists in the workspace.
 *   - `terminalState`— the resulting state IFF it is a terminal (green /
 *     escalated-to-human / blocked), else null. A red/error that merely re-queues
 *     (budget not yet exhausted) and a running heartbeat both yield null. This is
 *     what the result route keys notify on: notify ONLY fires on a terminal, so a
 *     retry never spams the gateway (#888). Derived from the state the atomic
 *     UPDATE actually committed (read back via RETURNING), so it can never
 *     disagree with what was persisted.
 *   - `externalId`   — the entry's external id (e.g. the issue URL/slug#n); the
 *     route parses the issue number from it for the message. "" when not updated.
 */
export type TerminalQueueState = "green" | "escalated-to-human" | "blocked";

/** The terminal (queue-leaving) states.
 *
 * NOTE: `recordRunnerResult` itself only ever commits `green` or
 * `escalated-to-human` (post-#910 an `error` re-queues; it no longer blocks), so
 * a notify from THIS path fires for those two. `blocked` is included for
 * forward-compatibility — it is a real queue terminal other paths may set — so a
 * future blocked outcome notifies through the same hook without a code change. */
const TERMINAL_QUEUE_STATES: readonly string[] = [
  "green",
  "escalated-to-human",
  "blocked",
];

export interface RecordRunnerResult {
  updated: boolean;
  terminalState: TerminalQueueState | null;
  externalId: string;
  /** #1338 PR①: the queue entry's `task_type` (denormalized at brief-confirm
   * time — see `github_intake.ts::confirmAlignmentBrief`/`enqueueGithubIssue`),
   * read back from the SAME UPDATE...RETURNING this function already runs —
   * no extra query. Null for a brief-less entry. The caller (the
   * runner-result route) threads this straight into
   * `run_outcomes.ts::recordRunOutcome` on a terminal transition; it is
   * inert (never read) otherwise. */
  taskType: string | null;
}

export async function recordRunnerResult(data: {
  id: string;
  workspaceId: string;
  status: RunnerStatus;
  costUsd?: number;
  prUrl?: string;
  /** The runner's reported gate_reason (#1267 PR③, additive/optional — see
   * {@link nextQueueTransition}). Only a hosted-refusal `error` (prefixed with
   * {@link HOSTED_REFUSAL_PREFIX}) changes behavior; every other value
   * (including undefined) keeps the pre-existing red/error handling. When it
   * IS a hosted refusal, this message is also persisted onto the queue row's
   * `park_reason` (§ below) so an operator sees WHY without a new column. */
  gateReason?: string;
}): Promise<RecordRunnerResult> {
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
  // The state the UPDATE actually committed (RETURNING), so terminalState can
  // never disagree with what was persisted. For red/error this is `queued` on a
  // retry and `escalated-to-human` once budget is exhausted; for green/running it
  // is the state we set directly.
  let resultingState = "";
  // #1338 PR①: the entry's task_type, read back from the SAME RETURNING
  // clause as state/external_id (no second query) so recordRunOutcome's
  // caller has it for free on a terminal transition.
  let resultingTaskType: string | null = null;
  if (data.status === "red" || data.status === "error") {
    if (isHostedRefusal(data.status, data.gateReason)) {
      // Hosted refusal (#1267 PR③): jump straight to escalated-to-human,
      // spending NEITHER remaining_budget NOR tier — lockstep with
      // nextQueueTransition's hosted-refusal branch above. The message rides
      // `park_reason` — the one existing free-text per-row reason column
      // (today scoped by convention to `parked`; reused here rather than
      // inventing a new column, since `escalated-to-human` is equally "sitting
      // here, needs a human" — see queue_entries.ts's parkReason doc comment).
      const rows = Array.from(
        await db.execute(sql`
        UPDATE queue_entries
        SET state = 'escalated-to-human',
            park_reason = ${data.gateReason ?? null},
            updated_at = now()
        WHERE id = ${data.id} AND workspace_id = ${data.workspaceId}
        RETURNING id, state, external_id, task_type
      `)
      ) as Array<{ id: string; state: string; external_id: string; task_type: string | null }>;
      updated = rows.length > 0;
      if (updated) {
        resultingState = rows[0]!.state;
        completedExternalId = rows[0]!.external_id;
        resultingTaskType = rows[0]!.task_type ?? null;
      }
    } else {
      // Single conditional UPDATE so two concurrent results never double-decrement.
      // tier bumps only for red (mirrors nextQueueTransition's status==='red').
      const tierExpr =
        data.status === "red" ? sql`LEAST(tier + 1, ${MAX_TIER})` : sql`tier`;
      const rows = Array.from(
        await db.execute(sql`
        UPDATE queue_entries
        SET state = CASE WHEN remaining_budget <= 1 THEN 'escalated-to-human' ELSE 'queued' END,
            remaining_budget = GREATEST(remaining_budget - 1, 0),
            tier = ${tierExpr},
            updated_at = now()
        WHERE id = ${data.id} AND workspace_id = ${data.workspaceId}
        RETURNING id, state, external_id, task_type
      `)
      ) as Array<{ id: string; state: string; external_id: string; task_type: string | null }>;
      updated = rows.length > 0;
      if (updated) {
        resultingState = rows[0]!.state;
        completedExternalId = rows[0]!.external_id;
        resultingTaskType = rows[0]!.task_type ?? null;
      }
    }
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
      .returning({
        id: queueEntries.id,
        state: queueEntries.state,
        externalId: queueEntries.externalId,
        taskType: queueEntries.taskType,
      });
    updated = rows.length > 0;
    if (updated) {
      resultingState = rows[0]!.state;
      completedExternalId = rows[0]!.externalId;
      resultingTaskType = rows[0]!.taskType ?? null;
    }
  }
  if (!updated) {
    return { updated: false, terminalState: null, externalId: "", taskType: null };
  }

  // Notify ONLY on a terminal: a red/error that re-queued committed `queued`
  // (non-terminal) so terminalState stays null and the route never notifies on a
  // retry; an exhausted-budget escalation committed `escalated-to-human`
  // (terminal). green is terminal; running is a heartbeat (non-terminal). The
  // value is read back from the actual committed state, not re-derived.
  const terminalState: TerminalQueueState | null =
    TERMINAL_QUEUE_STATES.includes(resultingState)
      ? (resultingState as TerminalQueueState)
      : null;

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

  return {
    updated: true,
    terminalState,
    externalId: completedExternalId,
    taskType: resultingTaskType,
  };
}
