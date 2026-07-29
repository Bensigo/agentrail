import {
  db,
  getBillingAccountForWorkspace,
  listAccountWorkspaceIds,
  type BillingAccountRow,
} from "@agentrail/db-postgres";
import { aggregateWorkspaceCosts } from "@agentrail/db-clickhouse";
import { PLAN_POLICIES, type AiPolicy } from "./plan-policies";
import type { QualityProfile } from "../alignment/quality-profile";

/**
 * The line where billing disappears (subscription platform spec,
 * `docs/superpowers/specs/2026-07-29-subscription-platform-design.md` §3
 * "The AI policy object"). Everything downstream of this function receives
 * a flat `AiPolicy` and is completely unaware that billing accounts, plans,
 * or `policy_overrides` exist — nothing below this line may branch on a
 * `BillingPlan` or import `PLAN_POLICIES` directly.
 *
 * Steps, exactly as §3 describes them: account → plan constants, with
 * `policy_overrides` merged over those constants INSIDE this function
 * (overrides are resolver *input*; the returned `AiPolicy` is flat and
 * final — never a lazily-merged view). The merge runs the same way for
 * every plan rather than being gated on `plan === "enterprise"`:
 * `billing_accounts.policy_overrides` defaults to `{}` for every self-serve
 * plan (`schema/billing_accounts.ts`'s own doc-comment), so merging it
 * unconditionally is a no-op there and behaviorally identical to gating on
 * enterprise, without a plan check to keep in sync if another plan ever
 * gains overrides too.
 *
 * `monthlyAiBudgetUsd`/`maxTaskCostUsd` come from the plan constants (after
 * override merge); `currentSpendUsd`/`remainingBudgetUsd` are hydrated on
 * EVERY call from the period's live cost telemetry (§8: `aggregateWorkspaceCosts`
 * summed over the account's workspaces) — the same fresh-read-no-caching
 * posture as the flag columns in `packages/db-postgres/src/schema/workspaces.ts:82-84`.
 * There is no caching layer here to invalidate because nothing is ever cached.
 *
 * §6 fail-open rule: "billing-infra errors fail open — serve the user, log
 * loudly." Every read this function depends on is wrapped so a failure
 * NEVER throws — not only economics hydration (workspace fan-out, the spend
 * query) but the billing-account fetch itself:
 *   - Account fetch throws (e.g. a Postgres hiccup): falls back to the
 *     trial policy, `billingAccountId: null`, `degraded: true`. Trial is
 *     the neutral placeholder here — once `degraded: true`, WHICH plan's
 *     constants ride along matters far less than the flag itself (below).
 *   - Workspace fan-out or the spend query throws: the real account's plan
 *     (overrides already merged) still resolves; only economics degrades,
 *     to a full remaining budget, `degraded: true`.
 *
 * **`degraded: true` is a hard contract, not a hint: this `AiPolicy` was
 * resolved from incomplete billing data, and every enforcement consumer —
 * the seat gate, the capacity gate, the §4 profile entitlement filter —
 * MUST skip gating on it rather than enforce against possibly-wrong data.**
 * Nothing customer-facing ever blocks on telemetry.
 *
 * Every returned policy — including every nested object (`qualityProfiles`,
 * `routing`, `economics`) — is a freshly constructed value, never a spread
 * of (or reference into) a `PLAN_POLICIES` entry: those are deep-frozen
 * module-level singletons (`plan-policies.ts`) and mutating them in place
 * would corrupt every future resolution for every account on that plan.
 */

export type ResolvedPolicy = {
  policy: AiPolicy;
  billingAccountId: string | null;
  degraded: boolean;
};

/**
 * Default economics hydration: the calendar-month-to-date cost summed
 * across every workspace on the account, via the same ClickHouse
 * aggregation and `groupBy` the digest route uses
 * (`apps/console/app/api/v1/workspaces/[workspaceId]/digest/route.ts:76-89`,
 * `@agentrail/db-clickhouse`'s `aggregateWorkspaceCosts`) — `groupBy: "run"`
 * is passed explicitly to match that call shape rather than relying on the
 * function's own implicit default (`"repo"`). The choice of `groupBy`
 * doesn't change the SUM either way: `total_cost_usd` summed across every
 * returned row for a workspace always equals that workspace's total for the
 * window, since GROUP BY only partitions within one workspace's own rows —
 * but matching the reused call shape keeps the two call sites obviously
 * consistent instead of accidentally different. A single workspace's query
 * failing rejects the whole `Promise.all` — deliberately: a partial sum
 * would misreport real spend, whereas `resolvePolicyForWorkspace`'s
 * caller-level fail-open degrades the WHOLE account to budget-unaware
 * instead, which is the safe direction to be wrong in.
 */
async function defaultFetchMonthSpendUsd(workspaceIds: string[]): Promise<number> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));

  const rowsPerWorkspace = await Promise.all(
    workspaceIds.map((workspaceId) =>
      aggregateWorkspaceCosts(workspaceId, { groupBy: "run", timeFrom: monthStart, timeTo: now })
    )
  );

  return rowsPerWorkspace
    .flat()
    .reduce((sum, row) => sum + row.total_cost_usd, 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function overrideNumber(base: number, override: unknown): number {
  return typeof override === "number" && Number.isFinite(override) ? override : base;
}

function overrideBoolean(base: boolean, override: unknown): boolean {
  return typeof override === "boolean" ? override : base;
}

const QUALITY_PROFILE_VALUES = new Set<QualityProfile>(["economy", "standard", "premium"]);

function overrideQualityProfile(base: QualityProfile, override: unknown): QualityProfile {
  return typeof override === "string" && QUALITY_PROFILE_VALUES.has(override as QualityProfile)
    ? (override as QualityProfile)
    : base;
}

/**
 * Deep-merges `billing_accounts.policy_overrides` (untyped jsonb —
 * `Record<string, unknown>` at best) over a plan's `AiPolicy` constants,
 * building a brand-new object at every level. Every field is read
 * explicitly by name; nothing is ever spread from `overrides` wholesale, so
 * unknown keys — at the top level or inside any nested object — are
 * silently dropped rather than leaking into the flat, final policy.
 * Fields absent from `overrides` (or present with the wrong type) keep the
 * plan's base value — partial nested overrides merge per-field, never
 * wholesale-replace a nested object.
 *
 * `economics.currentSpendUsd`/`remainingBudgetUsd` are deliberately NOT
 * override targets — they're always overwritten by live hydration right
 * after this function returns (see `resolvePolicyForWorkspace` below), so
 * honoring an override here would be dead code that could only mislead a
 * reader of `policy_overrides` about what it actually controls.
 */
function mergePolicyOverrides(base: AiPolicy, rawOverrides: unknown): AiPolicy {
  const overrides = isPlainObject(rawOverrides) ? rawOverrides : {};
  const qualityProfiles = isPlainObject(overrides.qualityProfiles) ? overrides.qualityProfiles : {};
  const routing = isPlainObject(overrides.routing) ? overrides.routing : {};
  const economics = isPlainObject(overrides.economics) ? overrides.economics : {};

  return {
    seatLimit: overrideNumber(base.seatLimit, overrides.seatLimit),
    monthlyCapacity: overrideNumber(base.monthlyCapacity, overrides.monthlyCapacity),
    qualityProfiles: {
      economy: overrideBoolean(base.qualityProfiles.economy, qualityProfiles.economy),
      standard: overrideBoolean(base.qualityProfiles.standard, qualityProfiles.standard),
      premium: overrideBoolean(base.qualityProfiles.premium, qualityProfiles.premium),
    },
    routing: {
      defaultProfile: overrideQualityProfile(base.routing.defaultProfile, routing.defaultProfile),
      allowEscalation: overrideBoolean(base.routing.allowEscalation, routing.allowEscalation),
      allowDowngrade: overrideBoolean(base.routing.allowDowngrade, routing.allowDowngrade),
    },
    economics: {
      monthlyAiBudgetUsd: overrideNumber(base.economics.monthlyAiBudgetUsd, economics.monthlyAiBudgetUsd),
      currentSpendUsd: base.economics.currentSpendUsd,
      remainingBudgetUsd: base.economics.remainingBudgetUsd,
      maxTaskCostUsd: overrideNumber(base.economics.maxTaskCostUsd, economics.maxTaskCostUsd),
    },
  };
}

/**
 * The shared trial-policy fallback for the two cases that have no real
 * account to resolve against: "no account exists yet" (`degraded: false` —
 * a workspace with no backfill/checkout is an expected, legitimate state,
 * not an error) and "the account fetch itself threw" (`degraded: true` —
 * the real plan is genuinely unknown here, so trial is the neutral
 * placeholder while `degraded: true` is the signal every enforcement
 * consumer actually keys off, per the module doc-comment above).
 */
function trialPolicyResult(degraded: boolean): ResolvedPolicy {
  return {
    policy: mergePolicyOverrides(PLAN_POLICIES.trial, {}),
    billingAccountId: null,
    degraded,
  };
}

export async function resolvePolicyForWorkspace(
  workspaceId: string,
  deps: {
    fetchAccount?: typeof getBillingAccountForWorkspace;
    fetchWorkspaceIds?: typeof listAccountWorkspaceIds;
    fetchMonthSpendUsd?: (workspaceIds: string[]) => Promise<number>;
  } = {}
): Promise<ResolvedPolicy> {
  const fetchAccount = deps.fetchAccount ?? getBillingAccountForWorkspace;
  const fetchWorkspaceIds = deps.fetchWorkspaceIds ?? listAccountWorkspaceIds;
  const fetchMonthSpendUsd = deps.fetchMonthSpendUsd ?? defaultFetchMonthSpendUsd;

  let account: BillingAccountRow | null;
  try {
    account = await fetchAccount(db, workspaceId);
  } catch (error) {
    // Loud, not silent — §6 fail-open. This is the FIRST billing-infra
    // read; if it throws we have no account to resolve a real plan
    // against, so the trial policy stands in and `degraded: true` tells
    // every downstream consumer this result is not safe to enforce.
    console.error(
      `resolvePolicyForWorkspace: failed to fetch the billing account for workspace ${workspaceId}; degrading to the trial policy`,
      error
    );
    return trialPolicyResult(true);
  }

  if (!account) {
    // No backfill/checkout has run for this workspace yet — same
    // caller-facing outcome as `getBillingAccountForWorkspace`'s own
    // null-not-throw contract: NULL is a fresh trial, never an error.
    return trialPolicyResult(false);
  }

  const basePolicy = mergePolicyOverrides(PLAN_POLICIES[account.plan], account.policyOverrides);

  let currentSpendUsd = 0;
  let degraded = false;
  try {
    const workspaceIds = await fetchWorkspaceIds(db, account.id);
    currentSpendUsd = await fetchMonthSpendUsd(workspaceIds);
  } catch (error) {
    degraded = true;
    currentSpendUsd = 0;
    // Loud, not silent — §6: "Billing-infra errors fail open ... log
    // loudly." Blocking a paying team because Postgres or ClickHouse
    // hiccuped is worse than one budget-unaware turn.
    console.error(
      `resolvePolicyForWorkspace: failed to hydrate economics for billing account ${account.id} (workspace ${workspaceId}); degrading to a full remaining budget`,
      error
    );
  }

  const remainingBudgetUsd = degraded
    ? basePolicy.economics.monthlyAiBudgetUsd
    : Math.max(0, basePolicy.economics.monthlyAiBudgetUsd - currentSpendUsd);

  return {
    policy: {
      ...basePolicy,
      economics: {
        ...basePolicy.economics,
        currentSpendUsd,
        remainingBudgetUsd,
      },
    },
    billingAccountId: account.id,
    degraded,
  };
}
