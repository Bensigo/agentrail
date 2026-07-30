import { sql } from "drizzle-orm";
import type { Db } from "../db.js";
import { billingAccounts } from "../schema/billing_accounts.js";

/**
 * Billing account queries (spec
 * docs/superpowers/specs/2026-07-29-subscription-platform-design.md §3
 * "Platform architecture", §5 "Seats and identity", §9 "Migration and
 * rollout"; see `schema/billing_accounts.ts` and `schema/seats.ts` for the
 * table shapes and the WHY behind the design). Slice 1 shipped the read side
 * only (no writers beyond the 0062 migration's own trial backfill); slice 3
 * ("Stripe subscriptions", spec §9) adds the write/lookup side below —
 * `bindStripeCustomer` and `getBillingAccountByStripeCustomerId`, which
 * keys the latter off a Stripe event payload's `customer` field. The
 * subscription-STATE write itself (`plan`, `subscription_status`,
 * `stripe_subscription_id`, `current_period_end`) does NOT live in this
 * module — it's `applySubscriptionStateForStripeEvent`
 * (`queries/stripe_events.ts`), the Stripe webhook route's SOLE writer of
 * that state, defined alongside that file's own `stripe_events` dedup-
 * ledger transaction rather than here (a `db.transaction` callback's `tx`
 * and this module's `Db`-typed functions are not mutually assignable — see
 * that function's own doc-comment for the full reason).
 * `getBillingAccountByStripeCustomerId` is the webhook's FALLBACK account
 * lookup only, used when a Stripe object's own metadata is absent (logged
 * every time) — account resolution tries metadata FIRST, always; see the
 * webhook route's own doc-comment for the full race-immunity rationale.
 * `bindStripeCustomer` has TWO callers — the subscription checkout server
 * action (`billing/actions.ts`, Task 3: binds a fresh customer id the first
 * time a workspace's billing account ever checks out) and that same
 * webhook route (binds it again for any account that reaches Stripe some
 * other way) — both safe under redelivery/out-of-order/racing arrival:
 * `bindStripeCustomer` is a fill-only UPDATE (never clobbers a value
 * already set), so either caller racing the other is benign. This is
 * independent of `stripe_events`
 * (`schema/stripe_events.ts`), the
 * redelivery-of-the-SAME-event dedup ledger the existing wallet top-up flow
 * uses — that solves a different problem (never process one event twice) and
 * isn't touched by this module. The original three reads keep their one
 * consumer: a later slice's policy resolver (`resolvePolicyForWorkspace`),
 * reading through `getBillingAccountForWorkspace` exactly as before.
 *
 * `db` is an explicit parameter on every function below, not the imported
 * `db` singleton most of `queries/index.ts` closes over — the same
 * convention `channel_inbox.ts`'s `stampChannelInboxWorkspace` established,
 * for the same reason: this package has no live-DB test harness (every spec
 * mocks `db`), and an explicit parameter lets a test pass a plain
 * captured-SQL mock straight to the call site with no
 * `vi.mock("../db.js")` module interception required.
 *
 * Every query in this module is raw `db.execute(sql\`...\`)`, not the
 * Drizzle builder chain — deliberately, not by default.
 * `stampChannelInboxWorkspace` is the original precedent for this
 * explicit-`db`-param shape, and it is raw SQL; matching it keeps that
 * precedent consistent, and (per its sibling `claimNextChannelMessage`'s own
 * note) keeps this module testable with the same "capture the SQL object
 * passed to `db.execute`, render it with drizzle's `PgDialect`" technique
 * this package's suite already uses (`stamp-channel-inbox-workspace.test.ts`,
 * `runner-result-sql.test.ts`) — the builder chain never calls `db.execute`
 * itself, so it can't be captured and rendered the same way. Raw
 * `db.execute` returns snake_case columns (the driver doesn't apply
 * Drizzle's schema mapping to raw SQL), so both `getBillingAccountForWorkspace`
 * and `getBillingAccountByStripeCustomerId` normalize their row to camelCase
 * before returning — the same pattern `claimNextChannelMessage` uses.
 */

export type BillingAccountRow = typeof billingAccounts.$inferSelect;

/**
 * Postgres's raw wire text for a `timestamptz` looks like
 * "2026-08-19 09:05:34.525288+00" — a SPACE between date and time (ISO 8601
 * requires "T") and a bare 2-digit UTC offset with no ":00" minutes (ISO
 * 8601 requires the full "+HH:MM", or "Z" for UTC). `new Date(...)` parsing
 * that exact non-standard shape today is V8's own leniency, not a guarantee
 * of the ECMA-262 Date Time String Format spec any engine has to honor —
 * normalize to real ISO 8601 BEFORE handing it to the `Date` constructor so
 * correctness doesn't quietly depend on engine-specific parsing. Leaves an
 * offset that already has minutes (e.g. "+05:30") untouched — the trailing
 * two digits there are preceded by ":", not directly by the sign, so the
 * regex doesn't match.
 */
function normalizePostgresTimestampText(raw: string): string {
  const isoSeparator = raw.replace(" ", "T");
  return /[+-]\d{2}$/.test(isoSeparator) ? `${isoSeparator}:00` : isoSeparator;
}

/**
 * Re-wraps a raw `db.execute(sql...)` timestamp value into a real `Date`
 * (verified 2026-07-30, slice-3 Task 5 browser verification, then
 * hardened per review round 1 — see `normalizePostgresTimestampText`'s own
 * doc-comment for the full why). A raw `db.execute` result does NOT come
 * back through postgres-js's normal type parsers the way the Drizzle query
 * builder's own results do — every `timestamptz` column lands as Postgres's
 * raw wire TEXT, not a `Date` instance, even though `BillingAccountRow`'s
 * type (from `$inferSelect`) promises `Date`. Left unwrapped that's a
 * silent type-lie: it compiles clean, and every existing caller happened to
 * only ever WRITE these fields straight through (never call a Date-only
 * method on them) — until `billing/billing-helpers.ts`'s `renewalLabel`
 * called `.toLocaleDateString()` on it and threw `TypeError:
 * ...toLocaleDateString is not a function` against the real dev DB.
 *
 * Accepts an already-`Date` value too (returned as-is, no re-wrap) — module
 * private, so its only callers are the two remaps below, but staying
 * total over both shapes means a value that already arrived as a real
 * `Date` (a future postgres-js upgrade that DOES apply its normal parsers
 * to `db.execute`, or a differently-sourced row in a future caller) is
 * genuinely safe to double-pass through this function rather than a latent
 * assumption that only holds today.
 */
function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(normalizePostgresTimestampText(value));
}

/**
 * `toDate`, but null-preserving — for `current_period_end`, the one
 * nullable timestamp column. `new Date(null)` does NOT return `null`, it
 * silently coerces to the Unix epoch (`null` -> `0` -> 1970-01-01), so this
 * guards explicitly rather than leaving that footgun for `toDate`'s caller.
 */
function toDateOrNull(value: string | Date | null): Date | null {
  return value === null ? null : toDate(value);
}

/**
 * The billing account a workspace belongs to, joined through
 * `workspaces.billing_account_id`. Returns `null` — never throws — both when
 * the workspace itself doesn't exist and when it exists but its
 * `billing_account_id` is still NULL (no backfill/checkout has run for it
 * yet): the INNER JOIN yields zero rows either way, and both cases are the
 * SAME caller-facing outcome per `workspaces.ts`'s own doc-comment on that
 * column — "NULL exactly like a fresh trial: no billing account yet is the
 * default, never an error." The policy resolver (a later slice) is this
 * function's one consumer and depends on that null-not-throw contract to
 * implement the NULL = trial-policy path.
 */
export async function getBillingAccountForWorkspace(
  db: Db,
  workspaceId: string
): Promise<BillingAccountRow | null> {
  const rows = (await db.execute(sql`
    SELECT
      ba.id,
      ba.name,
      ba.plan,
      ba.stripe_customer_id,
      ba.stripe_subscription_id,
      ba.subscription_status,
      ba.current_period_end,
      ba.trial_ends_at,
      ba.policy_overrides,
      ba.created_at,
      ba.updated_at
    FROM billing_accounts ba
    INNER JOIN workspaces w ON w.billing_account_id = ba.id
    WHERE w.id = ${workspaceId}
    LIMIT 1
  `)) as unknown as Array<{
    id: string;
    name: string;
    plan: BillingAccountRow["plan"];
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    subscription_status: string | null;
    // Raw Postgres wire text ("2026-08-19 09:05:34.525288+00"), NOT a JS
    // `Date` — see `toDate`'s own doc-comment above for why.
    current_period_end: string | null;
    trial_ends_at: string;
    policy_overrides: Record<string, unknown>;
    created_at: string;
    updated_at: string;
  }>;

  const row = Array.from(rows)[0];
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    plan: row.plan,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    subscriptionStatus: row.subscription_status,
    currentPeriodEnd: toDateOrNull(row.current_period_end),
    trialEndsAt: toDate(row.trial_ends_at),
    policyOverrides: row.policy_overrides,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

/**
 * Every workspace id attached to a billing account — the inverse of
 * `getBillingAccountForWorkspace`, and the account-wide fan-out a later
 * slice's "apply to every workspace on this account" operations (and the
 * policy resolver's own account-level reads) need. Returns `[]` for an
 * account with no workspaces, or an unknown id — never throws on that case.
 */
export async function listAccountWorkspaceIds(
  db: Db,
  billingAccountId: string
): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT id
    FROM workspaces
    WHERE billing_account_id = ${billingAccountId}
  `)) as unknown as Array<{ id: string }>;

  return Array.from(rows).map((row) => row.id);
}

/**
 * Active seat count for a billing account. Active means `released_at IS
 * NULL` — the append-and-derive rule `schema/seats.ts` documents: there is
 * NO mutable counter anywhere, this COUNT(*) over live rows IS the seat
 * count (spec §3: "Seat count = active rows. No mutable counter."). `::int`
 * casts the aggregate in SQL so the driver hands back a real JS number
 * rather than the bigint-as-string the wire protocol returns for an uncast
 * COUNT(*); the `Number(...)` below is a defensive second pass (mirrors
 * `getLatestOnboardMemoryAt`'s own `Number(row?.count ?? 0)`), not a
 * load-bearing dependency on either alone. Returns 0 for an account with no
 * active seats, or an unknown id — never throws.
 */
export async function countActiveSeats(
  db: Db,
  billingAccountId: string
): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS count
    FROM seats
    WHERE billing_account_id = ${billingAccountId}
      AND released_at IS NULL
  `)) as unknown as Array<{ count: number }>;

  const row = Array.from(rows)[0];
  return Number(row?.count ?? 0);
}

// --- Stripe writes (slice 3 — subscription-platform spec §9) --------------

/**
 * Bind a billing account to its Stripe customer, once.
 *
 * TWO callers — see this module's top doc-comment: the subscription
 * checkout server action (`billing/actions.ts`, Task 3) binds a fresh
 * customer id the first time a workspace's billing account ever checks
 * out; the Stripe webhook route (a later slice-3 task) binds it again for
 * any account that reaches Stripe some other way. Deliberately FILL-ONLY —
 * the `stripe_customer_id IS NULL` guard means this can never clobber a
 * customer id an account already carries, the same pattern
 * `channel_inbox.ts`'s `stampChannelInboxWorkspace` establishes (see that
 * function's own doc-comment for the general rationale). Here
 * specifically: Stripe does not guarantee webhook delivery exactly-once or
 * in order, so the same subscription's events can call this more than once
 * with the same customer id; the checkout action can ALSO race the webhook
 * for the very same account (both bind attempts firing off the same fresh
 * checkout) — the guard makes every call after the first a safe no-op
 * instead of a redundant write, regardless of which of the two callers
 * gets there first, and forecloses the one way a redelivered,
 * out-of-order, or racing call could ever overwrite the correct,
 * already-bound id with a wrong one. `getBillingAccountByStripeCustomerId`
 * below is how the webhook re-derives the account from that id on every
 * subsequent event, so a clobbered bind would silently orphan that lookup
 * path for whichever customer id got overwritten.
 *
 * No-ops (0 rows affected, no error) when the account is unknown or already
 * has a `stripe_customer_id` bound — the caller has no result to branch on,
 * matching `stampChannelInboxWorkspace`'s own fire-and-forget contract.
 */
export async function bindStripeCustomer(
  db: Db,
  billingAccountId: string,
  stripeCustomerId: string
): Promise<void> {
  await db.execute(sql`
    UPDATE billing_accounts
    SET stripe_customer_id = ${stripeCustomerId}, updated_at = now()
    WHERE id = ${billingAccountId}
      AND stripe_customer_id IS NULL
  `);
}

/**
 * The billing account bound to a given Stripe customer id, or `null` when no
 * account has been bound to it (yet, or ever). This is the Stripe webhook
 * route's FALLBACK account lookup ONLY: a subscription event's own metadata
 * (`billingAccountId`, stamped by the checkout action on both the Checkout
 * Session and, via `subscription_data.metadata`, the Subscription it
 * creates) is always tried FIRST — race-immune against
 * `bindStripeCustomer`'s own documented race, since the metadata on the
 * object an event is actually about is always correct regardless of which
 * customer bind won. This function is called only when that metadata is
 * absent, and the webhook `console.warn`s every time it falls back to this
 * lookup. See the webhook route's own doc-comment
 * (`apps/console/app/api/v1/billing/stripe/webhook/route.ts`) for the full
 * rationale.
 *
 * Same raw-`db.execute` + snake_case-to-camelCase normalization as
 * `getBillingAccountForWorkspace` above; see this module's top doc-comment
 * for why raw SQL over the builder chain.
 */
export async function getBillingAccountByStripeCustomerId(
  db: Db,
  stripeCustomerId: string
): Promise<BillingAccountRow | null> {
  const rows = (await db.execute(sql`
    SELECT
      id,
      name,
      plan,
      stripe_customer_id,
      stripe_subscription_id,
      subscription_status,
      current_period_end,
      trial_ends_at,
      policy_overrides,
      created_at,
      updated_at
    FROM billing_accounts
    WHERE stripe_customer_id = ${stripeCustomerId}
    LIMIT 1
  `)) as unknown as Array<{
    id: string;
    name: string;
    plan: BillingAccountRow["plan"];
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    subscription_status: string | null;
    // Raw Postgres wire text, NOT a JS `Date` — see `toDate`'s own
    // doc-comment above `getBillingAccountForWorkspace` for the full why.
    current_period_end: string | null;
    trial_ends_at: string;
    policy_overrides: Record<string, unknown>;
    created_at: string;
    updated_at: string;
  }>;

  const row = Array.from(rows)[0];
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    plan: row.plan,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    subscriptionStatus: row.subscription_status,
    currentPeriodEnd: toDateOrNull(row.current_period_end),
    trialEndsAt: toDate(row.trial_ends_at),
    policyOverrides: row.policy_overrides,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}
