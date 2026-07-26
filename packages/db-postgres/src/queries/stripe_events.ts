import { and, eq } from "drizzle-orm";
import { db } from "../db.js";
import { stripeEvents } from "../schema/stripe_events.js";
import { walletTransactions } from "../schema/wallet_transactions.js";
import type { WalletTransaction } from "../schema/wallet_transactions.js";
import { workspaces } from "../schema/workspaces.js";

/**
 * #1415 (Stripe top-up, Wave 5 / epic #1257; #1290's deferred PR ③) — the
 * ONLY writer of a wallet `top_up` row. The webhook route calls this, never
 * `recordWalletTransaction` directly, so a redelivered `checkout.session
 * .completed` event can never credit a wallet twice.
 *
 * IDEMPOTENT PER STRIPE EVENT ID: the event row and the wallet top-up row are
 * inserted in ONE database transaction. `stripe_events.event_id` carries a
 * UNIQUE index (`stripe_events_event_id_idx`); a duplicate event id hits
 * `onConflictDoNothing`, the transaction inserts nothing else, and this
 * returns `{ credited: false }`. A brand-new event id inserts BOTH rows and
 * returns `{ credited: true, transaction }`. There is no window where the
 * event is recorded but the wallet wasn't credited, or vice versa — both
 * inserts commit together or neither does.
 *
 * ALSO flips `workspaces.billing_enabled` to true, in the SAME transaction,
 * the first time a workspace is credited — `workspaces.ts`'s own doc-comment
 * on that column names this PR as "where a workspace first gets flipped on"
 * (a $0 balance + the flag on would just block every task at the admission
 * gate, so there is no reason to leave it off once real money has landed). A
 * guarded `SET billing_enabled = true WHERE billing_enabled = false` — a
 * no-op once already on, so a second/third top-up never re-writes it.
 */
export interface CreditTopUpForStripeEventInput {
  /** Stripe's own event id (e.g. "evt_..."), globally unique — the
   *  idempotency key. */
  eventId: string;
  /** e.g. "checkout.session.completed" — audit/debugging only. */
  eventType: string;
  workspaceId: string;
  /** Positive integer cents — the amount the customer paid. */
  amountUsdCents: number;
  /** Plain-English ledger line (never "credits"/"tokens"/"quota"). */
  description?: string;
}

export interface CreditTopUpForStripeEventResult {
  /** True when THIS call posted the credit; false when this Stripe event id
   *  had already been processed (idempotent no-op — no second credit). */
  credited: boolean;
  transaction?: WalletTransaction;
}

export async function creditTopUpForStripeEvent(
  input: CreditTopUpForStripeEventInput
): Promise<CreditTopUpForStripeEventResult> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(stripeEvents)
      .values({
        eventId: input.eventId,
        eventType: input.eventType,
        workspaceId: input.workspaceId,
        amountUsdCents: input.amountUsdCents,
      })
      .onConflictDoNothing({ target: stripeEvents.eventId })
      .returning({ id: stripeEvents.id });

    if (inserted.length === 0) {
      // Already processed this exact Stripe event id — do NOT touch the
      // wallet. This is the replay guard.
      return { credited: false };
    }

    const [transaction] = await tx
      .insert(walletTransactions)
      .values({
        workspaceId: input.workspaceId,
        kind: "top_up",
        amountUsdCents: input.amountUsdCents,
        runId: null,
        taskRef: null,
        description: input.description ?? "Top-up",
      })
      .returning();

    await tx
      .update(workspaces)
      .set({ billingEnabled: true })
      .where(
        and(eq(workspaces.id, input.workspaceId), eq(workspaces.billingEnabled, false))
      );

    return { credited: true, transaction: transaction! };
  });
}

/**
 * Record a Stripe event this app deliberately did NOT credit (a recognized-
 * but-ignored event type like `payment_intent.succeeded`, or a
 * `checkout.session.completed` missing the workspace metadata it needs) —
 * still idempotent-guarded by the same unique index, so this is safe to call
 * even if the same non-credited event is redelivered. Kept separate from
 * {@link creditTopUpForStripeEvent} so a no-credit path never needs a
 * workspace id it doesn't have.
 */
export async function recordIgnoredStripeEvent(input: {
  eventId: string;
  eventType: string;
}): Promise<{ recorded: boolean }> {
  const inserted = await db
    .insert(stripeEvents)
    .values({ eventId: input.eventId, eventType: input.eventType })
    .onConflictDoNothing({ target: stripeEvents.eventId })
    .returning({ id: stripeEvents.id });
  return { recorded: inserted.length > 0 };
}

/**
 * Has this Stripe event id already been processed (credited or ignored)?
 * Exposed for tests / debugging; the webhook route itself relies on the
 * transactional insert's conflict result above, not this read, to avoid a
 * check-then-act race between two concurrent deliveries of the same event.
 */
export async function hasProcessedStripeEvent(eventId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: stripeEvents.id })
    .from(stripeEvents)
    .where(eq(stripeEvents.eventId, eventId))
    .limit(1);
  return !!row;
}
