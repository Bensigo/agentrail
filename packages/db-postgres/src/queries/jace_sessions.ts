import { randomBytes } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { db } from "../db.js";
import {
  jaceSessions,
  jaceApprovals,
  type JaceSessionRow,
  type JaceApprovalRow,
} from "../schema/jace_sessions.js";
import {
  listWorkspacesForChatIdentity,
  type ReachableWorkspace,
} from "./chat_identities.js";

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

/**
 * Look up a Jace session by its bound Eve session id. Used by the
 * connect-GitHub mint endpoint (issue #1263 PR ②) to resolve the CALLING
 * conversation's own chat identity server-side from `ctx.session.id` (Eve's
 * own session id, read off ToolContext — never model-supplied and never a
 * caller-chosen (platform, platformUserId) pair). See
 * `connect-link/route.ts`'s doc-comment for why this replaces that shape and
 * what accepted residual it closes.
 *
 * `eve_session_id` carries no DB-level uniqueness constraint (a row gets one
 * bound via `bindEveSession`, but nothing enforces that it's the only row
 * with that value), so this orders by `lastActivityAt` descending and takes
 * the top row — the same most-recently-active tie-break
 * `resolveConversationWorkspace` uses for its own (legally) multi-row case.
 * Returns `null` when no session has this eve_session_id bound yet.
 */
export async function getJaceSessionByEveSessionId(
  eveSessionId: string
): Promise<JaceSessionRow | null> {
  const [row] = await db
    .select()
    .from(jaceSessions)
    .where(eq(jaceSessions.eveSessionId, eveSessionId))
    .orderBy(desc(jaceSessions.lastActivityAt))
    .limit(1);
  return row ?? null;
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
 *
 * CALLER CONTRACT: callers MUST call `resolveConversationWorkspace` (below)
 * first and only reach this function on its `kind: "intro"` result. Calling
 * this directly for a conversation that already has a workspace-anchored
 * `jace_sessions` row does NOT fail — the partial unique index above only
 * polices the `workspace_id IS NULL` universe, so an out-of-contract call
 * silently FORKS the conversation: a shadow intro row is inserted beside the
 * already-anchored row, and both live on undetected. The loud failure mode
 * (a unique-constraint violation) only shows up later, and only if the
 * shadow row is graduated (`bindJaceSessionWorkspace`) to the SAME workspace
 * as the existing anchor — that UPDATE collides with
 * `jace_sessions_conversation_unique`. Graduating the shadow row to a
 * DIFFERENT workspace never errors at all: it silently produces two
 * workspace-anchored sessions for one (channel, conversationKey), the exact
 * dual-anchored ambiguity `resolveConversationWorkspace`'s `ambiguous` flag
 * exists to detect after the fact. Resolve-first is the contract; this
 * function is not safe to call speculatively.
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

// --- multi-workspace disambiguation (spec §4.2, issue #1261 PR ③) ----------

export interface ResolveConversationWorkspaceInput {
  chatIdentityId: string;
  channel: string;
  conversationKey: string;
}

export type ResolveConversationWorkspaceResult =
  | {
      kind: "pinned";
      workspaceId: string;
      sessionId: string;
      /** True when 2+ workspace-anchored sessions share this (channel,
       * conversationKey) — legal under the (workspace, channel,
       * conversation_key) unique (a historic ambiguity, since that
       * constraint scopes uniqueness PER workspace, not across them). The
       * most recently active session wins; a true value tells the door to
       * re-confirm with the user rather than silently trust the pick. */
      ambiguous: boolean;
    }
  | { kind: "ask"; options: ReachableWorkspace[] }
  | { kind: "single"; workspaceId: string }
  | { kind: "intro" };

/**
 * Decide which workspace a conversation belongs to — spec §4.2's "Jace asks
 * once per conversation and pins the answer to the conversation key." Purely
 * read-only (no inserts/updates): the door (issue #1262) calls this on every
 * inbound turn and only calls `pinConversationWorkspace` below when a
 * decision needs recording.
 *
 * Precedence, checked in this exact order:
 *  1. `pinned` — a workspace-anchored `jace_sessions` row already exists for
 *     (channel, conversationKey), found with NO `chatIdentityId` filter
 *     (deliberately: a channel/thread's pin does not depend on which
 *     identity is currently speaking in it). See `ambiguous` above for the
 *     2+ row case.
 *  2. `ask` — no pinned session, and the identity reaches 2+ workspaces
 *     (via `listWorkspacesForChatIdentity`).
 *  3. `single` — no pinned session, exactly 1 reachable workspace.
 *  4. `intro` — no pinned session, 0 reachable workspaces (unknown/unbound
 *     identity; the door continues the intro conversation per PR ②).
 *
 * SECURITY: the `pinned` path's entire security rests on (channel,
 * conversationKey) being platform-authoritative — taken from the webhook
 * payload's own routing fields (e.g. chat/thread id), never derived from
 * message content or model output. `conversationKey` is the sole match key
 * for `pinned` (deliberately, with no `chatIdentityId` filter — see point 1
 * above); a caller-supplied or model-guessed key that happens to collide
 * with another conversation's key rides that conversation's existing pin
 * straight into a foreign workspace. Consequence worth calling out: in a
 * group chat, every participant sharing the (channel, conversationKey)
 * inherits the SAME pin once one is set, including identities that reach
 * zero workspaces of their own — the pin belongs to the conversation, not to
 * any one identity in it.
 */
export async function resolveConversationWorkspace(
  input: ResolveConversationWorkspaceInput
): Promise<ResolveConversationWorkspaceResult> {
  const { chatIdentityId, channel, conversationKey } = input;

  const pinnedSessions = await db
    .select()
    .from(jaceSessions)
    .where(
      and(
        eq(jaceSessions.channel, channel),
        eq(jaceSessions.conversationKey, conversationKey),
        isNotNull(jaceSessions.workspaceId)
      )
    )
    .orderBy(desc(jaceSessions.lastActivityAt));

  if (pinnedSessions.length > 0) {
    const top = pinnedSessions[0]!;
    return {
      kind: "pinned",
      workspaceId: top.workspaceId!,
      sessionId: top.id,
      ambiguous: pinnedSessions.length > 1,
    };
  }

  const reachable = await listWorkspacesForChatIdentity(chatIdentityId);
  if (reachable.length === 0) {
    return { kind: "intro" };
  }
  if (reachable.length === 1) {
    return { kind: "single", workspaceId: reachable[0]!.id };
  }
  return { kind: "ask", options: reachable };
}

export interface PinConversationWorkspaceInput {
  chatIdentityId: string;
  channel: string;
  conversationKey: string;
  workspaceId: string;
}

export type PinConversationWorkspaceResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: "not_reachable" | "already_pinned_elsewhere" };

/**
 * Pin a conversation to a workspace — "ask once, pin to conversation key"
 * (spec §4.2). The pin IS the `jace_sessions` row's workspace binding; there
 * is no separate pin table. Re-asking (when `resolveConversationWorkspace`
 * returns `ambiguous: true`) is entirely the door's choice — this function
 * only ever records one decision per call.
 *
 * `workspaceId` must be one `listWorkspacesForChatIdentity` already reaches,
 * checked FIRST, before any write: the tenant-isolation guard, since an
 * identity must never pin a conversation to a workspace it cannot reach.
 *
 * Then, in order:
 *  - ANY existing `jace_sessions` row for (channel, conversationKey) — intro
 *    (workspace-less) OR already workspace-anchored, and the most recently
 *    active one when the historic multi-row ambiguity applies (same tie-break
 *    as `resolveConversationWorkspace`) — is bound via `bindJaceSessionWorkspace`
 *    (PR ②'s atomic guard). That ONE guard covers every outcome this
 *    function needs: an intro row graduates in place; a row already pinned
 *    to this SAME workspace is a harmless idempotent no-op; a row already
 *    pinned to a DIFFERENT workspace — whether that happened moments ago
 *    (a plain earlier pin) or via a concurrent call racing this one — is
 *    refused, surfaced here as `already_pinned_elsewhere`. This is a
 *    deliberate generalization of "graduate the intro session": treating
 *    "pin conversation X to workspace W" uniformly regardless of whether a
 *    prior session row already existed as intro or as a (different) pin is
 *    what makes a same-conversation re-pin attempt behave the same as a
 *    race — both are "someone already decided this conversation's workspace,
 *    and it wasn't W".
 *  - Otherwise (no session at all exists yet for this conversation) a fresh
 *    workspace-anchored session is created (`getOrCreateJaceSession`) and
 *    `chat_identity_id` is set on it with one small UPDATE, so the identity
 *    link is kept even though this path never touches a pre-existing row.
 *
 * CONCURRENCY: a returned `ok: true` is NOT mutually exclusive across
 * racing callers. Two concurrent calls for the same brand-new (channel,
 * conversationKey) but DIFFERENT workspaces can both pass the "no existing
 * session" branch above before either write lands (`getOrCreateJaceSession`'s
 * own conflict target includes `workspaceId`, so two different workspace ids
 * never collide with each other) — each call then returns `ok: true`,
 * leaving two dual-anchored rows for the one conversation. This is the
 * designed recovery path, not a gap left open here: the next
 * `resolveConversationWorkspace` call surfaces exactly this outcome as
 * `pinned` with `ambiguous: true`. Callers must treat `ok: true` as "this
 * call's write landed," never as "this workspace is now the exclusive
 * answer" — re-resolve rather than trust a cached pin.
 */
export async function pinConversationWorkspace(
  input: PinConversationWorkspaceInput
): Promise<PinConversationWorkspaceResult> {
  const { chatIdentityId, channel, conversationKey, workspaceId } = input;

  const reachable = await listWorkspacesForChatIdentity(chatIdentityId);
  if (!reachable.some((workspace) => workspace.id === workspaceId)) {
    return { ok: false, reason: "not_reachable" };
  }

  const [existingSession] = await db
    .select()
    .from(jaceSessions)
    .where(
      and(
        eq(jaceSessions.channel, channel),
        eq(jaceSessions.conversationKey, conversationKey)
      )
    )
    .orderBy(desc(jaceSessions.lastActivityAt))
    .limit(1);

  if (existingSession) {
    const bound = await bindJaceSessionWorkspace(existingSession.id, workspaceId);
    if (!bound) {
      return { ok: false, reason: "already_pinned_elsewhere" };
    }
    return { ok: true, sessionId: existingSession.id };
  }

  const session = await getOrCreateJaceSession(
    workspaceId,
    channel,
    conversationKey
  );
  await db
    .update(jaceSessions)
    .set({ chatIdentityId, updatedAt: new Date() })
    .where(
      and(eq(jaceSessions.id, session.id), isNull(jaceSessions.chatIdentityId))
    );

  return { ok: true, sessionId: session.id };
}

// --- post-bind confirmation (spec §4.2, issue #1263 PR ②) -------------------

/**
 * The most recently active `telegram` session for a chat identity — how the
 * post-bind confirmation (`/connect/[token]`) finds which Telegram chat to
 * confirm INTO after a fresh GitHub bind. `conversationKey` on the returned
 * row IS the Telegram chat id for this channel (see this file's module
 * comment); callers read `.conversationKey`, there is no separate column.
 *
 * Scoped to `channel = 'telegram'` only: the shared-bot confirmation flow is
 * Telegram-only for v1 (annex-1263-recon). Ordered by `lastActivityAt`
 * descending so a chat identity with more than one historic Telegram session
 * (e.g. an intro conversation before it graduated, plus the graduated one)
 * resolves to the one the user is actually talking in now. Returns `null`
 * when the identity has no Telegram session at all — the caller's contract
 * is to skip the confirmation silently in that case, never to error.
 */
export async function latestTelegramSessionForChatIdentity(
  chatIdentityId: string
): Promise<JaceSessionRow | null> {
  const [row] = await db
    .select()
    .from(jaceSessions)
    .where(
      and(
        eq(jaceSessions.chatIdentityId, chatIdentityId),
        eq(jaceSessions.channel, "telegram")
      )
    )
    .orderBy(desc(jaceSessions.lastActivityAt))
    .limit(1);
  return row ?? null;
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
