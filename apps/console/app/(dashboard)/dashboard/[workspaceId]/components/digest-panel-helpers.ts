// Pure client-side helpers for the Home "This week from Jace" digest panel
// (#1230). The response shape mirrors
// `app/api/v1/workspaces/[workspaceId]/digest/digest-helpers.ts`'s
// `DigestResponse`, kept as a separate (smaller) type here rather than a
// cross-route-boundary import — the same choice `health-panel-helpers.ts`
// makes for the health-rates panel.

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

export function formatCostUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Trend copy with a sign; null → no baseline to compare against. */
export function formatTrendPct(trendPct: number | null): string {
  if (trendPct === null) return "No prior-week data to compare";
  const rounded = Math.round(trendPct);
  if (rounded === 0) return "No change vs last week";
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded}% vs last week`;
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
