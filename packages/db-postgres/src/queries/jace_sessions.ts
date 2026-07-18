import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "../db.js";
import {
  jaceSessions,
  jaceApprovals,
  type JaceSessionRow,
  type JaceApprovalRow,
} from "../schema/jace_sessions.js";

/**
 * Jace session + approval queries (spec §4; see `schema/jace_sessions.ts` for
 * the table shapes and the WHY behind the design).
 *
 * `jace_sessions` maps (workspace, channel, conversation) → one Eve session, so
 * `getOrCreateJaceSession` is the single entry point every inbound turn calls
 * before touching Eve. `getOrCreateIntroJaceSession` + `bindJaceSessionWorkspace`
 * (issue #1261 PR ②) are the workspace-less counterpart: a session anchored to
 * chat_identity_id instead, for a sender with no resolved workspace yet, that
 * graduates in place once one exists. `jace_approvals` records each Eve
 * `waiting` inputRequest surfaced to the channel as approve/deny buttons;
 * `resolveApproval` is the publication idempotency guard described there — see
 * its comment for why the pending→resolved flip must be atomic.
 */

// --- session lookup / creation --------------------------------------------------

/**
 * Get the Jace session for (workspace, channel, conversation), creating it if
 * this is the first turn. Race-safe: two concurrent webhook deliveries for a
 * brand-new conversation can both attempt the insert; the unique constraint on
 * (workspace_id, channel, conversation_key) makes the loser's insert a no-op
 * (`onConflictDoNothing`), and the follow-up SELECT fetches whichever row won
 * — so callers always get exactly one, consistent session row.
 */
export async function getOrCreateJaceSession(
  workspaceId: string,
  channel: string,
  conversationKey: string
): Promise<JaceSessionRow> {
  await db
    .insert(jaceSessions)
    .values({ workspaceId, channel, conversationKey })
    .onConflictDoNothing({
      target: [
        jaceSessions.workspaceId,
        jaceSessions.channel,
        jaceSessions.conversationKey,
      ],
    });

  const [row] = await db
    .select()
    .from(jaceSessions)
    .where(
      and(
        eq(jaceSessions.workspaceId, workspaceId),
        eq(jaceSessions.channel, channel),
        eq(jaceSessions.conversationKey, conversationKey)
      )
    )
    .limit(1);

  if (!row) {
    // Unreachable in practice: the insert above either created the row or
    // lost the race to a concurrent insert that did. Fail loudly rather than
    // fabricate a row that would silently diverge from the DB.
    throw new Error(
      `getOrCreateJaceSession: no row found for ${workspaceId}/${channel}/${conversationKey} after insert`
    );
  }
  return row;
}

/** Bind the Eve session id to a Jace session once the first turn creates it. */
export async function bindEveSession(
  sessionId: string,
  eveSessionId: string
): Promise<void> {
  await db
    .update(jaceSessions)
    .set({ eveSessionId, lastActivityAt: new Date(), updatedAt: new Date() })
    .where(eq(jaceSessions.id, sessionId));
}

/** Update a Jace session's status and touch lastActivityAt. */
export async function setJaceSessionStatus(
  sessionId: string,
  status: "active" | "waiting" | "closed"
): Promise<void> {
  await db
    .update(jaceSessions)
    .set({ status, lastActivityAt: new Date(), updatedAt: new Date() })
    .where(eq(jaceSessions.id, sessionId));
}

// --- intro sessions (workspace-less, spec §4.1) -----------------------------

/**
 * Get the intro Jace session for (channel, conversationKey), creating it if
 * this is the first turn from a sender with no resolved workspace yet.
 * Mirrors `getOrCreateJaceSession`'s race-safe insert-then-select idiom, but
 * anchored to `chatIdentityId` with `workspaceId` left NULL.
 *
 * Conflict target is the partial unique index `jace_sessions_intro_conversation_idx`
 * — (channel, conversation_key) WHERE workspace_id IS NULL — not the
 * workspace-anchored composite unique (workspace_id can't be part of an
 * ordinary conflict target here: it's NULL for every intro row, and NULLs
 * never conflict with each other in a plain unique constraint). Passing
 * `where: isNull(jaceSessions.workspaceId)` alongside the same `target`
 * columns as the partial index lets Postgres select it as the ON CONFLICT
 * arbiter (verified against the installed drizzle-orm + a live migration —
 * see the PR report's onConflict section).
 *
 * Not scoped by `chatIdentityId` on the follow-up select: the partial index
 * makes (channel, conversationKey) the sole key for the intro universe, so a
 * second identity racing the same conversation key resolves to the session
 * the first one created (matches the workspace-anchored session's own
 * one-row-per-conversation-key invariant).
 */
export async function getOrCreateIntroJaceSession(
  chatIdentityId: string,
  channel: string,
  conversationKey: string
): Promise<JaceSessionRow> {
  await db
    .insert(jaceSessions)
    .values({ chatIdentityId, channel, conversationKey })
    .onConflictDoNothing({
      target: [jaceSessions.channel, jaceSessions.conversationKey],
      where: isNull(jaceSessions.workspaceId),
    });

  const [row] = await db
    .select()
    .from(jaceSessions)
    .where(
      and(
        eq(jaceSessions.channel, channel),
        eq(jaceSessions.conversationKey, conversationKey),
        isNull(jaceSessions.workspaceId)
      )
    )
    .limit(1);

  if (!row) {
    // Unreachable in practice: the insert above either created the row or
    // lost the race to a concurrent insert that did. Fail loudly rather than
    // fabricate a row that would silently diverge from the DB.
    throw new Error(
      `getOrCreateIntroJaceSession: no row found for ${chatIdentityId}/${channel}/${conversationKey} after insert`
    );
  }
  return row;
}

/**
 * Graduate an intro session to a real workspace once one is resolved or
 * created (issue #1264's create_workspace flow). Binds `workspaceId` in
 * place — the dispatcher never has to move a conversation between session
 * rows.
 *
 * Returns `true` when the session ends up anchored to `workspaceId`, whether
 * because this call just set it (first graduation, workspace_id was NULL) or
 * because it already was exactly that workspace (idempotent re-bind, a
 * harmless no-op UPDATE touching updatedAt again). Returns `false` ONLY when
 * the session already belongs to a DIFFERENT workspace: never silently
 * re-tenant a conversation. The `workspace_id IS NULL OR workspace_id =
 * $workspaceId` guard makes this ONE atomic UPDATE — no separate
 * read-then-write race window — mirroring `resolveApproval`'s
 * conditional-UPDATE-returning-boolean idempotency guard above.
 */
export async function bindJaceSessionWorkspace(
  sessionId: string,
  workspaceId: string
): Promise<boolean> {
  const result = await db
    .update(jaceSessions)
    .set({ workspaceId, updatedAt: new Date() })
    .where(
      and(
        eq(jaceSessions.id, sessionId),
        or(
          isNull(jaceSessions.workspaceId),
          eq(jaceSessions.workspaceId, workspaceId)
        )
      )
    )
    .returning({ id: jaceSessions.id });

  return result.length > 0;
}

// --- approvals --------------------------------------------------------------

export interface RecordApprovalRequestInput {
  workspaceId: string;
  sessionId: string;
  eveSessionId: string;
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  approveOptionId: string;
  denyOptionId: string;
}

/**
 * Record a pending approval for an Eve `waiting` inputRequest and mint the
 * short callback token the channel button carries.
 *
 * `callbackToken` is `randomBytes(8).toString("hex")` — 16 hex chars, well
 * under Telegram's 64-byte callback_data limit alongside a prefix, and
 * unguessable enough that a stranger can't forge an approve/deny click.
 */
export async function recordApprovalRequest(
  input: RecordApprovalRequestInput
): Promise<JaceApprovalRow> {
  const callbackToken = randomBytes(8).toString("hex");

  const [row] = await db
    .insert(jaceApprovals)
    .values({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      eveSessionId: input.eveSessionId,
      requestId: input.requestId,
      callbackToken,
      toolName: input.toolName,
      toolInput: input.toolInput,
      approveOptionId: input.approveOptionId,
      denyOptionId: input.denyOptionId,
    })
    .returning();

  if (!row) {
    throw new Error(
      `recordApprovalRequest: insert returned no row for session ${input.sessionId} request ${input.requestId}`
    );
  }
  return row;
}

/**
 * Look up an approval by its callback token, scoped to a workspace so a token
 * from one tenant can never resolve another tenant's approval.
 */
export async function findApprovalByCallbackToken(
  workspaceId: string,
  callbackToken: string
): Promise<JaceApprovalRow | null> {
  const [row] = await db
    .select()
    .from(jaceApprovals)
    .where(
      and(
        eq(jaceApprovals.workspaceId, workspaceId),
        eq(jaceApprovals.callbackToken, callbackToken)
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * Resolve a pending approval to `approved` or `denied`.
 *
 * Returns `true` ONLY on the pending→resolved flip: the UPDATE carries
 * `WHERE status = 'pending'`, so a second resolution attempt (e.g. a
 * duplicate Telegram callback delivery, or two workers racing the same
 * callback) matches zero rows and returns `false`. This IS the publication
 * idempotency guard — callers must only publish the downstream side effect
 * (e.g. creating the GitHub issue) when this returns `true`, so a redelivered
 * callback can never publish twice.
 */
export async function resolveApproval(
  id: string,
  status: "approved" | "denied",
  publishedIssueUrl?: string
): Promise<boolean> {
  const result = await db
    .update(jaceApprovals)
    .set({
      status,
      publishedIssueUrl: publishedIssueUrl ?? null,
      resolvedAt: new Date(),
    })
    .where(and(eq(jaceApprovals.id, id), eq(jaceApprovals.status, "pending")))
    .returning({ id: jaceApprovals.id });

  return result.length > 0;
}

/** A pending approval joined with its session's channel/conversation, for the console approvals inbox (issue #1234). */
export interface PendingApprovalRow {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  approveOptionId: string;
  denyOptionId: string;
  channel: string;
  conversationKey: string;
  createdAt: Date;
}

/**
 * List pending approvals for a workspace, newest first, joined to their
 * owning session so the console approvals inbox can show which
 * channel/conversation each approval came from without a second query.
 */
export async function pendingApprovalsForWorkspace(
  workspaceId: string
): Promise<PendingApprovalRow[]> {
  const rows = await db
    .select({
      id: jaceApprovals.id,
      toolName: jaceApprovals.toolName,
      toolInput: jaceApprovals.toolInput,
      approveOptionId: jaceApprovals.approveOptionId,
      denyOptionId: jaceApprovals.denyOptionId,
      channel: jaceSessions.channel,
      conversationKey: jaceSessions.conversationKey,
      createdAt: jaceApprovals.createdAt,
    })
    .from(jaceApprovals)
    .innerJoin(jaceSessions, eq(jaceApprovals.sessionId, jaceSessions.id))
    .where(
      and(
        eq(jaceApprovals.workspaceId, workspaceId),
        eq(jaceApprovals.status, "pending")
      )
    )
    .orderBy(desc(jaceApprovals.createdAt));

  return rows as PendingApprovalRow[];
}
