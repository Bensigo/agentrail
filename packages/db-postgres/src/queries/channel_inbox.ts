import { sql } from "drizzle-orm";
import { db } from "../db.js";
import type { ChannelInboxState } from "../schema/channel_inbox.js";

/**
 * Channel inbox queries — the async ingest buffer between channel webhooks and
 * the Jace dispatcher worker (spec §4; see `schema/channel_inbox.ts` for the
 * table shape and the WHY behind the design).
 *
 * Two concurrency guarantees live here, both enforced by the claim query
 * (`claimNextChannelMessage`), not by application-level locking:
 *
 *  1. Per-conversation serialization — a worker never claims a row for a
 *     conversation that already has another row `processing`, so turns in the
 *     same chat thread are strictly ordered even with multiple workers.
 *  2. Per-workspace fairness — an inflight cap prevents one noisy workspace
 *     from starving every other workspace's claims.
 *
 * `pg_try_advisory_xact_lock` additionally serializes the *claim decision*
 * itself per conversation, closing a race where two workers pass the
 * NOT EXISTS check for the same conversation in the same instant.
 */

// --- bounded retry with backoff (pure — NEVER touches the db) -----------------

/** After this many failed attempts, a row is moved to `dead` instead of retried. */
export const INBOX_MAX_ATTEMPTS = 3;

/**
 * Backoff delay (seconds) indexed by `attempts - 1` for the retry that follows
 * that attempt. Only the first `INBOX_MAX_ATTEMPTS - 1` entries are ever read
 * in practice (the MAX'th failure goes straight to `dead`); the trailing entry
 * is kept so raising `INBOX_MAX_ATTEMPTS` later doesn't require also editing
 * this table.
 */
export const INBOX_BACKOFF_SECONDS = [30, 120, 600] as const;

/** A `processing` row idle longer than this is presumed crashed and reclaimed. */
export const INBOX_STALE_PROCESSING_MINUTES = 15;

export type InboxRetryDecision =
  | { state: "queued"; delaySeconds: number }
  | { state: "dead"; delaySeconds: 0 };

/**
 * Decide what happens to a channel_inbox row after a processing failure.
 *
 * PURE — the single unit-tested decision point for the retry policy; it must
 * never import or touch `db`. `attempts` is the count AFTER the failure being
 * handled is recorded. Requeues with the corresponding backoff step while
 * `attempts < INBOX_MAX_ATTEMPTS`; at `INBOX_MAX_ATTEMPTS` the row goes `dead`
 * so a permanently-broken message can't loop forever occupying a worker slot.
 */
export function nextInboxStateAfterFailure(
  attempts: number
): InboxRetryDecision {
  if (attempts >= INBOX_MAX_ATTEMPTS) {
    return { state: "dead", delaySeconds: 0 };
  }
  const delaySeconds = INBOX_BACKOFF_SECONDS[attempts - 1] ?? INBOX_BACKOFF_SECONDS[0];
  return { state: "queued", delaySeconds };
}

// --- enqueue (webhook side) ----------------------------------------------------

export interface EnqueueChannelMessageInput {
  workspaceId?: string;
  chatIdentityId?: string;
  channel: string;
  conversationKey: string;
  kind?: "message" | "approval_response";
  senderId?: string;
  senderDisplay?: string;
  providerMessageId: string;
  payload: Record<string, unknown>;
}

export interface EnqueueChannelMessageResult {
  id: string | null;
  deduped: boolean;
}

/**
 * Insert an inbound channel message into the buffer.
 *
 * Idempotent on (channel, provider_message_id): a provider redelivery (e.g. a
 * Telegram retry after a slow ACK) hits ON CONFLICT DO NOTHING and returns
 * `deduped: true` with no second row and no double-processing. Webhook routes
 * should do exactly this, verify-secret, and return 200 — nothing else.
 *
 * The anchor is EITHER `workspaceId` (a known sender) OR `chatIdentityId` (a
 * pre-workspace "intro" row from the shared-bot door, issue #1262 — see
 * `schema/channel_inbox.ts`'s doc-comment). Both are optional in the input
 * type so a caller can pass whichever it resolved, but at least one is
 * required — the table's CHECK constraint enforces this in the DB too, so
 * this throws before the INSERT rather than letting Postgres reject it.
 */
export async function enqueueChannelMessage(
  input: EnqueueChannelMessageInput
): Promise<EnqueueChannelMessageResult> {
  if (!input.workspaceId && !input.chatIdentityId) {
    throw new Error(
      "enqueueChannelMessage: requires either workspaceId or chatIdentityId"
    );
  }
  const rows = (await db.execute(sql`
    INSERT INTO channel_inbox (
      workspace_id, chat_identity_id, channel, conversation_key, kind,
      sender_id, sender_display, provider_message_id, payload
    ) VALUES (
      ${input.workspaceId ?? null}, ${input.chatIdentityId ?? null}, ${input.channel}, ${input.conversationKey}, ${input.kind ?? "message"},
      ${input.senderId ?? ""}, ${input.senderDisplay ?? ""}, ${input.providerMessageId}, ${JSON.stringify(input.payload)}::jsonb
    )
    ON CONFLICT (channel, provider_message_id) DO NOTHING
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const row = Array.from(rows)[0];
  return row ? { id: row.id, deduped: false } : { id: null, deduped: true };
}

// --- claim (worker side) -------------------------------------------------------

/** Normalized (camelCase) shape of a claimed row — see `db.execute` note below. */
export interface ClaimedChannelInboxRow {
  id: string;
  workspaceId: string;
  channel: string;
  conversationKey: string;
  kind: string;
  senderId: string;
  senderDisplay: string;
  providerMessageId: string;
  payload: unknown;
  state: ChannelInboxState;
  attempts: number;
  createdAt: Date;
}

export interface ClaimNextChannelMessageOptions {
  /** Max rows a single workspace may hold `processing` at once (fairness cap). */
  workspaceInflightLimit?: number;
}

const DEFAULT_WORKSPACE_INFLIGHT_LIMIT = 3;

/**
 * Atomically claim the next queued, due message for processing.
 *
 * Uses `FOR UPDATE SKIP LOCKED` so concurrent workers never block on or double
 * -claim the same row. Three predicates keep the claim safe and fair:
 *
 *  - `state = 'queued' AND next_attempt_at <= now()` — only due work.
 *  - `NOT EXISTS (... same conversation_key ... state = 'processing')` — per
 *    -conversation serialization: a conversation's turns are handled in order.
 *  - workspace inflight count `< workspaceInflightLimit` — per-workspace
 *    fairness cap so one workspace can't monopolize every worker.
 *
 * `pg_try_advisory_xact_lock(hashtext(conversation_key))` wraps the whole
 * claim in a transaction-scoped lock keyed by conversation, closing the race
 * where two workers both pass the NOT EXISTS check for the same conversation
 * before either commits. The lock releases automatically at transaction end.
 *
 * Raw `db.execute` returns snake_case columns (the driver doesn't apply
 * Drizzle's schema mapping to raw SQL), so the row is normalized to the
 * camelCase shape callers expect before returning.
 */
export async function claimNextChannelMessage(
  opts: ClaimNextChannelMessageOptions = {}
): Promise<ClaimedChannelInboxRow | null> {
  const workspaceInflightLimit =
    opts.workspaceInflightLimit ?? DEFAULT_WORKSPACE_INFLIGHT_LIMIT;

  const rows = (await db.execute(sql`
    UPDATE channel_inbox
    SET state = 'processing', updated_at = now()
    WHERE id = (
      SELECT ci.id
      FROM channel_inbox ci
      WHERE ci.state = 'queued'
        AND ci.next_attempt_at <= now()
        AND pg_try_advisory_xact_lock(hashtext(ci.conversation_key))
        AND NOT EXISTS (
          SELECT 1 FROM channel_inbox other
          WHERE other.conversation_key = ci.conversation_key
            AND other.state = 'processing'
        )
        AND (
          SELECT count(*) FROM channel_inbox wip
          WHERE wip.workspace_id = ci.workspace_id
            AND wip.state = 'processing'
        ) < ${workspaceInflightLimit}
      ORDER BY ci.next_attempt_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING
      id, workspace_id, channel, conversation_key, kind,
      sender_id, sender_display, provider_message_id, payload,
      state, attempts, created_at
  `)) as unknown as Array<{
    id: string;
    workspace_id: string;
    channel: string;
    conversation_key: string;
    kind: string;
    sender_id: string;
    sender_display: string;
    provider_message_id: string;
    payload: unknown;
    state: ChannelInboxState;
    attempts: number;
    created_at: Date;
  }>;

  const row = Array.from(rows)[0];
  if (!row) return null;

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channel: row.channel,
    conversationKey: row.conversation_key,
    kind: row.kind,
    senderId: row.sender_id,
    senderDisplay: row.sender_display,
    providerMessageId: row.provider_message_id,
    payload: row.payload,
    state: row.state,
    attempts: row.attempts,
    createdAt: row.created_at,
  };
}

// --- complete / fail / reclaim (worker side) -----------------------------------

/** Mark a claimed row as successfully processed. */
export async function completeChannelMessage(id: string): Promise<void> {
  await db.execute(sql`
    UPDATE channel_inbox
    SET state = 'done', updated_at = now()
    WHERE id = ${id}
  `);
}

/**
 * Record a processing failure and apply the bounded-retry decision.
 *
 * Bumps `attempts`, then routes through {@link nextInboxStateAfterFailure} for
 * the state/backoff decision — the SQL itself carries no retry policy, so the
 * policy stays testable as a pure function and can't drift from what actually
 * runs.
 */
export async function failChannelMessage(
  id: string,
  error: string
): Promise<"requeued" | "dead"> {
  const rows = (await db.execute(sql`
    SELECT attempts FROM channel_inbox WHERE id = ${id}
  `)) as unknown as Array<{ attempts: number }>;
  const current = Array.from(rows)[0];
  const attempts = (current?.attempts ?? 0) + 1;

  const decision = nextInboxStateAfterFailure(attempts);

  await db.execute(sql`
    UPDATE channel_inbox
    SET
      attempts = ${attempts},
      state = ${decision.state},
      last_error = ${error},
      next_attempt_at = now() + (${decision.delaySeconds} || ' seconds')::interval,
      updated_at = now()
    WHERE id = ${id}
  `);

  return decision.state === "dead" ? "dead" : "requeued";
}

/**
 * Reclaim `processing` rows that have been idle longer than
 * `INBOX_STALE_PROCESSING_MINUTES`, presumed crashed mid-turn (worker died,
 * OOM, deploy). Returns them to `queued` so another worker picks them up.
 * Does NOT bump `attempts` — a crash isn't the message's fault.
 */
export async function reclaimStaleChannelMessages(): Promise<number> {
  const rows = (await db.execute(sql`
    UPDATE channel_inbox
    SET state = 'queued', updated_at = now()
    WHERE state = 'processing'
      AND updated_at < now() - (${INBOX_STALE_PROCESSING_MINUTES} || ' minutes')::interval
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return Array.from(rows).length;
}

// --- dead-letter read/requeue (console approvals inbox — issue #1234) ---------

/** Normalized (camelCase) shape of a dead-lettered channel_inbox row. */
export interface DeadLetterChannelMessageRow {
  id: string;
  channel: string;
  conversationKey: string;
  kind: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
}

/**
 * List dead-lettered channel_inbox rows for a workspace, newest first — the
 * console approvals inbox's "failed messages" view (issue #1234).
 */
export async function deadLettersForWorkspace(
  workspaceId: string
): Promise<DeadLetterChannelMessageRow[]> {
  const rows = (await db.execute(sql`
    SELECT id, channel, conversation_key, kind, attempts, last_error, created_at
    FROM channel_inbox
    WHERE workspace_id = ${workspaceId}
      AND state = 'dead'
    ORDER BY created_at DESC
  `)) as unknown as Array<{
    id: string;
    channel: string;
    conversation_key: string;
    kind: string;
    attempts: number;
    last_error: string | null;
    created_at: Date;
  }>;

  return Array.from(rows).map((row) => ({
    id: row.id,
    channel: row.channel,
    conversationKey: row.conversation_key,
    kind: row.kind,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
  }));
}

/**
 * Requeue a single dead-lettered channel_inbox message: resets `attempts` to
 * 0, clears `last_error`, and sets `state = 'queued'` so the claim query
 * picks it up immediately.
 *
 * `WHERE id = ... AND workspace_id = ... AND state = 'dead'` makes this
 * atomic and safe against misuse: it flips ONLY a row that is currently
 * `dead` and owned by the given workspace. A row in any other state, or one
 * that belongs to a different workspace, matches zero rows and the UPDATE is
 * a no-op — returns `false`, row untouched. Mirrors the same
 * guarded-UPDATE...RETURNING idempotency pattern as `resolveApproval` in
 * `jace_sessions.ts`.
 */
export async function requeueDeadChannelMessage(
  workspaceId: string,
  id: string
): Promise<boolean> {
  const rows = (await db.execute(sql`
    UPDATE channel_inbox
    SET state = 'queued', attempts = 0, next_attempt_at = now(), last_error = null, updated_at = now()
    WHERE id = ${id}
      AND workspace_id = ${workspaceId}
      AND state = 'dead'
    RETURNING id
  `)) as unknown as Array<{ id: string }>;

  return Array.from(rows).length > 0;
}
