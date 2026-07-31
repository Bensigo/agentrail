import { pgTable, uuid, text, jsonb, timestamp, pgEnum } from "drizzle-orm/pg-core";

/**
 * Billing accounts (spec docs/superpowers/specs/2026-07-29-subscription-platform-design.md
 * §3 "Platform architecture"). Billing moves ABOVE workspaces: an account
 * owns the plan, the Stripe subscription, and the seats; multiple
 * workspaces share one account via `workspaces.billing_account_id` (see
 * that column's own doc-comment in `workspaces.ts`). Every existing
 * workspace gets exactly one trial account at backfill time (the next
 * task's migration, `plan = 'trial'`, named after the workspace) — founders
 * convert real accounts by hand at launch (spec §9); no live paying
 * customer exists to migrate.
 *
 * This table holds plain account state only — no derived/mutable counters
 * live here. The append-and-derive rule (seat count = active rows, never a
 * mutable counter — spec §3) governs `seats.ts`, not this table.
 */
export const billingPlanEnum = pgEnum("billing_plan", [
  "trial",
  "starter",
  "growth",
  "enterprise",
]);

export const billingAccounts = pgTable("billing_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  plan: billingPlanEnum("plan").notNull().default("trial"),
  // Null until slice 3 (Stripe subscriptions) wires real checkout.
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  // Stripe-mirrored raw status string (e.g. 'active', 'past_due', 'trialing')
  // — plain text, not an enum: Stripe owns this vocabulary and can add
  // values without a migration here.
  subscriptionStatus: text("subscription_status"),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  // 14 days from creation (spec §3, §7 "Trial"). No DB default — the
  // creating code computes createdAt + 14d explicitly, so the value is
  // always intentional, never an accidental "now".
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }).notNull(),
  // Enterprise-only deltas merged over the plan's code-defined AiPolicy
  // INSIDE the resolver (`resolvePolicyForWorkspace`, a later slice) — the
  // overrides are resolver *input*, never consulted directly downstream.
  // Empty `{}` for every self-serve plan (trial/starter/growth).
  policyOverrides: jsonb("policy_overrides")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type BillingAccount = typeof billingAccounts.$inferSelect;
export type NewBillingAccount = typeof billingAccounts.$inferInsert;
export type BillingPlan = (typeof billingPlanEnum.enumValues)[number];
