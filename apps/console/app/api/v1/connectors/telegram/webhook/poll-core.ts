/**
 * Inbound Telegram POLLING — PURE batch-processing core (local-dev #889 follow-up).
 *
 * The webhook route (deployed) receives one update at a time over HTTP. On a
 * local box Telegram can't reach us, so a standalone poller long-polls getUpdates
 * and feeds the batch through here. This module is the pure core — no network, no
 * DB, no Next runtime — so the batch logic (reply / skip / advance-offset /
 * swallow-a-bad-update) is unit-testable in isolation.
 *
 * CRUCIALLY it does NOT fork the decision logic: every update is routed through
 * the SAME {@link decideReply} the webhook route uses, so the status/help/auth
 * (chat-id) behavior is identical across both inbound modes. Authorization lives
 * exactly once, inside `decideReply` (incoming chat id must equal the connector's
 * configured chat id) — this layer adds NO second auth path.
 */

import { decideReply, type QueueSnapshotEntry } from "./handler";

/** A raw update from getUpdates — only the fields the poller reads. The message
 * slice matches what `decideReply` expects (untrusted shape, all optional). */
export interface PollUpdate {
  update_id: number;
  message?: { text?: unknown; chat?: { id?: unknown } };
}

/** Sends a reply to the configured chat. Returns nothing useful to the core —
 * the send is best-effort (a failed send must not stop the batch). */
export type SendReply = (text: string) => Promise<void>;

export interface ProcessBatchArgs {
  updates: PollUpdate[];
  /** The connector's configured chat id — the single auth boundary (in decideReply). */
  chatId: string | null | undefined;
  /** The queue snapshot for `/status`, same shape the webhook route passes. */
  snapshot: QueueSnapshotEntry[];
  /** Current resume cursor (last persisted `update_id + 1`), if any. */
  offset?: number;
  send: SendReply;
}

export interface ProcessBatchResult {
  /** The new cursor to persist: max(update_id)+1 over processed updates, or the
   * incoming offset unchanged when the batch was empty. */
  offset: number | undefined;
  /** How many updates triggered an actual reply (for logging/observability). */
  replied: number;
  /** How many updates were processed (advanced the cursor), reply or not. */
  processed: number;
}

/**
 * Process a batch of polled updates. For each update:
 *  - route it through `decideReply` (the SAME logic as the webhook),
 *  - if it returns a non-null reply, `send` it (best-effort — a send throw is
 *    swallowed so one bad send can't drop the rest of the batch or the cursor),
 *  - advance the cursor past it regardless, so it is never reprocessed.
 *
 * A single malformed update never throws: `decideReply` returns null for a bad
 * shape, and any unexpected throw while handling one update is caught so the
 * loop continues. The cursor still advances past a malformed update (it has a
 * numeric update_id) so the poller doesn't get wedged replaying it forever.
 *
 * Never throws. Returns the new offset + counts.
 */
export async function processPollBatch(
  args: ProcessBatchArgs
): Promise<ProcessBatchResult> {
  const { updates, chatId, snapshot, send } = args;
  let offset = args.offset;
  let replied = 0;
  let processed = 0;

  for (const update of updates) {
    // Defensive: a non-numeric update_id can't advance a sane cursor — skip it
    // without touching the offset (getTelegramUpdates already filters these out,
    // belt-and-suspenders for direct callers/tests).
    if (typeof update?.update_id !== "number") continue;

    try {
      const reply = decideReply(update, chatId, snapshot);
      if (reply) {
        // Best-effort send; a transport throw must not abort the batch.
        await send(reply).catch(() => undefined);
        replied += 1;
      }
    } catch {
      // A defensive catch for any unexpected throw decideReply might surface on
      // a pathological shape — never let one update crash the loop.
    }

    // Advance past this update so a restart resumes after it (Telegram drops
    // confirmed updates when the next getUpdates sends offset = max+1).
    const next = update.update_id + 1;
    if (offset === undefined || next > offset) offset = next;
    processed += 1;
  }

  return { offset, replied, processed };
}
