import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
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

/**
 * Look up a Jace session by its own primary key. Added as the null-`chatIdentityId`
 * fallback for the Telegram webhook's callback_query SENDER CHECK (issue
 * #1273 review fix): a legacy approval recorded before identity backfill has
 * `chat_identity_id` permanently null, so the strict identity check can never
 * pass for it — this lets the webhook fall back to reading the OWNING
 * session's own `conversationKey` via `jaceApprovals.sessionId` instead
 * (`conversationKey` IS the chat id for a Telegram DM, the #1262 convention).
 * No further scoping needed: `id` is the session's own uuid PK, never
 * caller-guessable (mirrors `getApprovalById`'s own no-scope rationale).
 */
export async function getJaceSessionById(
  id: string
): Promise<JaceSessionRow | null> {
  const [row] = await db
    .select()
    .from(jaceSessions)
    .where(eq(jaceSessions.id, id))
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

export interface RepinConversationWorkspaceInput {
  chatIdentityId: string;
  channel: string;
  conversationKey: string;
  fromWorkspaceId: string;
  toWorkspaceId: string;
}

export type RepinConversationWorkspaceResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: "not_reachable" | "moved" | "conflict" };

/**
 * Drizzle can wrap the underlying pg error, so the unique-violation code
 * (23505) may live on err.code or err.cause.code — same detection idiom as
 * `queries/index.ts`'s own `isUniqueViolation` (duplicated rather than
 * imported, matching that function's own precedent of not centralizing this
 * specific helper across modules).
 */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/**
 * Move an already-pinned conversation to a different workspace — the
 * `/connect` command's move path (issue #1261 PR).
 *
 * The pin belongs to the CONVERSATION, not to any identity in it (see
 * `resolveConversationWorkspace`'s doc-comment): every participant sharing
 * (channel, conversationKey) inherits it. So the authority rule is that the
 * requester must reach BOTH the current and target workspace — you may move a
 * conversation between workspaces you have standing in, but you may not walk
 * into a channel pinned to a workspace you are a stranger to and move it
 * elsewhere. That rule is decided in `connect-command.ts` and RE-VERIFIED
 * here, so a caller bug alone cannot bypass it — this is deliberate defence
 * in depth, not redundancy.
 *
 * TOCTOU: the authority check above and the UPDATE below are separate round
 * trips. If the requester's membership in `fromWorkspaceId` or
 * `toWorkspaceId` is revoked in the gap between them, the move still lands —
 * the re-check is NOT atomic with the write. This mirrors
 * `pinConversationWorkspace`'s own posture (see its CONCURRENCY paragraph);
 * unlike that function, this one does not attempt to close the window, only
 * to document it.
 *
 * The UPDATE is guarded on the row's CURRENT workspace_id (in addition to
 * channel + conversationKey), so a concurrent re-pin that landed first yields
 * `moved` rather than silently clobbering it. `moved` is also returned when
 * the caller passed a `fromWorkspaceId` that was simply wrong, or when no
 * session was ever pinned for this (channel, conversationKey) at all — the
 * guarded UPDATE cannot distinguish "someone else already moved it" from
 * "this was never pinned here" from "bad input"; all three land on zero rows
 * matched. Callers re-resolve once rather than retrying in a loop.
 *
 * `.returning({ id })` rather than the full row: safe to read as "at most one
 * row" because `jace_sessions_conversation_unique` — UNIQUE(workspace_id,
 * channel, conversation_key) — guarantees at most one row can match
 * `(workspace_id = fromWorkspaceId, channel, conversationKey)`. If that
 * constraint were ever loosened, this UPDATE would silently move every
 * matching row while still reporting a single id.
 *
 * CONFLICT: a row can already exist at `(toWorkspaceId, channel,
 * conversationKey)` — dual-anchored rows for one (channel, conversationKey)
 * are a designed, reachable state (see `pinConversationWorkspace`'s
 * CONCURRENCY paragraph and `resolveConversationWorkspace`'s `ambiguous`
 * flag), and a user consolidating an ambiguous conversation by moving one
 * anchor onto the other's workspace is exactly how a caller lands here. That
 * makes the UPDATE violate `jace_sessions_conversation_unique`, which this
 * catches and reports as `{ ok: false, reason: "conflict" }` rather than
 * letting the rejection propagate. Any other database error is re-thrown
 * unchanged.
 */
export async function repinConversationWorkspace(
  input: RepinConversationWorkspaceInput
): Promise<RepinConversationWorkspaceResult> {
  const { chatIdentityId, channel, conversationKey, fromWorkspaceId, toWorkspaceId } = input;

  const reachable = await listWorkspacesForChatIdentity(chatIdentityId);
  const reaches = (id: string) => reachable.some((workspace) => workspace.id === id);
  if (!reaches(fromWorkspaceId) || !reaches(toWorkspaceId)) {
    return { ok: false, reason: "not_reachable" };
  }

  let row: { id: string } | undefined;
  try {
    [row] = await db
      .update(jaceSessions)
      .set({ workspaceId: toWorkspaceId, updatedAt: new Date() })
      .where(
        and(
          eq(jaceSessions.channel, channel),
          eq(jaceSessions.conversationKey, conversationKey),
          eq(jaceSessions.workspaceId, fromWorkspaceId)
        )
      )
      .returning({ id: jaceSessions.id });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, reason: "conflict" };
    }
    throw err;
  }

  return row ? { ok: true, sessionId: row.id } : { ok: false, reason: "moved" };
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

/**
 * The most recently active `telegram` session for a WORKSPACE — the same
 * lookup as {@link latestTelegramSessionForChatIdentity} above, keyed by
 * `workspaceId` instead of `chatIdentityId`. This is how a workspace-scoped
 * system notice (e.g. the monthly-budget-ceiling notify, issue #1269 PR ②a)
 * finds which Telegram chat to post INTO: the shared-bot session ledger
 * (`jace_sessions`) is where a workspace's actual bound Telegram conversation
 * lives today (post-#1262), not the legacy per-workspace `connectors` row
 * `runner/result/notify.ts`'s run-outcome fan-out reads.
 *
 * Scoped to `channel = 'telegram'` only, same v1 scope as the per-identity
 * lookup. Ordered by `lastActivityAt` descending so a workspace with more
 * than one bound conversation (e.g. two people chatting about the same
 * workspace) resolves to whichever is currently most active. Returns `null`
 * when the workspace has no Telegram session at all — callers must skip the
 * send silently in that case, never error.
 */
export async function latestTelegramSessionForWorkspace(
  workspaceId: string
): Promise<JaceSessionRow | null> {
  const [row] = await db
    .select()
    .from(jaceSessions)
    .where(
      and(
        eq(jaceSessions.workspaceId, workspaceId),
        eq(jaceSessions.channel, "telegram")
      )
    )
    .orderBy(desc(jaceSessions.lastActivityAt))
    .limit(1);
  return row ?? null;
}

/** The `{ channel, conversationKey }` shape {@link latestChatSessionForWorkspace}
 * returns — just enough for a caller to address a reply, never the whole
 * session row (that's what {@link latestTelegramSessionForWorkspace}'s
 * broader `JaceSessionRow | null` is for). */
export type LatestChatSession = { channel: string; conversationKey: string };

/**
 * The most recently active CHAT session (any of `telegram`/`discord`/
 * `slack`) for a WORKSPACE — the same shape as
 * {@link latestTelegramSessionForWorkspace} above, generalized from one
 * channel to the three chat channels, and narrowed from the whole
 * `JaceSessionRow` to just `{ channel, conversationKey }` (all a delivery
 * call needs to address a reply). This is the capacity gate's delivery
 * lookup (spec §6 point 2): unlike the chat seat gate, which fires INLINE
 * inside `processRow`/`processConsoleRow` and can reply straight into the
 * turn it's gating, the capacity gate runs at the runner CLAIM route — no
 * chat turn is in flight there, so it needs to find which chat conversation
 * to push the upgrade notice INTO, the same problem
 * `latestTelegramSessionForWorkspace` already solves for the
 * monthly-budget-ceiling notify (see that function's own doc-comment).
 *
 * `console` is deliberately EXCLUDED from the IN-list: a console-only
 * workspace has no chat surface for this lookup to find, and the console
 * chat thread (`jace_messages`, `queries/jace_messages.ts`) is a different
 * delivery mechanism entirely, not one this function's callers address
 * through a `(channel, conversationKey)` pair.
 *
 * Ordered by `lastActivityAt` descending, same tie-break as
 * `latestTelegramSessionForWorkspace`, for the same reason: a workspace with
 * more than one bound conversation across channels resolves to whichever is
 * currently most active. Returns `null` when the workspace has no
 * telegram/discord/slack session at all — callers must skip the send
 * silently in that case, never error.
 */
export async function latestChatSessionForWorkspace(
  workspaceId: string
): Promise<LatestChatSession | null> {
  const [row] = await db
    .select({
      channel: jaceSessions.channel,
      conversationKey: jaceSessions.conversationKey,
    })
    .from(jaceSessions)
    .where(
      and(
        eq(jaceSessions.workspaceId, workspaceId),
        inArray(jaceSessions.channel, ["telegram", "discord", "slack"])
      )
    )
    .orderBy(desc(jaceSessions.lastActivityAt))
    .limit(1);
  return row ?? null;
}

// --- brief anchor (briefs design spec, "Retrieval — the whole mismatch
// surface", step 3) --------------------------------------------------------
//
// A DIFFERENT kind of anchor from the workspace/chat-identity pair above —
// see `schema/jace_sessions.ts`'s doc-comment for the full distinction. These
// three functions are the whole read/write surface for it: `runner/briefs`
// calls `setSessionBriefAnchor` once the human confirms which brief a
// conversation is about, `getSessionBriefAnchor` on every later turn so
// grill-me can skip straight to the anchored brief instead of re-asking, and
// `clearSessionBriefAnchor` when a later message drifts enough that the human
// needs to be asked again (design spec step 4) or explicitly starts a new
// idea in the same conversation.

/**
 * Anchor a Jace session to a confirmed brief. Idempotent by construction: this
 * is a plain `UPDATE ... WHERE id = $sessionId`, never an insert racing a
 * unique constraint, so setting the SAME `briefId` twice (or re-anchoring to
 * a different one) is just the same statement landing on the same row twice
 * — no special-cased no-op branch is needed, and no upstream anchor
 * (`workspaceId`/`chatIdentityId`) is ever touched by this write.
 *
 * Returns `true` when `sessionId` matched a row (whether or not the anchor
 * value actually changed), `false` when no session exists with that id — the
 * caller (the console route) is expected to have already resolved `sessionId`
 * from a workspace-scoped `eveSessionId` lookup, so a `false` here signals a
 * caller bug (a stale or foreign session id) rather than a legitimate,
 * expected outcome.
 */
export async function setSessionBriefAnchor(
  sessionId: string,
  briefId: string
): Promise<boolean> {
  const result = await db
    .update(jaceSessions)
    .set({ anchoredBriefId: briefId, updatedAt: new Date() })
    .where(eq(jaceSessions.id, sessionId))
    .returning({ id: jaceSessions.id });
  return result.length > 0;
}

/**
 * Clear a session's brief anchor (design spec step 4: re-confirm on drift,
 * rather than ever writing to the wrong brief). Same idempotency and
 * no-disturbance-to-other-anchors reasoning as {@link setSessionBriefAnchor}:
 * clearing an already-clear anchor is a harmless no-op UPDATE that still
 * returns `true` as long as the session row exists.
 */
export async function clearSessionBriefAnchor(sessionId: string): Promise<boolean> {
  const result = await db
    .update(jaceSessions)
    .set({ anchoredBriefId: null, updatedAt: new Date() })
    .where(eq(jaceSessions.id, sessionId))
    .returning({ id: jaceSessions.id });
  return result.length > 0;
}

/**
 * Read back a session's currently anchored brief id, or `null` when the
 * session has none anchored — either because it was never set, it was
 * explicitly cleared ({@link clearSessionBriefAnchor}), or the anchored brief
 * was deleted (the column's `ON DELETE SET NULL` FK handles that case at the
 * database level; this function just reads whatever value results). Returns
 * `null` (not a thrown error) when `sessionId` itself doesn't resolve to a
 * row — callers that need to distinguish "no session" from "session with no
 * anchor" should resolve the session first via `getJaceSessionById`/
 * `getJaceSessionByEveSessionId`, which already carry `anchoredBriefId` on
 * the row and make this standalone read unnecessary for them; this exists for
 * callers that only have a bare `sessionId` on hand and want the anchor
 * alone.
 */
export async function getSessionBriefAnchor(sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ anchoredBriefId: jaceSessions.anchoredBriefId })
    .from(jaceSessions)
    .where(eq(jaceSessions.id, sessionId))
    .limit(1);
  return row?.anchoredBriefId ?? null;
}

// --- thread engagement (spec:
// docs/superpowers/specs/2026-07-28-thread-native-jace-design.md) ----------
//
// Persistence for the engagement latch added to `jace_sessions` (see that
// table's doc-comment for the full state-machine rationale: NULL
// `engagementDormantSince` = engaged/not-a-thread, non-null = bowed out).
// `apps/console/lib/thread-engagement.ts`'s `decideEngagement` is the pure
// decision function these two queries bracket — it takes an `EngagementState
// | null` and returns a `nextState`; these are how the door reads that input
// and persists that output. This module (`packages/db-postgres`) must not
// import from `apps/console`, so the return shape here is structurally
// compatible with `EngagementState` but not literally that type.

/**
 * Read the engagement state for a (channel, conversationKey) thread.
 *
 * Returns `null` when NO `jace_sessions` row exists for this pair — the
 * "never engaged" case `decideEngagement` treats as "no engaged session for
 * this thread." This is DIFFERENT from a row that exists with both columns
 * null (a session Jace has never bowed out of, or one created before this
 * feature existed) — that case returns
 * `{ dormantSince: null, engagedSpeakerId: null }`, a real state, not `null`.
 * Do not collapse the two.
 *
 * Keyed on (channel, conversation_key) ONLY — no workspace scope — so this
 * query can use `jace_sessions_channel_conversation_idx` exactly as it was
 * added for: the door calls this before any workspace is resolved.
 *
 * NOT unique on (channel, conversationKey): the table's real uniqueness is
 * (workspace_id, channel, conversation_key) plus the separate partial unique
 * on (channel, conversation_key) WHERE workspace_id IS NULL, so one
 * conversation key can legally carry an intro row alongside one or more
 * workspace-bound rows at once (same multi-row shape
 * `resolveConversationWorkspace` above documents for the pinned case). Reads
 * must therefore pick ONE row deterministically rather than an arbitrary one
 * — ordered by `lastActivityAt` descending, same most-recently-active
 * tie-break idiom as `resolveConversationWorkspace`, so this resolves to
 * whichever row the dispatcher is actually driving right now. Unlike
 * `setThreadEngagement` below, this cannot update every matching row instead
 * — a read has to return exactly one state — so ordering is the only way to
 * make it deterministic.
 */
export async function getThreadEngagement(args: {
  channel: string;
  conversationKey: string;
}): Promise<{ dormantSince: Date | null; engagedSpeakerId: string | null } | null> {
  const [row] = await db
    .select({
      dormantSince: jaceSessions.engagementDormantSince,
      engagedSpeakerId: jaceSessions.engagedSpeakerId,
    })
    .from(jaceSessions)
    .where(
      and(
        eq(jaceSessions.channel, args.channel),
        eq(jaceSessions.conversationKey, args.conversationKey)
      )
    )
    .orderBy(desc(jaceSessions.lastActivityAt))
    .limit(1);
  if (!row) return null;
  return { dormantSince: row.dormantSince, engagedSpeakerId: row.engagedSpeakerId };
}

/**
 * Write the engagement state for a (channel, conversationKey) thread — the
 * write side of `decideEngagement`'s `nextState`. Updates EVERY
 * `jace_sessions` row matching the pair (mirrors `getThreadEngagement`'s own
 * read scope above: no workspace filter), and is a SILENT no-op when none
 * matches — it must never throw or insert, since the door calls this on
 * every turn regardless of whether a session row happens to exist yet.
 *
 * Deliberately UNordered and UNlimited, unlike `getThreadEngagement`'s single
 * ordered row above: when a conversation key legally carries more than one
 * row (an intro row plus a graduated one, say), engagement is a property of
 * the THREAD, not of any one row, so every row sharing the pair must agree —
 * updating all of them keeps them mutually consistent instead of letting one
 * drift stale while the read picks whichever is most recently active.
 */
export async function setThreadEngagement(args: {
  channel: string;
  conversationKey: string;
  dormantSince: Date | null;
  engagedSpeakerId: string | null;
}): Promise<void> {
  await db
    .update(jaceSessions)
    .set({
      engagementDormantSince: args.dormantSince,
      engagedSpeakerId: args.engagedSpeakerId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(jaceSessions.channel, args.channel),
        eq(jaceSessions.conversationKey, args.conversationKey)
      )
    );
}

// --- approvals --------------------------------------------------------------

export interface RecordApprovalRequestInput {
  workspaceId?: string;
  // Anchor for an approval recorded from an intro (workspace-less)
  // conversation (issue #1273, mirrors `jace_sessions`'s own intro anchor —
  // see `schema/jace_sessions.ts`'s `jaceApprovals` doc-comment). NOT an
  // either/or pair with `workspaceId` here: pass it whenever the owning
  // session has one bound, even alongside a `workspaceId`, since it also
  // doubles as the Telegram callback's SENDER CHECK target.
  chatIdentityId?: string;
  sessionId: string;
  eveSessionId: string;
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  approveOptionId: string;
  denyOptionId: string;
  // #1274: set ONLY for a system-composed "alignment_brief" approval — the
  // parked `queue_entries` row this brief is gating. Omitted (stays null) for
  // every other tool, byte-identical to today.
  queueEntryId?: string;
}

export interface RecordApprovalRequestResult {
  approval: JaceApprovalRow;
  // true when THIS call inserted the row; false when it found an existing
  // one via the (eveSessionId, requestId) conflict path below (issue #1273
  // PR ②'s idempotent-replay caller — POST /api/v1/runner/approvals — uses
  // this to decide whether to send the channel message a second time (never)
  // and which HTTP status to answer with (201 vs 200).
  created: boolean;
}

/**
 * Record a pending approval for an Eve `waiting` inputRequest and mint the
 * short callback token the channel button carries — or, if a request with
 * the SAME `(eveSessionId, requestId)` already exists, return that existing
 * row untouched (issue #1273 PR ②: the caller composes `requestId` from its
 * own idempotency key, so a retried POST must never create a second row or
 * mint a second callback token).
 *
 * `callbackToken` is `randomBytes(8).toString("hex")` — 16 hex chars, well
 * under Telegram's 64-byte callback_data limit alongside a prefix, and
 * unguessable enough that a stranger can't forge an approve/deny click.
 *
 * `workspaceId`/`chatIdentityId` mirror `enqueueChannelMessage`'s own anchor
 * guard (`queries/channel_inbox.ts`): at least one is required — checked here
 * and thrown before the INSERT, rather than letting the table's CHECK
 * constraint reject it — but unlike that guard this is NOT strictly
 * either/or; a caller with both on hand (a graduated session whose identity
 * is still known) should pass both.
 *
 * Race-safe the same way `getOrCreateJaceSession` is: `onConflictDoNothing`
 * targets the exact `jace_approvals_request_unique` columns
 * `(eve_session_id, request_id)`, so two near-simultaneous calls for the same
 * request (a genuine retry, or two concurrent pollers) can never both insert.
 * Unlike `getOrCreateJaceSession`, this checks `.returning()` on the insert
 * ITSELF first — the caller needs to know which one of them actually created
 * the row, not just get a row back — and only falls back to a plain SELECT
 * on the same unique pair when the insert lost the race (or this is a pure
 * replay of an already-recorded request).
 */
export async function recordApprovalRequest(
  input: RecordApprovalRequestInput
): Promise<RecordApprovalRequestResult> {
  if (!input.workspaceId && !input.chatIdentityId) {
    throw new Error(
      "recordApprovalRequest: requires either workspaceId or chatIdentityId"
    );
  }

  const callbackToken = randomBytes(8).toString("hex");

  const inserted = await db
    .insert(jaceApprovals)
    .values({
      workspaceId: input.workspaceId,
      chatIdentityId: input.chatIdentityId,
      sessionId: input.sessionId,
      eveSessionId: input.eveSessionId,
      requestId: input.requestId,
      callbackToken,
      toolName: input.toolName,
      toolInput: input.toolInput,
      approveOptionId: input.approveOptionId,
      denyOptionId: input.denyOptionId,
      queueEntryId: input.queueEntryId,
    })
    .onConflictDoNothing({
      target: [jaceApprovals.eveSessionId, jaceApprovals.requestId],
    })
    .returning();

  if (inserted[0]) {
    return { approval: inserted[0], created: true };
  }

  const [existing] = await db
    .select()
    .from(jaceApprovals)
    .where(
      and(
        eq(jaceApprovals.eveSessionId, input.eveSessionId),
        eq(jaceApprovals.requestId, input.requestId)
      )
    )
    .limit(1);

  if (!existing) {
    // Unreachable in practice: the insert above either created the row or
    // lost the race to a concurrent insert/replay that did — see
    // getOrCreateJaceSession's identical rationale.
    throw new Error(
      `recordApprovalRequest: no row found for ${input.eveSessionId}/${input.requestId} after conflict`
    );
  }
  return { approval: existing, created: false };
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
 * Look up an approval by its callback token ALONE — no workspace scope,
 * unlike {@link findApprovalByCallbackToken} above. The Telegram webhook
 * (issue #1273) receives a button tap carrying only `callback_data`
 * (`ar:<token>`); at that point the caller does not yet know which
 * workspace/tenant the approval belongs to — resolving that IS the point of
 * this lookup. Scoping it by workspace would be circular (nothing to scope
 * by yet), and the token itself is already the whole security boundary here:
 * it is globally unique (`jace_approvals_callback_token_unique`) and
 * unguessable (`randomBytes(8)`, see `recordApprovalRequest`'s doc-comment).
 * `findApprovalByCallbackToken` stays for callers that already know their
 * tenant and want the extra belt-and-suspenders scope.
 */
export async function getApprovalByCallbackToken(
  callbackToken: string
): Promise<JaceApprovalRow | null> {
  const [row] = await db
    .select()
    .from(jaceApprovals)
    .where(eq(jaceApprovals.callbackToken, callbackToken))
    .limit(1);
  return row ?? null;
}

/**
 * Look up an approval by its own primary key — the read behind
 * `GET /api/v1/runner/approvals/[id]` (issue #1273), the poller's status
 * check. `id` is a uuid the console itself minted and handed back in the
 * POST response, never caller-guessable (mirrors `getApprovalByCallbackToken`'s
 * own no-workspace-scope rationale: the id itself is a real defense layer).
 *
 * This query itself stays unscoped by design — it returns the row for ANY
 * valid id, same as always. The caller-identity cross-check (issue #1295,
 * PR ③: the row's own `eveSessionId` must match the caller-supplied one)
 * lives in the ROUTE, not here, because that's where the caller-supplied
 * value is available to compare against. See the route's own doc-comment.
 */
export async function getApprovalById(
  id: string
): Promise<JaceApprovalRow | null> {
  const [row] = await db
    .select()
    .from(jaceApprovals)
    .where(eq(jaceApprovals.id, id))
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

/**
 * Outcome of {@link stampPublishedIssueUrl}:
 *  - `"stamped"`: this call wrote it — either the FIRST stamp, or an
 *    idempotent replay of the exact same url (a retried tool-side call, or a
 *    network blip after a stamp that actually landed).
 *  - `"not_approved"`: the approval doesn't exist, or its `status` is not
 *    `"approved"` (still pending, denied, or expired) — an approval can only
 *    ever be stamped once a human has actually approved it.
 *  - `"conflict"`: the approval IS approved, but `published_issue_url`
 *    already holds a DIFFERENT non-null value. Should never legitimately
 *    happen (one approval produces at most one issue) — never silently
 *    overwritten; the caller logs this loudly.
 */
export type StampPublishedIssueUrlOutcome = "stamped" | "not_approved" | "conflict";

/**
 * Atomically stamp the REAL GitHub issue URL a `create_issue` tool call
 * produced onto its own (already-approved) approval row (#1274 PR ②'s
 * chat-born one-confirm collapse). This is what lets `github_intake.ts`'s
 * confirmed-brief lookup recognize the SAME issue arriving later via the
 * label webhook and admit it straight to `queued` with the sanctioned
 * budget/model, instead of parking it for a second, redundant alignment
 * confirm.
 *
 * Guarded `WHERE status = 'approved'`: an approval that was never approved
 * (still pending, denied, or expired) can never be stamped — mirrors every
 * other approval-lifecycle write in this file (`confirmAlignmentBrief`/
 * `denyAlignmentBrief` in `github_intake.ts` guard `WHERE state = 'parked'`
 * the same way). The `published_issue_url IS NULL OR = publishedIssueUrl`
 * half of the guard makes a re-stamp of the IDENTICAL value a no-op success
 * (idempotent replay) while refusing to silently overwrite a DIFFERENT
 * already-stamped value — the zero-rows-matched case is then disambiguated
 * with a follow-up read (rather than trusting a caller's possibly-stale
 * pre-check) so the two distinct failure reasons — never approved vs. a real
 * conflict — are reported accurately even under a race.
 */
export async function stampPublishedIssueUrl(
  id: string,
  publishedIssueUrl: string
): Promise<StampPublishedIssueUrlOutcome> {
  const updated = await db
    .update(jaceApprovals)
    .set({ publishedIssueUrl })
    .where(
      and(
        eq(jaceApprovals.id, id),
        eq(jaceApprovals.status, "approved"),
        sql`(${jaceApprovals.publishedIssueUrl} IS NULL OR ${jaceApprovals.publishedIssueUrl} = ${publishedIssueUrl})`
      )
    )
    .returning({ id: jaceApprovals.id });
  if (updated.length > 0) return "stamped";

  const [row] = await db
    .select({
      status: jaceApprovals.status,
      publishedIssueUrl: jaceApprovals.publishedIssueUrl,
    })
    .from(jaceApprovals)
    .where(eq(jaceApprovals.id, id))
    .limit(1);
  if (!row || row.status !== "approved") return "not_approved";
  return "conflict";
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
