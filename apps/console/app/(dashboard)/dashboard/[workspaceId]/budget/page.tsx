import Link from "next/link";
import { notFound } from "next/navigation";
import {
  DEFAULT_RUN_COST_LIST_LIMIT,
  getWorkspaceCostOverview,
  listWorkspaceRunCosts,
  workspaceMonthlyCostRollup,
} from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import { PageHeader } from "../../../../components/page-header";
import {
  currentUtcMonthWindow,
  isRunListTruncated,
  truncatedRunListNote,
} from "./budget-helpers";
import { OverviewStrip } from "./components/overview-strip";
import { TaskCostTable } from "./components/task-cost-table";
import { MonthlyRollupTable } from "./components/monthly-rollup-table";

/**
 * Workspace Budget page (#1272 PR ②, AC1/AC2): real per-task and monthly
 * costs from the #1272 PR ① query layer, plus the #1269 workspace monthly
 * ceiling's cap status — a server component reading the queries directly
 * (no client fetch, no new API route).
 *
 * Auth mirrors the sibling workspace pages exactly (e.g.
 * `dashboard/[workspaceId]/page.tsx`, `api-keys/page.tsx`): the workspace
 * layout already guards session + membership, this re-checks defensively
 * rather than trusting that every future caller of this component goes
 * through that layout.
 */
export default async function BudgetPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const session = await getSession();
  if (!session?.user?.id) return notFound();

  const membership = await getMembership(session.user.id, workspaceId);
  if (!membership) return notFound();

  const { startIso, endIso } = currentUtcMonthWindow();

  // Limit passed explicitly so the truncation check below and the query can
  // never drift onto different numbers.
  const runListLimit = DEFAULT_RUN_COST_LIST_LIMIT;
  const [overview, tasks, monthly] = await Promise.all([
    getWorkspaceCostOverview(workspaceId),
    listWorkspaceRunCosts(workspaceId, startIso, endIso, runListLimit),
    workspaceMonthlyCostRollup(workspaceId),
  ]);

  // Defensive, mirrors getWorkspaceCostOverview's own contract: null only
  // when the workspace row itself doesn't exist — practically unreachable
  // once membership resolved, but the query documents it, so this does too.
  if (!overview) return notFound();

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader
        title="Budget"
        subtitle="What this workspace has spent, against its monthly ceiling."
      />

      <div className="flex flex-col gap-6">
        <OverviewStrip overview={overview} />

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
            This month&apos;s runs
          </h2>
          <TaskCostTable rows={tasks} />
          {isRunListTruncated(tasks.length, runListLimit) && (
            <p className="text-xs text-[var(--gray-09)]">
              {truncatedRunListNote(runListLimit)}
            </p>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
            Monthly trend
          </h2>
          <MonthlyRollupTable rows={monthly} />
        </section>

        <div className="flex flex-col gap-1">
          <p className="text-xs text-[var(--gray-09)]">
            Costs are recorded when a run completes — spend from work still in progress isn&apos;t
            reflected here yet.
          </p>
          <p className="text-xs text-[var(--gray-09)]">
            See also:{" "}
            <Link
              href={`/dashboard/${workspaceId}/costs`}
              className="text-[var(--blue-11)] hover:underline"
            >
              Costs
            </Link>{" "}
            — per-issue and per-model token breakdowns.
          </p>
        </div>
      </div>
    </div>
  );
}
