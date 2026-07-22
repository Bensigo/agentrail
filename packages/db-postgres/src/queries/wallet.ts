import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import { queueEntries } from "../schema/queue_entries.js";
import { walletTransactions } from "../schema/wallet_transactions.js";
import type { WalletTransaction } from "../schema/wallet_transactions.js";
import { taskPriceCents, usdToCents } from "../billing/pricing.js";

/**
 * #1290 (prepaid per-task wallet, Wave 5 / epic #1257; design locked
 * 2026-07-22) — the wallet ledger's read/write path.
 *
 * BALANCE IS ALWAYS A SUM. There is no mutable balance column anywhere: a
 * workspace's balance is `SUM(wallet_transactions.amount_usd_cents)` over its
 * rows (`getWalletBalanceCents`). Every write is an append-only row — a
 * positive `top_up` (money in — the clean seam PR ③'s Stripe webhook calls)
 * or a negative `task_charge` (money out — one per completed task). Money is
 * integer cents throughout; no float arithmetic on money.
 *
 * ROLLOUT FLAG. Every wallet entry point checks `isBillingEnabled` FIRST and
 * no-ops when off. With the flag off (the default for every workspace) not a
 * single row is written and prod behavior is byte-for-byte unchanged.
 */

/**
 * Read the workspace's `billing_enabled` rollout flag (default false). Mirrors
 * `isGoalLoopEnabled`'s own fresh-read posture (queries/goals.ts) — no
 * caching, so flipping the flag off halts billing immediately. Returns false
 * when the workspace row is somehow missing (fails toward "billing off", the
 * safe direction: never block a claim or post a charge for a workspace we
 * cannot resolve).
 */
export async function isBillingEnabled(workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ billingEnabled: workspaces.billingEnabled })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row?.billingEnabled ?? false;
}

/**
 * The workspace's current wallet balance in integer cents — the running SUM
 * of every `amount_usd_cents` for the workspace. NULL-safe: `COALESCE(SUM,
 * 0)` in SQL (a workspace with no rows sums to NULL otherwise) plus a
 * JS-level `?? 0`. Can be NEGATIVE: a completion charge is allowed to overrun
 * the pre-task estimate for that one task (design: the task is never killed
 * mid-run for a billing reason), so the balance can dip below zero — the NEXT
 * admission is what blocks until a top-up lands (see {@link walletCanAdmit}).
 */
export async function getWalletBalanceCents(
  workspaceId: string
): Promise<number> {
  const [row] = await db
    .select({
      balance: sql<number>`COALESCE(SUM(${walletTransactions.amountUsdCents}), 0)::int`,
    })
    .from(walletTransactions)
    .where(eq(walletTransactions.workspaceId, workspaceId));
  return row?.balance ?? 0;
}

export interface RecordWalletTransactionInput {
  workspaceId: string;
  kind: "top_up" | "task_charge";
  /** Signed integer cents: `top_up` > 0, `task_charge` < 0. */
  amountUsdCents: number;
  /** The run / queue-entry id (a `task_charge`), or null (a `top_up`). */
  runId?: string | null;
  /** Human-meaningful task identity for display; never a bare UUID. */
  taskRef?: string | null;
  /** Plain-English ledger line ("Top-up", "Task completed: <title>"). */
  description?: string;
}

/**
 * Append one row to the wallet ledger and return it. THE clean top-up seam:
 * PR ③'s Stripe webhook will call this with `kind: "top_up"` and a positive
 * `amountUsdCents` once a payment settles — no other funding path exists yet,
 * which is expected (without PR ③ a wallet cannot actually be funded; this PR
 * delivers the metering/charging engine PR ③ will fund).
 *
 * A plain, non-idempotent append: two top-ups are two distinct rows on
 * purpose (a customer can top up twice). The IDEMPOTENT completion charge is
 * {@link chargeCompletedTask}, NOT this function — do not route a per-run
 * charge through here directly if you need the double-charge guard.
 */
export async function recordWalletTransaction(
  input: RecordWalletTransactionInput
): Promise<WalletTransaction> {
  const [row] = await db
    .insert(walletTransactions)
    .values({
      workspaceId: input.workspaceId,
      kind: input.kind,
      amountUsdCents: input.amountUsdCents,
      runId: input.runId ?? null,
      taskRef: input.taskRef ?? null,
      description: input.description ?? "",
    })
    .returning();
  return row!;
}

/**
 * The workspace's ledger, newest-first, capped at `limit` (default 50). The
 * read the (future) console wallet page uses. Snake_case is a wire concern for
 * the route that serializes these; this returns the typed Drizzle rows.
 */
export async function listWalletTransactions(
  workspaceId: string,
  limit = 50
): Promise<WalletTransaction[]> {
  return db
    .select()
    .from(walletTransactions)
    .where(eq(walletTransactions.workspaceId, workspaceId))
    .orderBy(desc(walletTransactions.createdAt))
    .limit(limit);
}

/**
 * ADMISSION CHECK (PR ①): can this workspace's wallet cover the PRE-task
 * estimate? `balance >= estimate`. `estimateUsd` is the alignment brief's
 * `estimateBrief().estimateUsd` — dollars — converted to cents at the one
 * money boundary (`usdToCents`) and compared against the integer-cent balance.
 *
 * The CALLER is responsible for the flag gate: this function does the balance
 * math unconditionally so it stays pure-ish and unit-testable; the claim route
 * only invokes it when `isBillingEnabled` is true (flag off = today's behavior
 * byte-for-byte, no balance read at all). A non-finite / negative estimate is
 * treated as "nothing to cover" → admit (never block a task on a malformed
 * estimate).
 */
export async function walletCanAdmit(
  workspaceId: string,
  estimateUsd: number
): Promise<boolean> {
  if (!Number.isFinite(estimateUsd) || estimateUsd <= 0) return true;
  const estimateCents = usdToCents(estimateUsd);
  const balanceCents = await getWalletBalanceCents(workspaceId);
  return balanceCents >= estimateCents;
}

/**
 * The pre-task USD estimate of the entry the claim route WOULD claim next —
 * the oldest `queued` entry for the workspace, matching `claimQueueEntry`'s
 * own `ORDER BY created_at ASC` pick. Returns null when nothing is queued, or
 * when that entry carries no estimate (a brief-less / alignment-off row the
 * wallet cannot gate on — admit rather than block on a number we don't have).
 *
 * Coarse and best-effort, exactly like the workspace-budget ceiling gate it
 * sits beside in the claim route: a concurrent claim could take a different
 * entry between this peek and the actual claim, but the wallet gate is a
 * guardrail, not a hard reservation — the completion charge (allowed to
 * overrun into a negative balance) is the real accounting, and the NEXT
 * admission re-checks the fresh balance.
 */
export async function peekNextClaimEstimateUsd(
  workspaceId: string
): Promise<number | null> {
  const [row] = await db
    .select({ estimatedBudgetUsd: queueEntries.estimatedBudgetUsd })
    .from(queueEntries)
    .where(
      and(
        eq(queueEntries.workspaceId, workspaceId),
        eq(queueEntries.state, "queued")
      )
    )
    .orderBy(asc(queueEntries.createdAt))
    .limit(1);
  return row?.estimatedBudgetUsd ?? null;
}

export interface ChargeCompletedTaskInput {
  workspaceId: string;
  /** The run / queue-entry id — the idempotency key. */
  runId: string;
  /** Human-meaningful task identity for the ledger line; never a bare UUID. */
  taskRef?: string | null;
  /** The task's REAL token cost in integer cents (from the #1272 ledger). */
  actualTokenCostCents: number;
  /** Plain-English ledger line; defaults to a task-completed description. */
  description?: string;
}

export interface ChargeCompletedTaskResult {
  /** True when THIS call posted the charge; false when a charge for this run
   *  already existed (idempotent no-op). */
  charged: boolean;
  /** The signed amount that was (or already had been) posted — negative cents.
   *  On an idempotent no-op this is the price THIS call computed, not the
   *  amount of the pre-existing row (they are equal for the same real cost). */
  amountUsdCents: number;
  /** The positive price in cents (`taskPriceCents`), for logging/telemetry. */
  priceCents: number;
}

/**
 * COMPLETION CHARGE (PR ②). Price the completed task
 * (`actual_token_cost + FLAT_SERVER_FEE + FLAT_PROFIT`, all integer cents, via
 * `billing/pricing.ts::taskPriceCents`) and append a NEGATIVE `task_charge`
 * row for it — exactly once per run.
 *
 * IDEMPOTENT per run: the INSERT is `ON CONFLICT (run_id) WHERE kind =
 * 'task_charge' DO NOTHING`, matched to the partial unique index
 * `wallet_transactions_task_charge_run_id_idx`. A retried/duplicated
 * terminal-result delivery for the same run posts nothing the second time and
 * returns `charged: false` — a completion can NEVER double-charge the wallet.
 * Raw SQL (not the Drizzle builder) so the partial-index conflict target
 * (`(run_id) WHERE kind = 'task_charge'`) is expressed exactly.
 *
 * OVERAGE is intentionally allowed: this always posts the full real price even
 * when it exceeds the admission estimate, so the balance may go negative for
 * that one task. The task is never killed mid-run for a billing reason and
 * there is no silent overrun — the negative balance is a durable, visible fact
 * that the NEXT {@link walletCanAdmit} blocks on until a top-up lands.
 *
 * The CALLER gates on `isBillingEnabled` (flag off = never called, no charge).
 */
export async function chargeCompletedTask(
  input: ChargeCompletedTaskInput
): Promise<ChargeCompletedTaskResult> {
  const priceCents = taskPriceCents({
    actualTokenCostCents: input.actualTokenCostCents,
  });
  const amountUsdCents = -priceCents; // a charge is money out → negative
  const description =
    input.description ??
    (input.taskRef ? `Task completed: ${input.taskRef}` : "Task completed");

  const rows = (await db.execute(sql`
    INSERT INTO wallet_transactions
      (workspace_id, kind, amount_usd_cents, run_id, task_ref, description)
    VALUES
      (${input.workspaceId}, 'task_charge', ${amountUsdCents}, ${input.runId},
       ${input.taskRef ?? null}, ${description})
    ON CONFLICT (run_id) WHERE kind = 'task_charge' DO NOTHING
    RETURNING id
  `)) as unknown as Array<{ id: string }>;

  return {
    charged: Array.from(rows).length > 0,
    amountUsdCents,
    priceCents,
  };
}
