import type { Goal } from "@agentrail/db-postgres";
import { formatCostUsd, leashRatio } from "../goals-helpers";
import { GoalStatusPill } from "./goal-status-pill";
import { LeashMeter } from "./leash-meter";

/**
 * One active goal — objective, status pill, and its live leash progress
 * (issues filed / max, spend / max ceiling). This IS the "is Jace still
 * safely bounded on this goal" answer (#1289's leash+stuck-rule guarantee,
 * `goal_rules.ts`), so both counters are always shown, never just one.
 */
export function ActiveGoalCard({ goal }: { goal: Goal }) {
  return (
    <div className="flex flex-col gap-3 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-[var(--gray-12)]">{goal.objective}</p>
        <GoalStatusPill status={goal.status} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <LeashMeter
          label="Issues filed"
          display={`${goal.issuesFiled}/${goal.maxIssues}`}
          ratio={leashRatio(goal.issuesFiled, goal.maxIssues)}
        />
        <LeashMeter
          label="Spend"
          display={`${formatCostUsd(goal.spendUsd)} / ${formatCostUsd(goal.maxSpendUsd)}`}
          ratio={leashRatio(goal.spendUsd, goal.maxSpendUsd)}
        />
      </div>
    </div>
  );
}
