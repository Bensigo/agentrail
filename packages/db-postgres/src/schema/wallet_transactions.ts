import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * #1290 (prepaid per-task wallet, Wave 5 / epic #1257; design locked
 * 2026-07-22). The append-only money ledger for a workspace's prepaid
 * balance. There is NO subscription and NO single mutable "balance" column:
 * the balance is ALWAYS the running SUM of every row's `amount_usd_cents`
 * (see `queries/wallet.ts::getWalletBalanceCents`). Two reasons this is a
 * ledger, not a counter:
 *   1. Audit trail — once real dollars move (PR ③ funds it via Stripe), every
 *      cent in or out has to have a durable, immutable record. A mutable
 *      balance column would lose that history the instant it is overwritten.
 *   2. Concurrency — two concurrent writes to one balance column race; two
 *      concurrent INSERTs of independent ledger rows do not, and the SUM is
 *      always correct after both land.
 *
 * Money is stored as INTEGER CENTS, never a float and never `numeric`: every
 * amount in this table is an exact whole number of US cents. A `top_up` is a
 * POSITIVE amount (money added — the clean seam PR ③'s Stripe webhook will
 * call, `recordWalletTransaction` with kind `top_up`); a `task_charge` is a
 * NEGATIVE amount (money spent — posted once per completed task by
 * `chargeCompletedTask`, priced by `billing/pricing.ts`).
 *
 * Everything that reads or writes this table is behind the
 * `workspaces.billing_enabled` rollout flag (default OFF) — with the flag off
 * no row is ever written and prod behavior is byte-for-byte unchanged.
 */
export const walletTransactionKindEnum = pgEnum("wallet_transaction_kind", [
  "top_up",
  "task_charge",
]);

export const walletTransactions = pgTable(
  "wallet_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: walletTransactionKindEnum("kind").notNull(),
    // Signed integer cents: `top_up` > 0 (money in), `task_charge` < 0 (money
    // out). The workspace balance is SUM(amount_usd_cents) over all its rows.
    // Never a float, never `numeric` — money is exact whole cents here.
    amountUsdCents: integer("amount_usd_cents").notNull(),
    // The run / queue-entry id a `task_charge` is for (the queue entry id IS
    // the run id — `claimQueueEntry` reuses it). NULL for a `top_up` (a top-up
    // belongs to no single task). This column is what makes a completion charge
    // idempotent — see `taskChargeRunUnique` below.
    runId: uuid("run_id"),
    // Human-meaningful task identity for display (the issue's external_id /
    // title) — NEVER shown as a bare UUID (house UI rule). NULL on a `top_up`.
    taskRef: text("task_ref"),
    // Plain-English, employer-of-an-engineer wording for the ledger line
    // ("Top-up", "Task completed: <title>"). NEVER "credits"/"tokens"/"quota"
    // (house vocabulary rule). Defaults to "" so a writer can never omit it.
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Backs both the balance SUM and the newest-first ledger list, scoped to
    // one workspace.
    workspaceIdx: index("wallet_transactions_workspace_id_idx").on(
      t.workspaceId
    ),
    // AT MOST ONE `task_charge` per run, forever — the idempotency guarantee a
    // completion charge relies on (`chargeCompletedTask` INSERTs
    // `ON CONFLICT (run_id) WHERE kind = 'task_charge' DO NOTHING`). A retried
    // /duplicated terminal-result delivery for the same run can never
    // double-charge the wallet. Partial (only `task_charge` rows), so a
    // `top_up`'s NULL run_id is unaffected and multiple top-ups are always
    // allowed.
    taskChargeRunUnique: uniqueIndex(
      "wallet_transactions_task_charge_run_id_idx"
    )
      .on(t.runId)
      .where(sql`${t.kind} = 'task_charge'`),
  })
);

export type WalletTransaction = typeof walletTransactions.$inferSelect;
export type NewWalletTransaction = typeof walletTransactions.$inferInsert;
