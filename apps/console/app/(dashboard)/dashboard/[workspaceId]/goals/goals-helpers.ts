import type { Goal } from "@agentrail/db-postgres";

/**
 * Pure formatting/derivation helpers for the workspace Goals page (#1289
 * AC2 — the goal loop shipped with no UI showing goals at all). Kept in a
 * plain `.ts` file (no JSX) so it can be unit-tested — console vitest has
 * no react plugin, mirrors the sibling convention (`budget/budget-helpers.ts`,
 * `review-gates/blocking-reason.ts`). The page and its card components stay
 * thin, reading from here.
 */

/** $X.XX formatting — same convention duplicated across this app's cost
 * surfaces (`budget-helpers.ts`'s own `formatCostUsd`): sub-cent amounts get
 * four decimals so they don't silently round to "$0.00". Each page owns its
 * own copy rather than importing across the feature boundary (established
 * convention — see `runner/goals/route.ts`'s own `slugify` doc-comment). */
export function formatCostUsd(usd: number): string {
  if (usd < 0.01 && usd > 0) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

const GOAL_STATUS_LABEL: Record<Goal["status"], string> = {
  active: "Active",
  reached: "Reached",
  leashed: "Leashed",
  paused: "Paused",
  abandoned: "Abandoned",
};

/** Human label for a goal's lifecycle status. Falls back to the raw string
 * for anything unrecognized so it stays total — never throws. */
export function goalStatusLabel(status: Goal["status"]): string {
  return GOAL_STATUS_LABEL[status] ?? status;
}

type GoalStatusTone = "neutral" | "positive" | "critical" | "warning";

/**
 * Tone per status, chosen to match this codebase's existing status-color
 * vocabulary rather than invent a new one: `reached` = positive/green (a
 * genuine success, same as Work's `green` state); `leashed` = critical/red
 * (the goal hit its issue or spend ceiling and stopped — same semantic as
 * `OverviewStrip`'s "exhausted" cap status); `paused` = warning/yellow (the
 * stuck rule tripped, needs a human look — same as Work's `blocked`);
 * `abandoned` = neutral/gray (a human chose to stop it, not a failure);
 * `active` = neutral/gray (in progress, nothing alarming — the calm default,
 * matching `OverviewStrip`'s own "neutral" tone for "no ceiling set").
 */
const GOAL_STATUS_TONE: Record<Goal["status"], GoalStatusTone> = {
  active: "neutral",
  reached: "positive",
  leashed: "critical",
  paused: "warning",
  abandoned: "neutral",
};

/** Pill background/text/border classes per tone — same opacity-20/opacity-30
 * recipe as `lib/work-vocabulary.ts`'s `WORK_STATE_CHIP_CLASSNAME`, so a goal
 * pill and a Work-state chip read as the same visual language. */
const GOAL_STATUS_TONE_CLASSNAME: Record<GoalStatusTone, string> = {
  neutral: "bg-[var(--gray-04)] text-[var(--gray-11)] border border-[var(--gray-06)]",
  positive:
    "bg-[var(--green-09)]/20 text-[var(--green-11)] border border-[var(--green-09)]/30",
  critical: "bg-[var(--red-09)]/20 text-[var(--red-11)] border border-[var(--red-09)]/30",
  warning:
    "bg-[var(--yellow-09)]/15 text-[var(--yellow-11)] border border-[var(--yellow-09)]/30",
};

/** The pill's className for a goal's current status. */
export function goalStatusPillClassName(status: Goal["status"]): string {
  return GOAL_STATUS_TONE_CLASSNAME[GOAL_STATUS_TONE[status] ?? "neutral"];
}

const TERMINAL_FALLBACK_REASON: Partial<Record<Goal["status"], string>> = {
  reached: "The goal's check was satisfied.",
  leashed: "Stopped automatically after hitting its issue or spend limit.",
  paused: "Paused after repeated non-green outcomes — needs a human look.",
  abandoned: "Manually abandoned.",
};

/**
 * The honest, human-readable answer to "why did this goal end this way" —
 * the whole point of the Done section (a human needs to see success vs.
 * stopped, not just a status word). `statusReason` is already a precise,
 * human string produced by `decideGoalTransition`/the manual escape hatches
 * (e.g. "leash exhausted: issues filed 10/10", "stuck: 2 consecutive
 * non-green outcomes (threshold 2)", "check reached: 5/5 green outcomes") —
 * this displays it verbatim (sentence-cased), never re-deriving or
 * paraphrasing it, so the UI can never drift from what actually decided the
 * transition. Falls back to a generic per-status sentence only for the
 * (should-never-happen-in-practice) case of a terminal goal with no reason
 * recorded — total, never throws, never blank.
 */
export function goalEndedReason(goal: Pick<Goal, "status" | "statusReason">): string {
  const reason = goal.statusReason?.trim();
  if (reason && reason.length > 0) {
    return reason.charAt(0).toUpperCase() + reason.slice(1);
  }
  return TERMINAL_FALLBACK_REASON[goal.status] ?? "Stopped.";
}

/** Progress ratio clamped to `[0, 1]` for a leash meter (issues or spend).
 * A non-positive max is treated as fully exhausted rather than dividing by
 * zero, same defensive posture as `budget-helpers.ts`'s `spendRatio`. */
export function leashRatio(value: number, max: number): number {
  if (max <= 0) return 1;
  return Math.min(1, Math.max(0, value / max));
}

export interface RelativeTime {
  label: string;
  title: string;
}

/** Relative time ("3d ago") with the absolute local time as the hover title
 * — same thresholds as `budget-helpers.ts`'s own `formatRelativeTime` /
 * `review-gates/page.tsx`'s inline `relTime`, duplicated here rather than
 * imported (page-local helpers convention, see this file's header comment). */
export function formatRelativeTime(iso: string | Date, now: Date = new Date()): RelativeTime {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const diffMs = now.getTime() - d.getTime();
  const minutes = Math.round(diffMs / 60000);
  const hours = Math.round(diffMs / 3600000);
  const days = Math.round(diffMs / 86400000);
  const label =
    minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : hours < 24 ? `${hours}h ago` : `${days}d ago`;
  return { label, title: d.toLocaleString() };
}
