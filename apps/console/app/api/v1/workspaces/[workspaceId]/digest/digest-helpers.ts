/**
 * Pure aggregation for the Home "This week from Jace" digest (#1230). Takes
 * already-fetched rows (Postgres runs/queue_entries + ClickHouse cost
 * aggregates) and produces the four-block digest payload. The route
 * (`route.ts`) does all the I/O — including degrading a failed ClickHouse
 * query to `cost: null` — so this file has none and is fully unit-testable
 * without a database.
 *
 * Vocabulary note (spec §3, `docs/superpowers/specs/2026-07-09-console-
 * fractional-engineer-redesign.md`): user-facing copy speaks "Shipped / In
 * progress / Needs you" — never queue_entry/tier/remaining_budget. The full
 * state→copy mapping function ships in ③ (Work); this file only needs the
 * narrow slice that feeds Home.
 */

export interface WeekRange {
  /** Monday 00:00:00.000 UTC of the week. */
  start: Date;
  /** The following Monday 00:00:00.000 UTC — exclusive upper bound. */
  end: Date;
}

/**
 * Snap any date to the Monday that starts its week (spec: "weeks start
 * Monday"). Pure and timezone-stable — always computed in UTC so the same
 * input date yields the same week boundary regardless of server TZ.
 */
export function resolveWeekStart(date: Date): Date {
  const truncated = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  const day = truncated.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const daysSinceMonday = (day + 6) % 7; // Monday = 0
  truncated.setUTCDate(truncated.getUTCDate() - daysSinceMonday);
  return truncated;
}

/** The Monday–Monday (exclusive) range for the week containing `date`. */
export function getWeekRange(date: Date): WeekRange {
  const start = resolveWeekStart(date);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { start, end };
}

/** The week immediately before the one containing `date`. */
export function getPreviousWeekRange(date: Date): WeekRange {
  const { start } = getWeekRange(date);
  const previousStart = new Date(start);
  previousStart.setUTCDate(previousStart.getUTCDate() - 7);
  return { start: previousStart, end: start };
}

// ---------------------------------------------------------------------------
// Input row shapes (subset of the Postgres/ClickHouse read models).
// ---------------------------------------------------------------------------

export interface DigestRunRow {
  id: string;
  title: string | null;
  prUrl: string | null;
  finishedAt: string | Date | null;
  createdAt: string | Date;
}

/** In-progress and needs-you rows both come from `queue_entries`. */
export interface DigestQueueEntryRow {
  id: string;
  externalId: string;
  title: string;
  state: string;
  updatedAt: string | Date;
}

export interface DigestCostRow {
  total_cost_usd: number;
}

export interface BuildDigestInput {
  week: WeekRange;
  /** Runs with status='success' whose createdAt falls in `week` (route pre-filters). */
  shippedRuns: DigestRunRow[];
  /** queue_entries with state in ('queued', 'running') (route pre-filters). */
  inProgressEntries: DigestQueueEntryRow[];
  /** queue_entries with state in ('escalated-to-human', 'parked') (route pre-filters). */
  needsYouEntries: DigestQueueEntryRow[];
  /** null signals the ClickHouse query failed — degrade to cost:null, not a 500. */
  thisWeekCostRows: DigestCostRow[] | null;
  previousWeekCostRows: DigestCostRow[] | null;
}

// ---------------------------------------------------------------------------
// Output shape.
// ---------------------------------------------------------------------------

export interface ShippedItem {
  id: string;
  title: string;
  prUrl: string | null;
  finishedAt: string | null;
}

export interface InProgressItem {
  id: string;
  title: string;
  state: "queued" | "running";
}

export interface NeedsYouBreakdown {
  escalatedToHuman: number;
  parked: number;
}

export interface CostBlock {
  thisWeekUsd: number | null;
  previousWeekUsd: number | null;
  /**
   * Percent change vs. previous week (positive = spent more). Null when it
   * can't be computed: either week's total is unavailable (ClickHouse down),
   * or there's no baseline to compare against (previous week was $0 but this
   * week isn't — a percentage from zero is undefined, not infinite).
   */
  trendPct: number | null;
}

export interface DigestResponse {
  week: { start: string; end: string };
  shipped: ShippedItem[];
  inProgress: InProgressItem[];
  needsYou: { count: number; breakdown: NeedsYouBreakdown };
  cost: CostBlock;
}

function sumCost(rows: DigestCostRow[]): number {
  return rows.reduce((total, row) => total + (row.total_cost_usd || 0), 0);
}

/** Percent change from `previous` to `current`; null when undefined (no baseline / no data). */
export function computeTrendPct(
  current: number | null,
  previous: number | null
): number | null {
  if (current === null || previous === null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

/** Combine escalated-to-human + parked queue entries into one "needs you" count + breakdown. */
function combineNeedsYou(entries: DigestQueueEntryRow[]): {
  count: number;
  breakdown: NeedsYouBreakdown;
} {
  const escalatedToHuman = entries.filter(
    (e) => e.state === "escalated-to-human"
  ).length;
  const parked = entries.filter((e) => e.state === "parked").length;
  return {
    count: escalatedToHuman + parked,
    breakdown: { escalatedToHuman, parked },
  };
}

function isoOrNull(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Rows in, digest out. No I/O — the route does all fetching and
 * degrade-on-error handling; this function only shapes what it's given.
 */
export function buildDigest(input: BuildDigestInput): DigestResponse {
  const shipped: ShippedItem[] = input.shippedRuns.map((run) => ({
    id: run.id,
    title: run.title?.trim() || "Untitled",
    prUrl: run.prUrl || null,
    finishedAt: isoOrNull(run.finishedAt) ?? isoOrNull(run.createdAt),
  }));

  const inProgress: InProgressItem[] = input.inProgressEntries
    .filter(
      (e): e is DigestQueueEntryRow & { state: "queued" | "running" } =>
        e.state === "queued" || e.state === "running"
    )
    .map((entry) => ({
      id: entry.id,
      title: entry.title?.trim() || entry.externalId,
      state: entry.state,
    }));

  const needsYou = combineNeedsYou(input.needsYouEntries);

  const thisWeekUsd =
    input.thisWeekCostRows === null ? null : sumCost(input.thisWeekCostRows);
  const previousWeekUsd =
    input.previousWeekCostRows === null ? null : sumCost(input.previousWeekCostRows);

  return {
    week: {
      start: input.week.start.toISOString(),
      end: input.week.end.toISOString(),
    },
    shipped,
    inProgress,
    needsYou,
    cost: {
      thisWeekUsd,
      previousWeekUsd,
      trendPct: computeTrendPct(thisWeekUsd, previousWeekUsd),
    },
  };
}
