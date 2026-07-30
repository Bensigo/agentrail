import type { Db } from "../db.js";
import { upgradePromptEvents } from "../schema/upgrade_prompt_events.js";

/**
 * Upgrade-prompt CAS dedup (spec
 * docs/superpowers/specs/2026-07-29-subscription-platform-design.md §6
 * "Enforcement seams" — "Prompt cooldown"; see
 * `schema/upgrade_prompt_events.ts` for the table shape and the WHY behind
 * the append-only, presence-is-the-answer design). This is the insert-based
 * CAS twin of `markBudgetExhaustedNotified`
 * (`queries/workspace_budget.ts:103-118`): "did we already prompt THIS
 * conversation THIS period" is answered by whether THIS call's own INSERT
 * won the race against the unique index on (billing_account_id, kind,
 * conversation_key, period_key) (`upgrade_prompt_dedup_idx`), never by a
 * separate read-then-write — the same race-immunity `claimSeat`'s `ON
 * CONFLICT DO NOTHING` gives (`seats.ts`), just insert-based rather than
 * update-based since there is no pre-existing row to flip.
 *
 * `db` is an explicit parameter, matching `seats.ts`/`billing_accounts.ts`'s
 * convention (a plain captured-SQL mock at the call site, no
 * `vi.mock("../db.js")`) — but unlike those two raw-SQL modules, this uses
 * the fluent Drizzle builder chain directly: `ON CONFLICT (...) DO NOTHING
 * ... RETURNING` needs no hand-written SQL text to express, and the target
 * column list reads more safely as real schema-column references (so a
 * rename or reorder of `upgrade_prompt_events`'s columns is a compile error
 * here, not a silently-stale string).
 */

/**
 * Insert an upgrade-prompt event; returns `true` only when THIS call's own
 * insert is the one that landed a new row for this exact (billingAccountId,
 * kind, conversationKey, periodKey) quadruple — `false` when a prior call
 * (this one included, on a retry) already occupies that slot. The caller
 * MUST deliver the upgrade prompt iff this returns `true`, and MUST stay
 * silent on `false` — the same "only the winner acts" contract
 * `markBudgetExhaustedNotified` documents, so two concurrent blocked turns
 * in the same conversation can never both fire the nudge.
 *
 * `channel` is recorded (audit trail / spec §8 calibration input) but
 * DELIBERATELY sits OUTSIDE the four-column dedup key: the same conversation
 * reached from two different channels within one period still dedupes to
 * ONE prompt, not one per channel — widening the key to include `channel`
 * would defeat that.
 */
export async function recordUpgradePromptOnce(
  db: Db,
  args: {
    billingAccountId: string;
    kind: "seat_limit" | "capacity" | "capacity_warning";
    conversationKey: string;
    channel: string;
    periodKey: string;
  }
): Promise<boolean> {
  const rows = await db
    .insert(upgradePromptEvents)
    .values({
      billingAccountId: args.billingAccountId,
      kind: args.kind,
      conversationKey: args.conversationKey,
      channel: args.channel,
      periodKey: args.periodKey,
    })
    .onConflictDoNothing({
      target: [
        upgradePromptEvents.billingAccountId,
        upgradePromptEvents.kind,
        upgradePromptEvents.conversationKey,
        upgradePromptEvents.periodKey,
      ],
    })
    .returning({ id: upgradePromptEvents.id });

  return rows.length > 0;
}
