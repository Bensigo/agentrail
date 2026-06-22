/**
 * Inbound Telegram webhook — PURE decision logic (#889).
 *
 * Telegram is otherwise outbound-only; this is the inbound half. The route does
 * the I/O (parse the update, authorize the secret-token header, fetch the queue
 * snapshot, send the reply). This module is the pure core: given a parsed update
 * + the workspace's connected `chatId` + a queue snapshot, it decides the reply
 * text (or null = stay silent). Keeping it pure makes the behavior unit-testable
 * with no HTTP and no DB.
 *
 * Decisions:
 *  - chat-id mismatch → null. A bot can be added to other chats; we only ever
 *    answer the workspace's connected chat, so a stranger can't read the queue
 *    (AC3 — no data leak).
 *  - `/status` (or a plain "status" / a question) → the queue snapshot (AC2).
 *  - anything else → a short help message (AC4).
 *  - malformed / empty update → null, no throw (AC5).
 */

/** The slice of a Telegram `Update` we read. Everything is optional + defensive. */
export interface TelegramUpdate {
  message?: {
    text?: unknown;
    chat?: { id?: unknown };
  };
}

/** A queue entry as `listQueueEntries` returns it (only the fields we use). */
export interface QueueSnapshotEntry {
  externalId: string;
  state: string;
}

/** The issue number for an external id (trailing digits), or "?" when none. */
function issueNumberOf(externalId: string): string {
  const m = String(externalId ?? "").match(/(\d+)\s*$/);
  return m ? m[1]! : "?";
}

/** Up to `n` issue numbers for entries in `state`, newest first (snapshot order). */
function issuesIn(
  snapshot: QueueSnapshotEntry[],
  state: string,
  n = 3
): string[] {
  return snapshot
    .filter((e) => e.state === state)
    .slice(0, n)
    .map((e) => `#${issueNumberOf(e.externalId)}`);
}

/** Build the status reply from a queue snapshot (counts + latest issue numbers). */
function buildStatusReply(snapshot: QueueSnapshotEntry[]): string {
  const running = snapshot.filter((e) => e.state === "running");
  const queued = snapshot.filter((e) => e.state === "queued");
  const escalated = snapshot.filter(
    (e) => e.state === "escalated-to-human"
  );

  const lines = [
    `AgentRail queue: ${running.length} running · ${queued.length} queued · ${escalated.length} escalated`,
  ];
  const runningIssues = issuesIn(snapshot, "running");
  const queuedIssues = issuesIn(snapshot, "queued");
  const escalatedIssues = issuesIn(snapshot, "escalated-to-human");
  if (runningIssues.length) lines.push(`Running: ${runningIssues.join(", ")}`);
  if (queuedIssues.length) lines.push(`Queued: ${queuedIssues.join(", ")}`);
  if (escalatedIssues.length)
    lines.push(`Escalated: ${escalatedIssues.join(", ")}`);
  if (!running.length && !queued.length && !escalated.length) {
    lines.push("Nothing in the queue right now.");
  }
  return lines.join("\n");
}

const HELP_REPLY =
  "AgentRail bot. I can answer:\n" +
  "• /status — current run/queue snapshot (running, queued, escalated)\n" +
  "I post run completions and escalations here automatically.";

/** Is `text` a status request? `/status`, a bare "status", or a "?" question. */
function isStatusRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t === "/status" || t.startsWith("/status@")) return true;
  if (t === "status") return true;
  // A short natural-language status question ("what's the status?", "queue?").
  if (/\bstatus\b/.test(t)) return true;
  if (/\bqueue\b/.test(t)) return true;
  return false;
}

/**
 * Decide the reply for an inbound update. Returns the reply text, or null to
 * stay silent (chat mismatch / malformed / nothing to say).
 *
 * @param update     the parsed Telegram update (untrusted shape)
 * @param chatId     the workspace's connected chat id (from connector config);
 *                   null/undefined when the connector has no chat id → silent.
 * @param snapshot   the workspace's queue entries (active + recent terminals)
 */
export function decideReply(
  update: TelegramUpdate | null | undefined,
  chatId: string | null | undefined,
  snapshot: QueueSnapshotEntry[]
): string | null {
  // AC5: malformed / empty update → no reply, no throw.
  const message = update?.message;
  if (!message || typeof message !== "object") return null;

  const incomingChatId = message.chat?.id;
  if (incomingChatId === undefined || incomingChatId === null) return null;

  // AC3: only ever answer the workspace's connected chat. A missing configured
  // chatId means the channel isn't fully connected — stay silent.
  if (!chatId) return null;
  if (String(incomingChatId) !== String(chatId)) return null;

  const text = typeof message.text === "string" ? message.text : "";
  if (!text.trim()) {
    // A non-text message (sticker/photo) from the right chat → help, not silence,
    // so the user learns what the bot does.
    return HELP_REPLY;
  }

  if (isStatusRequest(text)) {
    return buildStatusReply(snapshot);
  }

  // AC4: anything else → help.
  return HELP_REPLY;
}
