import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  jaceMessages,
  type JaceMessageRole,
  type JaceMessageRow,
} from "../schema/jace_messages.js";

/**
 * Console chat message queries (issue #1288; see `schema/jace_messages.ts`
 * for the table shape and the WHY behind the design).
 *
 * Two entry points, matching the two writers of this table:
 *
 *  - `appendJaceMessage` — used by BOTH the console's send endpoint (writes
 *    the member's own `role: "user"` row synchronously, before Jace ever
 *    replies, so it renders immediately) AND the worker/dispatch path once an
 *    Eve turn completes (`role: "jace"`, mirroring every other channel's
 *    reply mechanism — see `apps/jace/agent/channels/console.ts`).
 *  - `listJaceMessagesSince` — the one read path, used both for the initial
 *    thread load (`afterSeq` omitted / 0) and every subsequent poll
 *    (`afterSeq` = the highest `seq` the client has already rendered).
 */

export interface AppendJaceMessageInput {
  workspaceId: string;
  conversationKey: string;
  role: JaceMessageRole;
  text: string;
}

/** Append one message to a console chat thread. Returns the inserted row (with its assigned `seq`). */
export async function appendJaceMessage(
  input: AppendJaceMessageInput
): Promise<JaceMessageRow> {
  const [row] = await db
    .insert(jaceMessages)
    .values({
      workspaceId: input.workspaceId,
      conversationKey: input.conversationKey,
      role: input.role,
      text: input.text,
    })
    .returning();

  if (!row) {
    // Unreachable in practice — a bare INSERT ... RETURNING always yields
    // exactly one row. Fail loudly rather than return an invented shape.
    throw new Error("appendJaceMessage: insert returned no row");
  }
  return row;
}

const DEFAULT_LIST_LIMIT = 200;

/**
 * List messages in a conversation with `seq` strictly greater than
 * `afterSeq`, ascending — the initial load (`afterSeq = 0`, the default)
 * returns the whole thread (bounded by `limit`); every subsequent poll passes
 * the highest `seq` already rendered so only new rows come back.
 */
export async function listJaceMessagesSince(
  workspaceId: string,
  conversationKey: string,
  afterSeq = 0,
  limit = DEFAULT_LIST_LIMIT
): Promise<JaceMessageRow[]> {
  return db
    .select()
    .from(jaceMessages)
    .where(
      and(
        eq(jaceMessages.workspaceId, workspaceId),
        eq(jaceMessages.conversationKey, conversationKey),
        gt(jaceMessages.seq, afterSeq)
      )
    )
    .orderBy(asc(jaceMessages.seq))
    .limit(limit);
}

/**
 * One row per console chat THREAD a member owns (issue #1288 sessions +
 * history UI). A "thread" is a distinct `n` in this member's own
 * `console:<userId>:<n>` conversation-key family — the multi-thread-per-member
 * UI the `conversation_key` convention (`lib/chat/conversation-key.ts`)
 * reserved `n` for. Nothing new is stored: threads are DERIVED from the
 * `jace_messages` rows that already exist (an empty, never-messaged thread is
 * purely client-side state until its first send materializes a row here —
 * matching ChatGPT, where a brand-new empty chat isn't in history yet), so
 * this feature needs no schema change.
 */
export interface ConsoleChatThread {
  /** The `<n>` in `console:<userId>:<n>` — the thread's stable id for this member. */
  n: number;
  /** First `user`-role message text (truncated), or "New chat" when a thread somehow has only a Jace row. */
  title: string;
  /** Most recent message timestamp in the thread — the sort key (desc). */
  lastMessageAt: Date;
  /** Total messages (both roles) in the thread. */
  messageCount: number;
}

/** Longest thread title we surface in the history list before truncating with an ellipsis. */
const THREAD_TITLE_MAX_CHARS = 60;

/** Escape LIKE wildcards in a value used as a literal prefix (see listConsoleChatThreads). */
function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Derive a thread title from its first user message, capped + ellipsized, falling back to "New chat". */
function threadTitle(firstUserText: string | null): string {
  const trimmed = (firstUserText ?? "").trim();
  if (!trimmed) return "New chat";
  if (trimmed.length <= THREAD_TITLE_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, THREAD_TITLE_MAX_CHARS - 1)}…`;
}

/**
 * List one member's OWN console chat threads in this workspace, newest
 * activity first. A thread == a distinct `n` in `console:<userId>:<n>`; the
 * title is that thread's first `user` message (truncated), and each row
 * carries its `lastMessageAt` + total `messageCount`.
 *
 * `userId` MUST be the server session's own user id (never a client param) —
 * the `console:<userId>:%` prefix is the tenant boundary, exactly as the chat
 * route already scopes its per-member read with `consoleConversationKey`. The
 * prefix's wildcards are escaped so a user id containing `_`/`%` (none do
 * today — they're cuid/uuid) could never widen the match to another member.
 *
 * One SQL round trip: a GROUP BY over the member's own keys for the
 * count/last-activity, LEFT JOIN LATERAL to the thread's earliest user
 * message for the title. `n` is parsed OUT of the key in application code
 * (stripping the exact `console:<userId>:` prefix) rather than in SQL, and a
 * key whose suffix isn't a positive integer is skipped defensively.
 */
export async function listConsoleChatThreads(
  workspaceId: string,
  userId: string
): Promise<ConsoleChatThread[]> {
  const prefix = `console:${userId}:`;
  const likePattern = `${escapeLikeLiteral(prefix)}%`;

  const result = await db.execute(sql`
    SELECT
      t.conversation_key AS conversation_key,
      t.message_count AS message_count,
      t.last_message_at AS last_message_at,
      first_user.text AS first_user_text
    FROM (
      SELECT
        conversation_key,
        COUNT(*)::int AS message_count,
        MAX(created_at) AS last_message_at
      FROM jace_messages
      WHERE workspace_id = ${workspaceId}
        AND conversation_key LIKE ${likePattern} ESCAPE '\\'
      GROUP BY conversation_key
    ) t
    LEFT JOIN LATERAL (
      SELECT text
      FROM jace_messages m
      WHERE m.workspace_id = ${workspaceId}
        AND m.conversation_key = t.conversation_key
        AND m.role = 'user'
      ORDER BY m.seq ASC
      LIMIT 1
    ) first_user ON true
    ORDER BY t.last_message_at DESC
  `);

  const threads: ConsoleChatThread[] = [];
  for (const raw of Array.from(result) as Record<string, unknown>[]) {
    const conversationKey = String(raw.conversation_key);
    if (!conversationKey.startsWith(prefix)) continue;
    const suffix = conversationKey.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    const n = Number(suffix);
    if (!Number.isInteger(n) || n <= 0) continue;

    // `db.execute` (raw SQL) returns the aggregate timestamp as a STRING — the
    // driver's per-column Date parsers only apply through the query BUILDER
    // (`db.select`), not a raw execute. Coerce so the return type is honestly a
    // Date (a Date instance passes through untouched — the unit tests inject
    // Dates directly).
    const lastRaw = raw.last_message_at;
    const lastMessageAt =
      lastRaw instanceof Date ? lastRaw : new Date(String(lastRaw));

    threads.push({
      n,
      title: threadTitle((raw.first_user_text as string | null) ?? null),
      lastMessageAt,
      messageCount: Number(raw.message_count ?? 0),
    });
  }
  return threads;
}

/**
 * Whether Jace has ever replied in ANY console conversation for this
 * workspace — the onboarding wizard's "Say hi to Jace" step (#1288 AC3,
 * spec §5 step 3) derives its completion from exactly this: a
 * `jace_messages` row with `role: "jace"` existing at all means a member got
 * a real reply, workspace-wide (not scoped to one member's own thread —
 * "someone said hi and Jace answered" is the signal, not "this specific
 * user did").
 */
export async function hasAnyJaceReply(workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: jaceMessages.id })
    .from(jaceMessages)
    .where(and(eq(jaceMessages.workspaceId, workspaceId), eq(jaceMessages.role, "jace")))
    .limit(1);
  return Boolean(row);
}
