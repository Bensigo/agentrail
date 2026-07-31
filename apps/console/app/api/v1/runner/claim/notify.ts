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
import { sendSystemDiscordMessage } from "../../../../../lib/discord-system-message";

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

/**
 * Monthly engineering-capacity gate chat notices (subscription platform spec
 * §6 point 2 / §7) — the sibling of `notifyWorkspaceBudgetExhausted` above,
 * for the ACCOUNT-wide capacity gate at this same claim route (`route.ts`'s
 * `maybeNotifyCapacity`, which owns the CAS decision via
 * `recordUpgradePromptOnce`; this module only sends, same division of labor
 * as the budget notice's `markBudgetExhaustedNotified`/
 * `notifyWorkspaceBudgetExhausted` split above). Two kinds, two byte-exact
 * product-copy messages (spec §7 — no dollars, no model names, no "budget",
 * ever): `"capacity"` fires once the account has used 100% of
 * `policy.monthlyCapacity` for the month (new tasks pause); `"capacity_warning"`
 * fires once at >=80% (the claim still proceeds — advance notice, not a
 * block).
 *
 * Delivery is CHAT-CHANNEL-GENERAL (telegram/discord/slack in principle),
 * unlike `notifyWorkspaceBudgetExhausted`'s telegram-only v1 scope. Unlike
 * that function, this module does NOT itself resolve
 * `latestChatSessionForWorkspace` — see `notifyAccountCapacity`'s own
 * doc-comment for why the caller resolves it instead and passes it in.
 */

/**
 * Byte-exact product copy (spec §7): the 100%-of-monthly-capacity hard-pause
 * notice. Capacity reads as engineering tasks, never billing internals — no
 * dollars, no model names, no "budget".
 */
export function buildCapacityPausedMessage(): string {
  return (
    "You've used your included monthly engineering capacity. Upgrade to " +
    "Growth for additional capacity and premium reasoning."
  );
}

/**
 * Byte-exact product copy: the one-per-month heads-up fired at >=80% of
 * monthly capacity (still under 100%). The claim proceeds; this is advance
 * notice, not a block.
 */
export function buildCapacityWarningMessage(): string {
  return (
    "Heads up: your team has used 80% of its included monthly engineering " +
    "capacity. Upgrade to Growth for additional capacity and premium reasoning."
  );
}

/**
 * Deliver a capacity notice into `session` (the workspace's most recently
 * active chat session — telegram/discord/slack). Pure delivery — the CAS
 * that decides WHETHER to call this lives in `route.ts`'s
 * `maybeNotifyCapacity`; this function fires unconditionally whenever its
 * caller has already won that CAS, matching `notifyWorkspaceBudgetExhausted`'s
 * own division of labor above.
 *
 * `session` is a caller-resolved value, NOT re-resolved here (review round 1
 * fix): the original version called `latestChatSessionForWorkspace(workspaceId)`
 * itself, a SECOND independent read of the exact same lookup
 * `maybeNotifyCapacity` had already performed moments earlier to build the
 * CAS row's `conversationKey`/`channel`, with `recordUpgradePromptOnce`'s
 * write sitting between the two reads. A session-activity change in that gap
 * (e.g. a message lands on a different bound channel between the CAS read
 * and this one) could make the persisted `upgrade_prompt_events` row — spec
 * §8's calibration input — misrepresent where the prompt actually went, AND
 * could let a LATER poll's CAS win again under a different conversationKey
 * (the session having since changed again), producing a duplicate same-day
 * prompt the CAS exists specifically to prevent. Taking the already-resolved
 * `session` as a parameter instead closes that window: one read, used for
 * both the CAS row and the delivery target, guaranteed identical.
 *
 * `null` (no session bound, or `maybeNotifyCapacity` resolved one but is
 * intentionally still calling this — see that function's own doc-comment on
 * why the sentinel CAS is recorded even with no session) -> silent no-op,
 * same as `notifyWorkspaceBudgetExhausted` above.
 *
 * discord: the PLAIN bot sender (`sendSystemDiscordMessage`), never
 * `sendSystemDiscordMessagePreferFollowup` — there is no interaction-followup
 * credential in this async claim-route context (no live inbound webhook turn
 * backs this call), so a private-channel delivery failure is possible and is
 * logged, best-effort, same as every other typed failure below.
 *
 * slack: SKIPPED, always, logged loudly with the `[capacity-notify]` prefix
 * rather than attempted. `sendSystemSlackMessage` is team-scoped — it needs
 * the SENDING team's own `teamId` to resolve that team's installation/bot
 * token (`lib/slack-system-message.ts`'s own header doc: "FAIL LOUD, NEVER
 * FALL BACK"). Every existing caller of that sender gets `teamId` from a
 * LIVE inbound turn's already-verified `payload.teamId`
 * (`channel-dispatch.ts`'s `TelegramInboxPayload.teamId` /
 * `deliverSeatLimitPromptForChatRow`) — turn-scoped, in-memory ambient data
 * carried through `auth.attributes` for that ONE dispatch, never persisted
 * anywhere durable. `latestChatSessionForWorkspace` (what resolved `session`
 * below) reads `jace_sessions`, which has no team-id column, and no other
 * workspace-keyed table maps to one either (`slack_installations` is keyed BY
 * `team_id`, with no reverse workspace lookup) — so there is no supported way
 * to recover a team id in this claim-route context, which backs no live
 * turn/payload at all. Slack's `conversationKey` does happen to be internally
 * prefixed `${teamId}:...` (`lib/slack-thread.ts`'s `resolveSlackThread`),
 * but no caller anywhere in this codebase treats that as a parseable public
 * contract — every real send threads `teamId` explicitly instead — so
 * parsing it back out here would be exactly the kind of guess this function
 * must not make.
 */
export async function notifyAccountCapacity(
  workspaceId: string,
  kind: "capacity" | "capacity_warning",
  session: { channel: string; conversationKey: string } | null
): Promise<void> {
  if (!session) return;

  const text =
    kind === "capacity" ? buildCapacityPausedMessage() : buildCapacityWarningMessage();

  let result;
  if (session.channel === "discord") {
    result = await sendSystemDiscordMessage(session.conversationKey, text);
  } else if (session.channel === "telegram") {
    result = await sendSystemTelegramMessage(session.conversationKey, text);
  } else if (session.channel === "slack") {
    console.error(
      `[capacity-notify] no derivable Slack team id for workspace ${workspaceId} — skipping capacity notice delivery`
    );
    return;
  } else {
    // Defensive only: latestChatSessionForWorkspace's own query already
    // filters to telegram/discord/slack, but its return type is a plain
    // `string`, not a literal union — a future channel added to that
    // IN-list without a corresponding sender branch here degrades to a
    // loud skip rather than a crash or a silently wrong send.
    console.error(
      `[capacity-notify] unrecognized chat channel "${session.channel}" for workspace ${workspaceId} — skipping capacity notice delivery`
    );
    return;
  }

  if (!result.ok) {
    // Same reasoning as notifyWorkspaceBudgetExhausted's own log above: both
    // senders return a typed failure rather than throwing, so without this
    // log a swallowed failure would vanish with zero trace — the CAS
    // (route.ts's recordUpgradePromptOnce call, inside maybeNotifyCapacity)
    // already burned the slot before this function was ever called.
    console.error(
      `[runner/claim] capacity notice send failed (${kind}, ${session.channel}):`,
      result.error
    );
  }
}
