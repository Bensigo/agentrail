import { and, asc, eq, gt } from "drizzle-orm";
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
