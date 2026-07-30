import { sql } from "drizzle-orm";
import type { Db } from "../db.js";
import { billingAccounts } from "../schema/billing_accounts.js";

/**
 * Billing account read queries (spec
 * docs/superpowers/specs/2026-07-29-subscription-platform-design.md §3
 * "Platform architecture", §5 "Seats and identity"; see
 * `schema/billing_accounts.ts` and `schema/seats.ts` for the table shapes
 * and the WHY behind the design). This is the read side only — slice 1 ships
 * no writers here beyond the 0062 migration's own trial backfill. A later
 * slice's policy resolver (`resolvePolicyForWorkspace`) is this module's one
 * consumer, and reads through these three functions exactly as named here.
 *
 * `db` is an explicit parameter on every function below, not the imported
 * `db` singleton most of `queries/index.ts` closes over — the same
 * convention `channel_inbox.ts`'s `stampChannelInboxWorkspace` established,
 * for the same reason: this package has no live-DB test harness (every spec
 * mocks `db`), and an explicit parameter lets a test pass a plain
 * captured-SQL mock straight to the call site with no
 * `vi.mock("../db.js")` module interception required.
 *
 * All three queries are raw `db.execute(sql\`...\`)`, not the Drizzle
 * builder chain — deliberately, not by default. `stampChannelInboxWorkspace`
 * is the only existing precedent for this explicit-`db`-param shape, and it
 * is raw SQL; matching it keeps that one precedent consistent, and (per its
 * sibling `claimNextChannelMessage`'s own note) keeps this module testable
 * with the same "capture the SQL object passed to `db.execute`, render it
 * with drizzle's `PgDialect`" technique this package's suite already uses
 * (`stamp-channel-inbox-workspace.test.ts`, `runner-result-sql.test.ts`) —
 * the builder chain never calls `db.execute` itself, so it can't be
 * captured and rendered the same way, and the brief's own coverage bar
 * (prove the join, prove the `released_at IS NULL` filter) is a rendered-SQL
 * assertion. Raw `db.execute` returns snake_case columns (the driver
 * doesn't apply Drizzle's schema mapping to raw SQL), so
 * `getBillingAccountForWorkspace` normalizes its row to camelCase before
 * returning — the same pattern `claimNextChannelMessage` uses.
 */

export type BillingAccountRow = typeof billingAccounts.$inferSelect;

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
    current_period_end: Date | null;
    trial_ends_at: Date;
    policy_overrides: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
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
    currentPeriodEnd: row.current_period_end,
    trialEndsAt: row.trial_ends_at,
    policyOverrides: row.policy_overrides,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
