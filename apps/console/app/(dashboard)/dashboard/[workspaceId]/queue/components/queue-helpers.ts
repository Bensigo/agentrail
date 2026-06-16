/**
 * Pure projection from the runs read model to **Issue Queue** entries for the
 * console queue view (M035, AC3). Mirrors CONTEXT.md vocabulary: each entry
 * carries its tier (which model), remaining budget, and state; every issue
 * leaves the queue in exactly one Run Outcome terminal (Green /
 * Escalated-to-human / Blocked).
 *
 * The execution state machine (`agentrail/afk/queue_state.py`) is the source of
 * truth; this is a read-model projection the console reads, never the reverse.
 * Runs are grouped into issues by branch — the same convention the
 * Cost-per-Issue-to-Green meter uses (escalation re-enqueues the same issue on
 * the same branch). State/tier/budget are derived from the issue's run history:
 *
 * - state: any run succeeded → `green`; else any running → `running`; else if
 *   all attempts failed and budget is exhausted → `escalated-to-human`; else
 *   `queued`.
 * - tier: first attempt runs on `cheap`; a retry means the cheap tier was red
 *   and the issue escalated to `strong` (queue_state's two tiers).
 * - remaining budget: the default per-issue budget less the failed attempts
 *   (queue_state decrements one budget unit per GATE_RED).
 *
 * This keeps the math falsifiable and unit-testable without a dedicated queue
 * table; a durable queue projection can replace the input later without
 * changing the view.
 */

/** Default per-issue budget, matching `queue_state.QueueEntry.remaining_budget`. */
export const DEFAULT_BUDGET = 2;

/** Non-terminal lifecycle states + the three Run Outcome terminals. */
export type QueueState =
  | "queued"
  | "running"
  | "green"
  | "escalated-to-human"
  | "blocked";

/** The two model tiers from `queue_state.Tier` (cheap → strong). */
export type QueueTier = "cheap" | "strong";

/** A run row as the queue projection needs it (subset of the runs read model). */
export interface QueueRunInput {
  id: string;
  branch: string;
  title: string | null;
  agent: string;
  status: string;
  createdAt: string;
}

/** One projected Issue Queue entry for display. */
export interface QueueEntryView {
  issueKey: string;
  title: string | null;
  agent: string;
  tier: QueueTier;
  remainingBudget: number;
  state: QueueState;
  attempts: number;
  failedAttempts: number;
  updatedAt: string;
}

/** Run statuses that count as a failed attempt (consume one budget unit). */
const FAILED_STATUSES = new Set(["failed", "error"]);

/**
 * Resolve an issue's queue state from its runs' statuses (in any order).
 * Pure and total: an unknown status is treated as not-yet-resolved (`queued`).
 */
export function resolveQueueState(statuses: string[]): QueueState {
  if (statuses.some((s) => s === "success")) return "green";
  if (statuses.some((s) => s === "running")) return "running";
  const failed = statuses.filter((s) => FAILED_STATUSES.has(s)).length;
  // Budget exhausted with no success and nothing in flight → hard stop.
  if (failed > 0 && failed >= DEFAULT_BUDGET) return "escalated-to-human";
  return "queued";
}

/** Tier follows escalation: first attempt cheap; any retry means strong. */
function resolveTier(attempts: number): QueueTier {
  return attempts > 1 ? "strong" : "cheap";
}

/** Group runs by branch (= one issue) and project each into a queue entry. */
export function projectQueueEntries(runs: QueueRunInput[]): QueueEntryView[] {
  const byBranch = new Map<string, QueueRunInput[]>();
  for (const run of runs) {
    const key = run.branch || run.id;
    const group = byBranch.get(key) ?? [];
    group.push(run);
    byBranch.set(key, group);
  }

  const entries: QueueEntryView[] = [];
  for (const [issueKey, group] of byBranch) {
    const statuses = group.map((r) => r.status);
    const failedAttempts = statuses.filter((s) => FAILED_STATUSES.has(s)).length;
    const attempts = group.length;
    const latest = group.reduce((a, b) =>
      a.createdAt >= b.createdAt ? a : b
    );
    entries.push({
      issueKey,
      title: latest.title,
      agent: latest.agent,
      tier: resolveTier(attempts),
      remainingBudget: Math.max(DEFAULT_BUDGET - failedAttempts, 0),
      state: resolveQueueState(statuses),
      attempts,
      failedAttempts,
      updatedAt: latest.createdAt,
    });
  }
  // Most-recently-active issue first (time is the primary axis, TASTE.md).
  entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return entries;
}

/** Human-readable label for a queue state, using CONTEXT.md wording. */
export function queueStateLabel(state: QueueState): string {
  switch (state) {
    case "green":
      return "Green";
    case "escalated-to-human":
      return "Escalated to human";
    case "blocked":
      return "Blocked";
    case "running":
      return "Running";
    case "queued":
    default:
      return "Queued";
  }
}
