import { and, eq } from "drizzle-orm";
import { db } from "../db.js";
import { billingAccounts } from "../schema/billing_accounts.js";
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

// --- Subscription lifecycle (slice 3 — subscription-platform spec §9,
// slice-3 plan Task 4) ----------------------------------------------------

/**
 * The SOLE writer of `billing_accounts`' Stripe-state columns (`plan`,
 * `subscription_status`, `stripe_subscription_id`, `current_period_end`,
 * `updated_at`) — every call sets all FIVE, nothing else on the row
 * (notably not `stripe_customer_id`, which `bindStripeCustomer`
 * (`queries/billing_accounts.ts`) owns exclusively and fill-only). There is
 * no preserve-existing path: a caller that wants ONE column changed (see
 * `recordPastDueForStripeEvent` below) must use a narrower function
 * instead, never pass through a stale value here to fake a no-op.
 *
 * The subscription-lifecycle sibling of {@link creditTopUpForStripeEvent}
 * above — same dedup shape: the `stripe_events` row and the state-change
 * UPDATE land in ONE transaction, keyed on `event_id`'s UNIQUE index, so a
 * redelivered `checkout.session.completed` (subscription mode), `customer
 * .subscription.updated`, or `customer.subscription.deleted` can never
 * double-apply — but this one writes `billing_accounts` instead of
 * crediting a wallet. The webhook route
 * (`apps/console/app/api/v1/billing/stripe/webhook/route.ts`) is this
 * function's only caller: it derives every argument BEFORE calling in
 * (metadata-first account resolution, `resolvePlanFromPriceId` for `plan`,
 * a hardcoded `"trial"`/`"canceled"` pair for a deletion) — this function
 * performs the write and nothing else; it never looks anything up or
 * guesses a plan itself.
 *
 * Deliberately LAST-WRITE-WINS, not compare-and-swap against event
 * ordering: Stripe does not guarantee webhook delivery order, and this
 * function does no timestamp/sequence comparison before writing — whichever
 * event the webhook processes most recently simply overwrites whatever was
 * there. (Redelivery of the SAME event is a different problem — that's the
 * dedup ledger insert above, not this.) The spec accepts this as good
 * enough for v1: a rare out-of-order pair of Stripe events converges to
 * whichever arrived last, not necessarily the logically-latest one.
 *
 * `stripeSubscriptionId` and `currentPeriodEnd` are nullable in the input
 * type and write actual SQL NULL when passed `null` (a cancellation clears
 * both) — never coalesced or skipped, so a cancellation genuinely clears
 * the column rather than leaving a stale value behind. No-ops (0 rows
 * affected, no error) when `billingAccountId` doesn't match any row — the
 * caller has no result to branch on beyond `applied`.
 *
 * The UPDATE below is a hand-rolled Drizzle-builder call against `tx`, not
 * a call into some other query function, because it can't be: this
 * module's `db.transaction(async (tx) => …)` callback's `tx` (a
 * `PgTransaction<...>`) and this package's exported `Db` type (`typeof db`,
 * the full `PostgresJsDatabase<...> & { $client }`) are not mutually
 * assignable — the same drizzle limitation `github_intake.ts`'s own
 * `QueryExecutor` doc-comment describes — so any `Db`-typed helper defined
 * elsewhere in this package (e.g. in `billing_accounts.ts`) could never be
 * called from inside this transaction anyway.
 */
export interface ApplySubscriptionStateForStripeEventInput {
  /** Stripe's own event id — the idempotency key, same role as
   *  {@link CreditTopUpForStripeEventInput.eventId}. */
  eventId: string;
  /** e.g. "customer.subscription.updated" — audit/debugging only. */
  eventType: string;
  billingAccountId: string;
  plan: "trial" | "starter" | "growth" | "enterprise";
  subscriptionStatus: string;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
}

export interface ApplySubscriptionStateForStripeEventResult {
  /** True when THIS call wrote the state change; false when this Stripe
   *  event id had already been processed (idempotent no-op — no second
   *  write). */
  applied: boolean;
}

export async function applySubscriptionStateForStripeEvent(
  input: ApplySubscriptionStateForStripeEventInput
): Promise<ApplySubscriptionStateForStripeEventResult> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(stripeEvents)
      .values({
        eventId: input.eventId,
        eventType: input.eventType,
      })
      .onConflictDoNothing({ target: stripeEvents.eventId })
      .returning({ id: stripeEvents.id });

    if (inserted.length === 0) {
      // Already processed this exact Stripe event id — do NOT touch
      // billing_accounts. Same replay guard as creditTopUpForStripeEvent.
      return { applied: false };
    }

    await tx
      .update(billingAccounts)
      .set({
        plan: input.plan,
        subscriptionStatus: input.subscriptionStatus,
        stripeSubscriptionId: input.stripeSubscriptionId,
        currentPeriodEnd: input.currentPeriodEnd,
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.id, input.billingAccountId));

    return { applied: true };
  });
}

/**
 * `invoice.payment_failed`'s narrower write — flips ONLY
 * `subscription_status` to `"past_due"`, touching neither `plan` nor
 * `stripe_subscription_id` nor `current_period_end` (a failed invoice
 * payment doesn't change WHICH plan/subscription an account has, only that
 * it's now behind on payment — the brief's own "status past_due only, no
 * plan change" rule). Deliberately NOT
 * {@link applySubscriptionStateForStripeEvent} above: that function has no
 * preserve-existing path (every call sets all five Stripe-state columns),
 * and this event carries no price to derive a `plan` from at all, so
 * reusing it would mean either guessing a plan or re-reading the account
 * just to pass its current plan back through unchanged. Same one-
 * transaction dedup shape as its sibling.
 */
export interface RecordPastDueForStripeEventInput {
  eventId: string;
  eventType: string;
  billingAccountId: string;
}

export interface RecordPastDueForStripeEventResult {
  /** True when THIS call wrote the status change; false when this Stripe
   *  event id had already been processed (idempotent no-op). */
  applied: boolean;
}

export async function recordPastDueForStripeEvent(
  input: RecordPastDueForStripeEventInput
): Promise<RecordPastDueForStripeEventResult> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(stripeEvents)
      .values({
        eventId: input.eventId,
        eventType: input.eventType,
      })
      .onConflictDoNothing({ target: stripeEvents.eventId })
      .returning({ id: stripeEvents.id });

    if (inserted.length === 0) {
      return { applied: false };
    }

    await tx
      .update(billingAccounts)
      .set({ subscriptionStatus: "past_due", updatedAt: new Date() })
      .where(eq(billingAccounts.id, input.billingAccountId));

    return { applied: true };
  });
}
