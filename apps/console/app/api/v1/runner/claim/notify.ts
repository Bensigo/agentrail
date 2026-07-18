/**
 * Workspace monthly-budget-ceiling chat notice (issue #1269 PR ②a).
 *
 * Fired from the claim route the moment `markBudgetExhaustedNotified`
 * atomically flips the workspace's dedup column for the CURRENT period (see
 * that function's own doc-comment in `@agentrail/db-postgres` for the whole
 * race-safety argument) — this module only sends, it never decides WHETHER
 * to. The caller wraps the call in its own try/catch, matching this route's
 * existing best-effort idioms (the MCP-key and GitHub-token fetches just
 * above it): a chat-send hiccup must never fail the claim response.
 *
 * Uses the #1262 system-message path (`sendSystemTelegramMessage`, the
 * shared hosted-bot sender Jace's multi-workspace disambiguation ask + pin
 * confirmation already use for non-model, workspace-scoped system sends) —
 * NOT `runner/result/notify.ts`'s per-run-outcome fan-out, whose Telegram leg
 * resolves its destination from the LEGACY per-workspace `connectors` row
 * (the pre-#1262 BotFather setup). A workspace's actual bound Telegram chat
 * today lives in `jace_sessions` (the shared-bot session ledger), so this
 * resolves through `latestTelegramSessionForWorkspace` instead. No session
 * bound yet (or a Discord/Slack/iMessage-only workspace) is a silent no-op:
 * v1 ships Telegram only, matching `sendSystemTelegramMessage`'s own scope.
 */
import { latestTelegramSessionForWorkspace } from "@agentrail/db-postgres";
import { sendSystemTelegramMessage } from "../../../../../lib/telegram-system-message";

/**
 * Plain-text (no markdown, no secrets, no links) ceiling-hit notice: the
 * month's spend vs the ceiling, and that new work is paused until it's
 * raised.
 */
export function buildBudgetExhaustedMessage(
  spendUsd: number,
  ceilingUsd: number
): string {
  return (
    `AgentRail: monthly budget reached — $${spendUsd.toFixed(2)} spent of ` +
    `$${ceilingUsd.toFixed(2)}. New work is paused until the ceiling is raised.`
  );
}

/**
 * Post the ceiling-hit notice into the workspace's most recently active
 * Telegram session. Does nothing when the workspace has none bound.
 */
export async function notifyWorkspaceBudgetExhausted(
  workspaceId: string,
  spendUsd: number,
  ceilingUsd: number
): Promise<void> {
  const session = await latestTelegramSessionForWorkspace(workspaceId);
  if (!session) return;
  const result = await sendSystemTelegramMessage(
    session.conversationKey,
    buildBudgetExhaustedMessage(spendUsd, ceilingUsd)
  );
  if (!result.ok) {
    // sendSystemTelegramMessage NEVER throws for a known failure (missing
    // TELEGRAM_BOT_TOKEN, a blocked bot, a network error) — it resolves a
    // typed { ok: false, error }, so the route's try/catch can never see it.
    // The CAS already flipped budget_exhausted_notified_period BEFORE this
    // send, so a swallowed typed failure would permanently mark the period
    // notified with zero trace — log it here (the route's catch only covers
    // contract-violating throws).
    console.error(
      "[runner/claim] budget-exhausted notice send failed:",
      result.error
    );
  }
}
