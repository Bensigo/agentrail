import type { WorkspaceCapStatus } from "@agentrail/db-postgres";

/**
 * Pure formatting/derivation helpers for the workspace Budget page (#1272
 * PR ②). Kept in a plain `.ts` file (no JSX) so it can be unit-tested —
 * console vitest has no react plugin, mirrors the sibling convention
 * (`review-gates/blocking-reason.ts`, `components/digest-panel-helpers.ts`).
 * The page and its components stay thin, reading from here.
 */

/** $X.XX formatting, matching the convention already duplicated across this
 * app's cost surfaces (`digest-panel-helpers.ts`, `cost-meter-panel-helpers.ts`,
 * `cost-anomaly-helpers.ts`): sub-cent amounts get four decimals so they
 * don't silently round to "$0.00". */
export function formatCostUsd(usd: number): string {
  if (usd < 0.01 && usd > 0) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * The current UTC calendar month's half-open `[start, end)` window, as ISO
 * strings — feeds `listWorkspaceRunCosts` for "this month's runs". Mirrors
 * `packages/db-postgres/src/queries/workspace_costs.ts`'s private
 * `utcMonthWindow(0, now)` convention (same `Date.UTC(year, month, 1)` /
 * `Date.UTC(year, month + 1, 1)` construction) exactly — that helper is not
 * exported for this package to import (apps/console is a downstream
 * consumer, not a dependency, of `@agentrail/db-postgres`), so this is a
 * parallel implementation of the SAME convention, the same choice that
 * file's own doc-comment describes the claim route making. JS `Date.UTC`
 * normalizes an out-of-range month index by carrying into the year, so a
 * December window rolls over to next January with no special-casing.
 */
export function currentUtcMonthWindow(now: Date = new Date()): {
  startIso: string;
  endIso: string;
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Human month label from a `workspaceMonthlyCostRollup` "YYYY-MM" key, e.g.
 * "Jul 2026". `isPartial` marks the current (still-accruing) month
 * explicitly rather than letting it look like a closed, final total —
 * callers determine this by index (`workspaceMonthlyCostRollup` always
 * returns oldest-first, ending at the current partial month, so it's always
 * the last row), not by re-deriving "now" here.
 */
export function formatMonthLabel(monthKey: string, isPartial: boolean): string {
  const [yearStr, monthStr] = monthKey.split("-");
  const idx = Number(monthStr) - 1;
  const label = `${MONTH_NAMES[idx] ?? monthStr} ${yearStr}`;
  return isPartial ? `${label} (partial)` : label;
}

export interface CapStatusCopy {
  headline: string;
  detail: string;
  tone: "neutral" | "positive" | "critical";
}

/**
 * Honest, plain-English copy for the workspace's cap status — voice matches
 * `apps/console/app/api/v1/runner/claim/notify.ts`'s
 * `buildBudgetExhaustedMessage` (the Telegram ceiling-hit notice) so the
 * console and chat surfaces never disagree on what "exhausted" means for
 * this workspace. `exhausted` is deliberately the loudest (`critical`) tone
 * — it means new work is actually paused, not just a warning.
 */
export function capStatusCopy(
  status: WorkspaceCapStatus,
  spendUsd: number,
  budgetUsd: number | null
): CapStatusCopy {
  if (status === "exhausted" && budgetUsd !== null) {
    return {
      headline: "Monthly ceiling reached",
      detail: `${formatCostUsd(spendUsd)} of ${formatCostUsd(budgetUsd)} spent this month — new work is paused until the ceiling is raised.`,
      tone: "critical",
    };
  }
  if (status === "under" && budgetUsd !== null) {
    return {
      headline: "Under ceiling",
      detail: `${formatCostUsd(spendUsd)} of ${formatCostUsd(budgetUsd)} spent this month.`,
      tone: "positive",
    };
  }
  return {
    headline: "No ceiling set",
    detail: `${formatCostUsd(spendUsd)} spent this month — uncapped.`,
    tone: "neutral",
  };
}

/**
 * Spend-to-ceiling ratio, clamped to `[0, 1]`, for the overview strip's
 * progress bar (plain CSS width — no chart library). `null` when uncapped
 * (there is no ceiling to compare against, so no bar renders). A
 * non-positive ceiling is treated as fully exhausted rather than dividing by
 * zero — `getWorkspaceCostOverview`'s own `capStatus` comparison (`spend >=
 * ceiling`) would already call this "exhausted" for any non-negative spend.
 */
export function spendRatio(spendUsd: number, budgetUsd: number | null): number | null {
  if (budgetUsd === null) return null;
  if (budgetUsd <= 0) return 1;
  return Math.min(1, Math.max(0, spendUsd / budgetUsd));
}

export type RunStatus = "queued" | "running" | "success" | "failed";

const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  success: "Succeeded",
  failed: "Failed",
};

/**
 * Plain-English label for a run status — same enum and same labels as
 * `runs/components/run-status-label.ts` (this page owns its own copy
 * rather than importing across the runs/ feature boundary, matching this
 * codebase's established convention of page-local formatting helpers, e.g.
 * `formatCostUsd` above). Falls back to the raw string for anything
 * unrecognized so it stays total — never throws, never hides a value.
 */
export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABEL[status as RunStatus] ?? status;
}

/**
 * Whether the per-task list may be cut off: `listWorkspaceRunCosts` can never
 * return MORE than its limit, so a full page (`rowCount >= limit`) means the
 * month may hold more runs than shown — and the overview's monthly total (a
 * SQL SUM over ALL the month's runs) would then not reconcile with the sum of
 * visible rows. The page renders `truncatedRunListNote` exactly when this is
 * true so the mismatch is explained, not silent. A non-positive limit never
 * claims truncation (degenerate guard, mirrors the query's own clamp style).
 */
export function isRunListTruncated(rowCount: number, limit: number): boolean {
  return limit > 0 && rowCount >= limit;
}

/** The honesty note shown when `isRunListTruncated` — names the cap and says
 * the monthly total still covers everything. */
export function truncatedRunListNote(limit: number): string {
  return `Showing the ${limit} most recent runs — the monthly total covers all runs.`;
}

export interface RelativeTime {
  label: string;
  title: string;
}

/**
 * Relative time ("3m ago") with the absolute local time as the hover title —
 * same thresholds as `review-gates/page.tsx`'s inline `relTime`, extracted
 * here (instead of inline in a `.tsx` file) so it's unit-testable.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): RelativeTime {
  const d = new Date(iso);
  const diffMs = now.getTime() - d.getTime();
  const minutes = Math.round(diffMs / 60000);
  const hours = Math.round(diffMs / 3600000);
  const days = Math.round(diffMs / 86400000);
  const label =
    minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : hours < 24 ? `${hours}h ago` : `${days}d ago`;
  return { label, title: d.toLocaleString() };
}
