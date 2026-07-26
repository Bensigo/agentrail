import { pgTable, uuid, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * #1415 (Stripe top-up, Wave 5 / epic #1257; #1290's deferred PR ③) — the
 * webhook-delivery dedup ledger. Stripe redelivers a webhook on any
 * non-2xx/timeout response (and a customer's browser refreshing the
 * success-redirect can also cause the webhook to arrive more than once from
 * Stripe's own retry logic) — this table is what makes crediting the wallet
 * from a `checkout.session.completed` event idempotent: `event_id` is
 * Stripe's own globally-unique event id, UNIQUE here, so a second delivery of
 * the same event can never insert twice.
 *
 * Mirrors `wallet_transactions.ts`'s own idempotency posture
 * (`chargeCompletedTask`'s `ON CONFLICT (run_id) ... DO NOTHING`): the
 * webhook route inserts the event row and the `wallet_transactions` top-up
 * row in ONE database transaction (`queries/stripe_events.ts::
 * creditTopUpForStripeEvent`) — either both land or neither does, so a
 * replayed event can never credit the wallet a second time, and a crash
 * between the two inserts can never credit money with no matching event
 * record (or vice versa).
 *
 * `workspaceId`/`amountUsdCents` are nullable and exist for audit/debugging
 * only (which workspace + how much a given Stripe event resolved to) — the
 * dedup guarantee comes entirely from the `event_id` UNIQUE index, not from
 * these columns.
 */
export const stripeEvents = pgTable(
  "stripe_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Stripe's own event id (e.g. "evt_..."), globally unique per Stripe
    // account — this IS the idempotency key.
    eventId: text("event_id").notNull(),
    // e.g. "checkout.session.completed", "payment_intent.succeeded" — kept
    // for audit/debugging; only "checkout.session.completed" actually
    // credits the wallet today (see the webhook route's own doc-comment for
    // why acting on both event types would double-credit one purchase).
    eventType: text("event_type").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    // The amount this event credited, in integer cents — null when the event
    // was recorded but did not result in a credit (e.g. a recognized-but-
    // ignored event type, or a session missing the workspace metadata).
    amountUsdCents: integer("amount_usd_cents"),
    processedAt: timestamp("processed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    eventIdUnique: uniqueIndex("stripe_events_event_id_idx").on(t.eventId),
  })
);

export type StripeEvent = typeof stripeEvents.$inferSelect;
export type NewStripeEvent = typeof stripeEvents.$inferInsert;
