// Pure client-side helpers for the Home "This week from Jace" digest panel
// (#1230). The response shape mirrors
// `app/api/v1/workspaces/[workspaceId]/digest/digest-helpers.ts`'s
// `DigestResponse`, kept as a separate (smaller) type here rather than a
// cross-route-boundary import — the same choice `health-panel-helpers.ts`
// makes for the health-rates panel.

/**
 * Re-exported here (type-only — erased at compile time, zero runtime cost)
 * so `digest-panel.tsx` can pull every digest-related type from this one
 * sibling module instead of reaching past it into `apps/console/lib/`.
 * Subscription slice 6 plan, Task 3
 * (`docs/superpowers/plans/2026-07-31-subscription-console-slice6.md`):
 * the client file must NEVER import `loadPlanCardData` or the
 * `subscriptionsEnforced` flag itself (server-only) — only this type.
 */
export type { PlanCardData } from "../../../../../lib/plan-card-data";

export interface DigestShippedItem {
  id: string;
  title: string;
  prUrl: string | null;
  finishedAt: string | null;
}

export interface DigestInProgressItem {
  id: string;
  title: string;
  state: "queued" | "running";
}

export interface DigestNeedsYouBreakdown {
  escalatedToHuman: number;
  parked: number;
}

export interface DigestNeedsYou {
  count: number;
  breakdown: DigestNeedsYouBreakdown;
}

export interface DigestCost {
  thisWeekUsd: number | null;
  previousWeekUsd: number | null;
  trendPct: number | null;
}

export interface DigestData {
  week: { start: string; end: string };
  shipped: DigestShippedItem[];
  inProgress: DigestInProgressItem[];
  needsYou: DigestNeedsYou;
  cost: DigestCost;
}

/**
 * spec §3 vocabulary (queued → Assigned, running → In progress). The shared
 * state→copy mapping module ships in ③ (Work); this stays consistent with it
 * so ③ can adopt it without a visual change on Home.
 */
export function inProgressStateLabel(state: "queued" | "running"): string {
  return state === "running" ? "In progress" : "Assigned";
}

/** Human date-range label, e.g. "Jul 13 – Jul 19, 2026", from the (exclusive-end) week ISO strings. */
export function formatWeekRangeLabel(week: { start: string; end: string }): string {
  const start = new Date(week.start);
  const end = new Date(week.end);
  end.setUTCDate(end.getUTCDate() - 1); // inclusive last day of the week
  const startLabel = start.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const endLabel = end.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${startLabel} – ${endLabel}`;
}

/** Needs-you breakdown as plain-language copy, e.g. "2 escalated to human, 1 blocked". */
export function formatNeedsYouBreakdown(breakdown: DigestNeedsYouBreakdown): string {
  const parts: string[] = [];
  if (breakdown.escalatedToHuman > 0) {
    parts.push(
      `${breakdown.escalatedToHuman} escalated to human`
    );
  }
  if (breakdown.parked > 0) {
    parts.push(`${breakdown.parked} blocked`);
  }
  return parts.join(", ");
}

/** ISO date (YYYY-MM-DD) for the week `deltaWeeks` away from `weekStartIso`. Feeds the panel's prev/next controls. */
export function shiftWeek(weekStartIso: string, deltaWeeks: number): string {
  const date = new Date(weekStartIso);
  date.setUTCDate(date.getUTCDate() + deltaWeeks * 7);
  return date.toISOString().slice(0, 10);
}

/**
 * True once the displayed week has reached the current week — there is no
 * "next" week to navigate to beyond it (Home never shows a future week).
 */
export function isAtOrPastCurrentWeek(week: { end: string }, now: Date): boolean {
  return new Date(week.end).getTime() > now.getTime();
}

/**
 * Pinned capacity copy for the digest plan card (subscription slice 6 plan,
 * Global Constraints — byte-exact): tasks, never dollars — `used`/`total`
 * are plain run counts (`PlanCardData.capacityUsed`/`capacityTotal`), not
 * spend.
 */
export function capacityText(used: number, total: number): string {
  return `${used} of ${total} tasks this month`;
}

/**
 * Pinned copy for the digest plan card's no-plan seats row (2026-08-02
 * owner ruling — no customer-facing trial): an un-subscribed account
 * (`PlanCardData.hasPlan === false`) has no seat ENTITLEMENT to show a
 * fraction against, so this reports raw usage only — never
 * {@link capacityText}'s neighbor `${used} of ${total}` shape, which would
 * falsely claim a plan the account doesn't have. Mirrors
 * `billing-helpers.ts`'s `seatsInUseLabel` (same copy, same ruling, kept as
 * a separate function rather than a shared import — this file's own
 * doc-comment already states client code here never reaches past
 * `lib/plan-card-data.ts`'s types into server-only modules).
 */
export function seatsInUseText(n: number): string {
  return `${n} in use`;
}

/**
 * Pinned copy for the digest plan card's no-plan capacity row — same
 * usage-only rationale as {@link seatsInUseText} above; still tasks, never
 * dollars (Global Constraints).
 */
export function capacityUsedText(n: number): string {
  return `${n} tasks this month`;
}

/**
 * Pinned copy for the digest's all-time-shipped strip (subscription slice 6
 * plan, Task 3): `n` is `PlanCardData.shippedAllTime` (all-time `success`
 * run outcomes for the workspace), never dollars. No singular/plural
 * branching — matches this file's other counters (`formatNeedsYouBreakdown`)
 * and the house "never editorializes" posture (`goalStatusLabel` etc.).
 */
export function shippedStripText(n: number): string {
  return `${n} tasks shipped all-time`;
}
