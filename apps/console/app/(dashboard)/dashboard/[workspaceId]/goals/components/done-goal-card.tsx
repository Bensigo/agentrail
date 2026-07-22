import type { Goal } from "@agentrail/db-postgres";
import { formatCostUsd, formatRelativeTime, goalEndedReason } from "../goals-helpers";
import { GoalStatusPill } from "./goal-status-pill";

/**
 * One terminal goal — objective, its final status, and WHY it ended
 * (`goalEndedReason`: reached its check / hit the leash / stuck / manually
 * abandoned). This status+reason pairing is the entire point of the Done
 * section (spec: "a human needs to see whether a goal succeeded or was
 * stopped") — never rendered as just a status word on its own.
 *
 * A flat row, not a card with its own progress bars: the leash is no longer
 * moving (every non-`active` status is TERMINAL, `goal_rules.ts`'s own
 * guarantee), so the final counters are shown as plain settled numbers, not
 * a live meter that would misleadingly suggest more could still happen.
 */
export function DoneGoalCard({ goal }: { goal: Goal }) {
  const ended = formatRelativeTime(goal.updatedAt);
  return (
    <div className="flex flex-col gap-2 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-[var(--gray-12)]">{goal.objective}</p>
        <GoalStatusPill status={goal.status} />
      </div>

      <p className="text-xs text-[var(--gray-10)]">{goalEndedReason(goal)}</p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--gray-09)]">
        <span>
          Issues <span className="font-mono text-[var(--gray-11)]">{goal.issuesFiled}/{goal.maxIssues}</span>
        </span>
        <span>
          Spend{" "}
          <span className="font-mono text-[var(--gray-11)]">
            {formatCostUsd(goal.spendUsd)} / {formatCostUsd(goal.maxSpendUsd)}
          </span>
        </span>
        <span title={ended.title}>Ended {ended.label}</span>
      </div>
    </div>
  );
}
