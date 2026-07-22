/**
 * Pure client-side helpers for the console chat thread (#1288). No I/O — the
 * polling client (`chat-thread.tsx`) does the fetching; this is the one bit
 * of logic worth unit testing in isolation (mirrors this codebase's split
 * for every other pure derivation module, e.g. `onboarding-steps.ts`,
 * `budget/budget-helpers.ts`).
 */

export type ChatMessageRole = "user" | "jace";

export interface ChatMessage {
  id: string;
  seq: number;
  role: ChatMessageRole;
  text: string;
  created_at: string;
}

export interface ChatApproval {
  id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  created_at: string;
}

/**
 * Merge a poll's `incoming` messages into `existing`, de-duplicating by
 * `seq` (a re-poll can legitimately re-send a message the client already
 * has — e.g. a retried request) and keeping the result ascending by `seq` so
 * the thread always reads top-to-bottom, oldest first.
 */
export function mergeChatMessages(
  existing: ChatMessage[],
  incoming: ChatMessage[]
): ChatMessage[] {
  const bySeq = new Map(existing.map((m) => [m.seq, m]));
  for (const m of incoming) bySeq.set(m.seq, m);
  return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
}

/** The `after_seq` cursor for the NEXT poll: the highest `seq` rendered so far, or 0 for a fresh thread. */
export function highestSeq(messages: ChatMessage[]): number {
  return messages.reduce((max, m) => Math.max(max, m.seq), 0);
}
