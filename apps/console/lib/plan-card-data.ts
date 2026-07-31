import {
  db,
  countActiveSeats,
  countAccountRunsStartedInWindow,
  countRunOutcomesForWorkspace,
  getBillingAccountForWorkspace,
} from "@agentrail/db-postgres";
import { resolvePolicyForWorkspace } from "./policy/resolve-policy";
import { currentBudgetWindow } from "./billing-period";
import {
  formatUtcDate,
  planLabel,
  renewalLabel,
} from "../app/(dashboard)/dashboard/[workspaceId]/billing/billing-helpers";

/**
 * Server-side read behind the dashboard digest's plan card (subscription
 * platform slice 6 plan, `docs/superpowers/plans/2026-07-31-subscription-
 * console-slice6.md` Task 2 — a LATER task in the same slice mounts this
 * into the digest; this module only produces the data). Never dollars,
 * model names, or the word "budget" (Global Constraints): `seatLimit`/
 * `capacityTotal`/`capacityUsed` are plain counts, and `shippedAllTime`
 * counts finished tasks, not spend.
 *
 * `seatLimit`/`capacityTotal` are read off `resolved.policy` — the
 * OVERRIDES-AWARE resolved `AiPolicy` (`resolve-policy.ts`) — never off
 * `PLAN_POLICIES`/`seatLimitForPlan` directly, so an enterprise account with
 * a `policy_overrides` bump shows its real limits here, exactly as it does
 * everywhere else `resolvePolicyForWorkspace` is the source of truth.
 */
export type PlanCardData = {
  planLabel: string;
  seatsUsed: number;
  seatLimit: number;
  capacityUsed: number;
  capacityTotal: number;
  renewalText: string;
  shippedAllTime: number;
};

/**
 * `undefined` means "render the dollar-free empty card instead"
 * (`digest-panel.tsx`'s `PlanCardEmpty` — 2026-07-31 owner ruling retired
 * the legacy cost card this used to fall back to; there is no cost card
 * left on this surface) — never an error the caller has to branch on
 * specially. Two ways to land there, same fail-open contract as the three
 * existing enforcement gates (`applySeatGateForServedTurn` in
 * `channel-dispatch.ts`; the capacity/wallet gates in
 * `app/api/v1/runner/claim/route.ts`):
 *
 *   1. `resolved.degraded || !resolved.billingAccountId` — the resolved
 *      policy isn't safe to build a card from (a transitional workspace
 *      with no billing account yet, or billing-infra hiccuped resolving
 *      it); Global Constraints: "Degraded or null billing account ⇒ same
 *      [as a read error]".
 *   2. The whole body is ONE try/catch: any thrown error (Postgres hiccup,
 *      a `null` account row despite a resolved `billingAccountId`) is
 *      logged loudly, namespaced `[plan-card]` (matching
 *      `[seat-gate]`/`[capacity-notify]`'s own convention), and
 *      swallowed — "Never let billing reads break the dashboard."
 *
 * Unlike those three enforcement gates, this loader is no longer flag-gated
 * (2026-07-31 owner ruling / subscription slice 8 retired the
 * `subscriptionsEnforced()` early return that used to make flag-off
 * byte-identical to this function never having been called): it now always
 * attempts a real read, flag or no flag. Enforcement (seat/capacity/wallet
 * gates) stays behind its own flag, untouched by this change.
 *
 * `resolvePolicyForWorkspace` is called with the SAME zero-spend
 * `fetchMonthSpendUsd` stub the capacity/seat gates use (their own
 * doc-comments have the full why): this loader never reads
 * `policy.economics`, only `seatLimit`/`monthlyCapacity`, so paying for a
 * real ClickHouse spend aggregation on every digest render would be pure
 * waste. Any future reader of this resolution that starts touching
 * `policy.economics` must remove the stub first.
 *
 * The four data reads run in parallel via `Promise.all` — `countActiveSeats`
 * and `countAccountRunsStartedInWindow` both key off the SAME resolved
 * `billingAccountId`, `countRunOutcomesForWorkspace` off the workspace
 * (all-time, per its own doc-comment), and `getBillingAccountForWorkspace`
 * supplies `plan`/`currentPeriodEnd`/`trialEndsAt` for the renewal string —
 * none of the four depends on another's result, so there is nothing to
 * gain from sequencing them.
 *
 * `capacityUsed`/`capacityTotal` are handed back as raw numbers, not a
 * composed string — the caller (the plan-card component, Task 3) owns the
 * exact pinned copy (`` `${used} of ${capacity} tasks this month` ``).
 */
export async function loadPlanCardData(
  workspaceId: string
): Promise<PlanCardData | undefined> {
  try {
    const resolved = await resolvePolicyForWorkspace(workspaceId, {
      fetchMonthSpendUsd: async () => 0,
    });
    // Degraded or no resolved billing account: not safe to build a plan
    // card from (a transitional workspace with no billing account yet, or
    // billing-infra hiccuped resolving it). Falls through to the digest's
    // dollar-free `PlanCardEmpty` card — the legacy-cost-card fail-open
    // this comment used to describe is retired (2026-07-31 owner ruling):
    // there is no cost card left to fall open to, on this surface or any
    // other (the sidebar's Engine room filter is unconditional now too).
    if (resolved.degraded || !resolved.billingAccountId) {
      return undefined;
    }
    const billingAccountId = resolved.billingAccountId;

    const { periodStartIso, periodEndIso } = currentBudgetWindow();

    const [seatsUsed, capacityUsed, outcomeCounts, account] = await Promise.all([
      countActiveSeats(db, billingAccountId),
      countAccountRunsStartedInWindow(db, {
        billingAccountId,
        fromIso: periodStartIso,
        toIso: periodEndIso,
      }),
      countRunOutcomesForWorkspace(workspaceId),
      getBillingAccountForWorkspace(db, workspaceId),
    ]);

    // Defensive only: `resolved.billingAccountId` above already proves a
    // billing account exists for this workspace, so this read is expected
    // to always find the same row. A `null` here (a genuine race with e.g.
    // an account being detached mid-request) falls through to the same
    // "nothing to show" outcome as every other unsafe-to-render case above,
    // rather than a null-deref a moment later.
    if (!account) return undefined;

    const renewalText =
      account.plan === "trial"
        ? `Trial ends ${formatUtcDate(account.trialEndsAt)}`
        : renewalLabel(account.currentPeriodEnd);

    return {
      planLabel: planLabel(account.plan),
      seatsUsed,
      seatLimit: resolved.policy.seatLimit,
      capacityUsed,
      capacityTotal: resolved.policy.monthlyCapacity,
      renewalText,
      shippedAllTime: outcomeCounts.success,
    };
  } catch (err) {
    console.error(
      `[plan-card] failed to load plan-card data for workspace ${workspaceId}:`,
      err
    );
    return undefined;
  }
}
