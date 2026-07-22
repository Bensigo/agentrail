import type { Goal } from "@agentrail/db-postgres";
import { goalStatusLabel, goalStatusPillClassName } from "../goals-helpers";

/** One goal's lifecycle status, rendered the same pill shape as
 * `work-state-chip.tsx` (px-1.5/py-0.5, rounded-sm, text-xs font-medium) so
 * it reads as the same visual language as the rest of the console. */
export function GoalStatusPill({ status }: { status: Goal["status"] }) {
  return (
    <span
      className={`inline-flex w-fit shrink-0 items-center rounded-sm px-1.5 py-0.5 text-xs font-medium ${goalStatusPillClassName(status)}`}
    >
      {goalStatusLabel(status)}
    </span>
  );
}
