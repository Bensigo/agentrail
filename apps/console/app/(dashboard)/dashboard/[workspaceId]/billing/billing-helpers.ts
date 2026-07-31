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
 * `timeZone: "UTC"` makes the label deterministic regardless of the host's
 * local timezone (same recipe as `../components/digest-panel-helpers.ts`'s
 * `formatWeekRangeLabel`) — a stored `timestamptz` should read as the same
 * calendar date to every viewer, never shift a day depending on where the
 * server (or a test runner) happens to sit relative to UTC. Shared by
 * `renewalLabel` ("Renews <date>") and `seatClaimedLabel` ("Claimed <date>")
 * below — same date format, different prefix — so the two never drift apart
 * on the actual `toLocaleDateString` options.
 *
 * Exported (subscription-platform slice 6 plan, Task 2's own Global
 * Constraints — the plan-card's pinned trial renewal string,
 * `` `Trial ends ${formatUtcDate(trialEndsAt)}` ``): `plan-card-data.ts`
 * (`apps/console/lib/`) needs the SAME date formatting `renewalLabel` uses
 * so the trial and non-trial renewal strings read identically, without a
 * second, drift-prone copy of this `toLocaleDateString` call.
 */
export function formatUtcDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * "Renews <date>" from `current_period_end`, or a plain no-subscription
 * notice when null — null covers both a pure trial account (never checked
 * out) and a canceled subscription (the webhook nulls this column on
 * cancellation, `stripe/webhook/route.ts`'s `handleSubscriptionDeleted`),
 * which is intentional: neither case has a renewal to report.
 */
export function renewalLabel(currentPeriodEnd: Date | null): string {
  if (!currentPeriodEnd) return "No active subscription";
  return `Renews ${formatUtcDate(currentPeriodEnd)}`;
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

/**
 * True only when the workspace has no live Stripe subscription yet — the
 * gate for whether the Plan & billing page may offer the self-serve
 * checkout buttons at all.
 *
 * Final whole-slice review, Critical: nothing previously stopped an
 * already-subscribed billing account from starting a SECOND, independent
 * Stripe subscription — `billing/page.tsx` rendered `CheckoutButtons`
 * whenever Stripe was configured, with no dependence on the account's
 * subscription state, and `createSubscriptionCheckoutSessionAction` never
 * read `stripeSubscriptionId` before calling
 * `stripe.checkout.sessions.create`. A Starter customer clicking "Growth"
 * got TWO live subscriptions, and since `applySubscriptionStateForStripeEvent`
 * (the webhook) is last-write-wins, one kept billing invisibly. Once a
 * workspace has a subscription, plan changes go through the Stripe customer
 * portal instead (`createPortalSessionAction`) — Stripe's own portal already
 * handles upgrade/downgrade/cancel for an existing subscription, so this app
 * doesn't reimplement that as a second checkout.
 *
 * This is the UI-hiding half only. `createSubscriptionCheckoutSessionAction`
 * (`actions.ts`) re-checks the same field server-side, independent of this
 * function and of whatever the page renders — UI hiding alone is not
 * enforcement.
 *
 * Takes a minimal inline shape rather than the full `BillingAccountRow` —
 * this is the one field the decision turns on, same "narrowest input type"
 * posture as this file's other helpers (`renewalLabel` takes a bare
 * `Date | null`, not the whole row).
 */
export function canStartCheckout(account: { stripeSubscriptionId: string | null }): boolean {
  return account.stripeSubscriptionId === null;
}

// --- Seats list (slice-4 plan Task 5, "seats list with release") ----------

/**
 * "Claimed <date>" for one seats-list row — reuses {@link formatUtcDate}
 * so a seat's claim date reads as the same calendar day to every viewer as
 * `renewalLabel`'s own date above, for the same reason (see that function's
 * doc-comment: a stored `timestamptz` must never shift a day depending on
 * the host's local timezone).
 */
export function seatClaimedLabel(claimedAt: Date): string {
  return `Claimed ${formatUtcDate(claimedAt)}`;
}

/**
 * Known keys mirror `claimSeat`'s own `claimedVia` union
 * (`@agentrail/db-postgres`'s `queries/seats.ts`) — `console` (an invite
 * accept or a served console chat turn) plus the three chat platforms.
 * `SeatWithHolder.claimedVia` itself is typed as a plain `string`, not that
 * union — same "DB cast is a compile-time-only promise" posture as
 * `planLabel`/`statusChip` above — so an unrecognized future value falls
 * back to `humanizeUnknownValue` rather than rendering `undefined` or a raw
 * snake_case string on the seat row's channel badge.
 */
const CLAIMED_VIA_LABEL: Record<string, string> = {
  console: "Console",
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
};

/** The seats-list row's channel badge text — see `CLAIMED_VIA_LABEL` above. */
export function claimedViaLabel(claimedVia: string): string {
  return CLAIMED_VIA_LABEL[claimedVia] ?? humanizeUnknownValue(claimedVia);
}

/**
 * The per-seat Release button's `aria-label`. A list with one "Release"
 * button per row is ambiguous to a screen reader — which seat does THIS one
 * release? — so this disambiguates using the same `holderLabel` the row's
 * own visible text already shows. Never a raw id either way:
 * `SeatWithHolder.holderLabel` is guaranteed non-UUID by `deriveSeatHolder`
 * (`queries/seats.ts`, house display rule `ui-prefer-names-over-ids`), and
 * this function does nothing but interpolate whatever string it's handed.
 */
export function releaseSeatButtonLabel(holderLabel: string): string {
  return `Release seat for ${holderLabel}`;
}
