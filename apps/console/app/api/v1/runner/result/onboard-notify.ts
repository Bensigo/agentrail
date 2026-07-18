/**
 * Onboard-completion chat notice (issue #1268 PR ②).
 *
 * `recordRunnerResult` (and this route) are entirely kind-agnostic — an
 * onboard queue row rides the exact same terminal-state machine as an issue
 * row (green / escalated-to-human / blocked). Riding `notifyRunOutcome`
 * unmodified for an onboard result would send the issue-shaped message
 * verbatim: `"AgentRail: PR ready — issue #"` with an EMPTY issue number
 * (onboard's `external_id` is `onboard:<owner/name>`, no trailing digits) and
 * a nonsensical "PR ready" headline — onboarding never opens a PR. So this
 * module is the onboard-kind sibling of that notify, picked at the SAME
 * existing terminal-state call site in `route.ts` (see `onboardRepoFullName`,
 * the single detection point the route branches on) — never a second
 * terminal-state check, never a second trigger.
 *
 * Destination is deliberately NOT `notifyRunOutcome`'s per-workspace
 * `connectors` row (the legacy pre-#1262 BotFather setup, and multi-channel:
 * Telegram/Discord/Slack/iMessage). This is a single, workspace-scoped,
 * Telegram-only notice into the conversation the workspace is actually bound
 * to right now — the same `#1269 PR②a` precedent
 * (`claim/notify.ts`'s `notifyWorkspaceBudgetExhausted`) uses:
 * `latestTelegramSessionForWorkspace` (the `jace_sessions` ledger) +
 * `sendSystemTelegramMessage` (the shared hosted-bot sender). "The workspace
 * hears about it in-thread" means the thread it's actually talking to Jace
 * in, not a separate legacy connector most message-first-door workspaces
 * never configured.
 *
 * BEST-EFFORT, matching every sender in this family: a typed send failure is
 * logged, never thrown; a session-lookup failure PROPAGATES (the caller's
 * existing try/catch around the terminal-state notify hook owns swallowing
 * it, same division of responsibility as `notifyWorkspaceBudgetExhausted`).
 * No bound conversation is a LOGGED no-op — never an error — since silence
 * here would otherwise be invisible.
 */
import {
  latestTelegramSessionForWorkspace,
  ONBOARD_EXTERNAL_ID_PREFIX,
} from "@agentrail/db-postgres";
import { sendSystemTelegramMessage } from "../../../../../lib/telegram-system-message";
import type { NotifyOutcome } from "./notify";

/**
 * Onboard entries encode their repo as `onboard:<owner/name>` — the prefix is
 * NOT a local literal but the writer's own `ONBOARD_EXTERNAL_ID_PREFIX`
 * (exported next to `enqueueOnboard` in `@agentrail/db-postgres`), so this
 * reader can never silently drift from what the enqueue actually writes; the
 * round-trip test beside this file pins the composed pair. This is the SINGLE
 * detection point the route branches on: no `kind` column read, no extra
 * query — the queue entry's own `external_id`, already in hand from
 * `recordRunnerResult`'s return, is sufficient. Returns the repo full name
 * for an onboard-kind external id, else `null` (an issue-kind external id —
 * a full issue URL or `owner/name#123`).
 */
export function onboardRepoFullName(externalId: string): string | null {
  return externalId.startsWith(ONBOARD_EXTERNAL_ID_PREFIX)
    ? externalId.slice(ONBOARD_EXTERNAL_ID_PREFIX.length)
    : null;
}

/**
 * Build the one-line chat message. Pure + exported so it is unit-testable,
 * matching `buildOutcomeMessage`'s own shape in `./notify`.
 *
 * green            → honest, names the repo, invites codebase questions.
 * escalated-to-human / blocked → honest "didn't finish", no retry theater:
 *   never implies a retry is coming, since none is — the row has left the
 *   queue for good.
 */
export function buildOnboardOutcomeMessage(
  repoFullName: string,
  outcome: NotifyOutcome
): string {
  if (outcome === "green") {
    return (
      `AgentRail: repo indexed — ${repoFullName}. Ask me anything about its ` +
      `conventions, architecture, or build/test commands.`
    );
  }
  return (
    `AgentRail: onboarding didn't finish for ${repoFullName}. No more ` +
    `automatic retries — this needs a human to pick it up.`
  );
}

/**
 * Post the onboard-completion notice into the workspace's most recently
 * active Telegram session. Does nothing (logged) when the workspace has no
 * session bound — v1 ships Telegram only, matching
 * `sendSystemTelegramMessage`'s own scope.
 */
export async function notifyOnboardOutcome(
  workspaceId: string,
  repoFullName: string,
  outcome: NotifyOutcome
): Promise<void> {
  const session = await latestTelegramSessionForWorkspace(workspaceId);
  if (!session) {
    console.log(
      `[runner/result] onboard-complete notice: no bound conversation for workspace ${workspaceId}, skipping`
    );
    return;
  }
  const result = await sendSystemTelegramMessage(
    session.conversationKey,
    buildOnboardOutcomeMessage(repoFullName, outcome)
  );
  if (!result.ok) {
    // sendSystemTelegramMessage never throws for a known failure — log it here
    // (mirrors notifyWorkspaceBudgetExhausted) so a swallowed typed failure
    // isn't silently invisible.
    console.error(
      "[runner/result] onboard-complete notice send failed:",
      result.error
    );
  }
}
