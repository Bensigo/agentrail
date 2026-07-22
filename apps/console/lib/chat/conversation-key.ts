/**
 * The console chat `conversation_key` convention (redesign spec §4 Chat):
 * `console:<userId>:<n>` — per-member PRIVATE threads scoped to one
 * workspace (two different members in the same workspace never share a
 * thread; `jace_messages` rows are additionally scoped to `workspace_id`, so
 * the same user in two different workspaces also never shares one).
 *
 * `n` is reserved for a future multi-thread-per-member UI (the spec's
 * "thread list"); this PR ships exactly one persistent thread per member —
 * `n = 1`, always — so `/chat` is a single running conversation, not a
 * thread picker. Bumping `n` later (a "new conversation" affordance) is
 * additive: existing `console:<userId>:1` rows are untouched by it.
 */
export const CONSOLE_CHAT_THREAD_N = 1;

export function consoleConversationKey(userId: string, n: number = CONSOLE_CHAT_THREAD_N): string {
  return `console:${userId}:${n}`;
}
