import { PLAN_POLICIES, type BillingPlan } from "../../../../../lib/policy/plan-policies";

/**
 * Pure display-shaping helpers for the Plan & billing settings page
 * (slice-3 plan, `docs/superpowers/plans/2026-07-29-subscription-stripe-slice3.md`,
 * Task 5). Kept in a plain `.ts` file (no JSX) so it's unit-testable without
 * a react plugin — mirrors `wallet/wallet-helpers.ts` and
 * `goals/goals-helpers.ts`'s own split. The page and its button components
 * stay thin, reading from here.
 *
 * House vocabulary rule (same posture as `wallet-helpers.ts`'s own
 * doc-comment on "credits"/"tokens"/"quota"): this page shows a customer
 * their PLAN and its value, never AI-cost/dollars-spent-on-models language
 * (subscription-platform spec §1 Principles) — `PLAN_POLICIES`'s own
 * `economics` field (AI budget, spend) is deliberately NOT surfaced by
 * anything here.
 */

/** Snake_case -> sentence case fallback for a raw value this page's known
 *  vocabulary hasn't been taught yet — only the first word capitalized
 *  ("Some future status"), matching this codebase's existing status-label
 *  casing (`lib/work-vocabulary.ts`'s `queueStateLabel`: "Escalated to
 *  human", not "Escalated To Human"). Never a raw underscored string on
 *  screen (house display rule) and never a thrown error — matches
 *  `goalStatusLabel`'s own "falls back rather than throws" totality
 *  contract. Shared by `planLabel` and `statusChip` below: both read a
 *  value out of a DB column an unchecked `as unknown as Array<{...}>` cast
 *  (`getBillingAccountForWorkspace`, `packages/db-postgres`) merely
 *  PROMISES matches today's closed union — a future enum/vocabulary value
 *  added to the DB before this app's TS types catch up must still render
 *  something readable, not `undefined` or a thrown error. */
function humanizeUnknownValue(value: string): string {
  const words = value.split("_").filter(Boolean);
  return words
    .map((word, i) => (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

const PLAN_LABEL: Record<BillingPlan, string> = {
  trial: "Trial",
  starter: "Starter",
  growth: "Growth",
  enterprise: "Enterprise",
};

/**
 * Human plan name for the current-plan card's headline. Takes a plain
 * `string`, not just `BillingPlan` — `account.plan` arrives through
 * `getBillingAccountForWorkspace`'s own raw-SQL cast (a compile-time-only
 * promise that the DB's actual enum value is one of today's four
 * literals), so a value outside `PLAN_LABEL` is a real, if rare, runtime
 * possibility (e.g. a DB enum value added before this app's `BillingPlan`
 * union is updated to match) — falls back to `humanizeUnknownValue` rather
 * than silently rendering `undefined`. review round 1 (minor).
 */
export function planLabel(plan: string): string {
  return PLAN_LABEL[plan as BillingPlan] ?? humanizeUnknownValue(plan);
}

/**
 * The plan's seat limit from `PLAN_POLICIES`, falling back to trial's when
 * `plan` isn't a recognized `BillingPlan` — same "DB cast is a
 * compile-time-only promise" rationale as `planLabel` above.
 * `PLAN_POLICIES[plan]` is not just harmless-if-unreachable here: for a
 * plan value the current `BillingPlan` union doesn't know about,
 * `PLAN_POLICIES[...]` is genuinely `undefined` at runtime regardless of
 * what the type system believes, and the seat-limit line on the current-
 * plan card should read as *something* — trial's limit, the same "no
 * billing account yet" default the rest of this page already uses — rather
 * than the page crashing or the card showing `undefined`. review round 1
 * (minor).
 */
export function seatLimitForPlan(plan: string): number {
  return (PLAN_POLICIES[plan as BillingPlan] ?? PLAN_POLICIES.trial).seatLimit;
}

/**
 * "Renews <date>" from `current_period_end`, or a plain no-subscription
 * notice when null — null covers both a pure trial account (never checked
 * out) and a canceled subscription (the webhook nulls this column on
 * cancellation, `stripe/webhook/route.ts`'s `handleSubscriptionDeleted`),
 * which is intentional: neither case has a renewal to report.
 *
 * `timeZone: "UTC"` makes the label deterministic regardless of the host's
 * local timezone (same recipe as `../components/digest-panel-helpers.ts`'s
 * `formatWeekRangeLabel`) — a stored `timestamptz` should read as the same
 * calendar date to every viewer, never shift a day depending on where the
 * server (or a test runner) happens to sit relative to UTC.
 */
export function renewalLabel(currentPeriodEnd: Date | null): string {
  if (!currentPeriodEnd) return "No active subscription";
  const date = currentPeriodEnd.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `Renews ${date}`;
}

/** "<used> of <limit>" seats — the exact house phrasing (slice-3 plan
 *  Task 5's own file list). Never editorializes about over/under capacity
 *  in the string itself; that's a styling concern for the card that reads
 *  this value, not this function's job. */
export function seatsLabel(used: number, limit: number): string {
  return `${used} of ${limit}`;
}

export type SubscriptionStatusTone = "positive" | "neutral" | "warning" | "critical";

export interface StatusChipInfo {
  label: string;
  tone: SubscriptionStatusTone;
}

/**
 * Known keys are Stripe's own `Subscription.status` enum
 * (`node_modules/stripe` v18 `types/Subscriptions.d.ts`) — verbatim strings
 * this app's webhook mirrors into `billing_accounts.subscription_status`
 * with no translation (`schema/billing_accounts.ts`'s own doc-comment:
 * "plain text, not an enum — Stripe owns this vocabulary") — plus
 * `"canceled"`, which the webhook also writes by hand on
 * `customer.subscription.deleted` (`handleSubscriptionDeleted`; Stripe's own
 * enum already has `"canceled"` too, so this is one case doing double duty).
 *
 * Tone follows this codebase's established status-color vocabulary
 * (`goals/goals-helpers.ts`'s own `GOAL_STATUS_TONE`, same four-tone
 * system): `active` = positive/green, a healthy paid subscription;
 * `trialing` = neutral/gray, in progress and nothing alarming yet;
 * `past_due` / `incomplete` / `paused` = warning/yellow, needs a human look
 * but isn't broken outright; `incomplete_expired` / `unpaid` =
 * critical/red, payment genuinely failed; `canceled` = neutral/gray, a
 * factual past-tense state — by the time this status lands the account has
 * already reverted to trial policy (the webhook's own deletion handler), so
 * it isn't itself an active problem to alarm on.
 */
const STATUS_CHIP: Record<string, StatusChipInfo> = {
  active: { label: "Active", tone: "positive" },
  trialing: { label: "Trialing", tone: "neutral" },
  past_due: { label: "Past due", tone: "warning" },
  canceled: { label: "Canceled", tone: "neutral" },
  incomplete: { label: "Incomplete", tone: "warning" },
  incomplete_expired: { label: "Expired", tone: "critical" },
  paused: { label: "Paused", tone: "warning" },
  unpaid: { label: "Unpaid", tone: "critical" },
};

/**
 * The plan card's subscription-status chip, or `null` when there's no
 * subscription to report — a pure trial account that never checked out has
 * `billing_accounts.subscription_status = null` until the first Stripe
 * subscription event lands (spec: chip only "when present"). Never throws
 * on an unrecognized status: falls back to a humanized version of the raw
 * string (`humanizeUnknownValue` above) at neutral tone.
 */
export function statusChip(subscriptionStatus: string | null): StatusChipInfo | null {
  if (!subscriptionStatus) return null;
  return (
    STATUS_CHIP[subscriptionStatus] ?? {
      label: humanizeUnknownValue(subscriptionStatus),
      tone: "neutral",
    }
  );
}

/** Pill classes per tone — same opacity-20/opacity-30 recipe as
 *  `lib/work-vocabulary.ts`'s `WORK_STATE_CHIP_CLASSNAME` and
 *  `goals/goals-helpers.ts`'s `GOAL_STATUS_TONE_CLASSNAME`, so this chip
 *  reads as the same visual language as the rest of the console. */
export const STATUS_CHIP_TONE_CLASSNAME: Record<SubscriptionStatusTone, string> = {
  neutral: "bg-[var(--gray-04)] text-[var(--gray-11)] border border-[var(--gray-06)]",
  positive:
    "bg-[var(--green-09)]/20 text-[var(--green-11)] border border-[var(--green-09)]/30",
  warning:
    "bg-[var(--yellow-09)]/15 text-[var(--yellow-11)] border border-[var(--yellow-09)]/30",
  critical: "bg-[var(--red-09)]/20 text-[var(--red-11)] border border-[var(--red-09)]/30",
};
