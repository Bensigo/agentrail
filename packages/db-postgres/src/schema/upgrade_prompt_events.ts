import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { billingAccounts } from "./billing_accounts.js";

/**
 * Upgrade prompt dedup + audit trail (spec
 * docs/superpowers/specs/2026-07-29-subscription-platform-design.md §6
 * "Enforcement seams" — the prompt cooldown — and §8 "Internal ops", where
 * this table doubles as calibration input for the monthly capacity/AI-budget
 * review). Mirrors the CAS-dedup pattern of `markBudgetExhaustedNotified`
 * (`packages/db-postgres/src/queries/workspace_budget.ts:103-118`): at most
 * one upgrade prompt per `(billing_account, kind, conversation, day)`, so
 * two concurrent blocked turns in the same conversation can never both fire
 * the nudge.
 *
 * Append-only, like `seats` and `wallet_transactions` — no mutable counter,
 * ever (spec §3's append-and-derive rule). "Did we already prompt this
 * conversation today" is answered by a row's PRESENCE (the unique index
 * below turns the insert attempt itself into the compare-and-set), never a
 * flag flip.
 */
export const upgradePromptEvents = pgTable(
  "upgrade_prompt_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    billingAccountId: uuid("billing_account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "cascade" }),
    // 'seat_limit' | 'capacity' — the two upgrade-prompt walls of spec §6/§7.
    kind: text("kind").notNull(),
    conversationKey: text("conversation_key").notNull(),
    channel: text("channel").notNull(),
    // 'YYYY-MM-DD' — the CAS cooldown key (one prompt/conversation/day).
    periodKey: text("period_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // The dedup key itself: an INSERT that collides on all four columns is
    // "already prompted today" — no separate read-then-write race window.
    dedupUnique: uniqueIndex("upgrade_prompt_dedup_idx").on(
      t.billingAccountId,
      t.kind,
      t.conversationKey,
      t.periodKey
    ),
  })
);

export type UpgradePromptEvent = typeof upgradePromptEvents.$inferSelect;
export type NewUpgradePromptEvent = typeof upgradePromptEvents.$inferInsert;
