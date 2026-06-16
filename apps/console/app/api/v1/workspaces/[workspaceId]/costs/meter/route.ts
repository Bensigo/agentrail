import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listRuns } from "@agentrail/db-postgres";
import {
  getCacheReadCreationRatio,
  getRunCostTotals,
  getAgentCostBreakdown,
  computeCostPerIssueToGreen,
  type IssueGroup,
} from "@agentrail/db-clickhouse";

function parseIsoDateParam(value: string | null, name: string) {
  if (value === null || value === "") return { date: undefined };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { error: `${name} must be a valid ISO date` };
  }
  return { date };
}

const EMPTY_CACHE_RATIO = {
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  ratio: null as number | null,
};

const EMPTY_COST_PER_ISSUE = {
  issues: [] as { issueKey: string; costUsd: number }[],
  greenIssueCount: 0,
  avgCostUsd: null as number | null,
};

/**
 * Falsifiable cost surface (M033): Cost-per-Issue-to-Green and the cache
 * read-to-creation ratio. Runs are grouped into issues by branch (escalation
 * re-enqueues the same issue on the same branch); an issue reached Green when
 * any of its runs has status='success' (Objective Gate passed).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const searchParams = request.nextUrl.searchParams;
  const timeFrom = parseIsoDateParam(searchParams.get("time_from"), "time_from");
  if (timeFrom.error) {
    return NextResponse.json({ error: timeFrom.error }, { status: 400 });
  }
  const timeTo = parseIsoDateParam(searchParams.get("time_to"), "time_to");
  if (timeTo.error) {
    return NextResponse.json({ error: timeTo.error }, { status: 400 });
  }

  const opts = { timeFrom: timeFrom.date, timeTo: timeTo.date };

  // Group runs → issues by branch; mark Green when any run succeeded.
  let issueGroups: IssueGroup[] = [];
  let runIds: string[] = [];
  try {
    const runs = (await listRuns(workspaceId)) as {
      id: string;
      branch: string;
      status: string;
    }[];
    const byBranch = new Map<string, IssueGroup>();
    for (const run of runs) {
      const issueKey = run.branch || run.id;
      const group =
        byBranch.get(issueKey) ??
        ({ issueKey, runIds: [], reachedGreen: false } as IssueGroup);
      group.runIds.push(run.id);
      if (run.status === "success") group.reachedGreen = true;
      byBranch.set(issueKey, group);
    }
    issueGroups = [...byBranch.values()];
    runIds = issueGroups.flatMap((g) => g.runIds);
  } catch {
    issueGroups = [];
    runIds = [];
  }

  const [cacheRatio, runCosts, agentBreakdown] = await Promise.all([
    getCacheReadCreationRatio(workspaceId, opts).catch(() => EMPTY_CACHE_RATIO),
    // null (not []) signals a fetch failure so we can distinguish "no cost data"
    // from a genuine $0 cost-to-green.
    getRunCostTotals(workspaceId, runIds).catch(() => null),
    getAgentCostBreakdown(workspaceId, opts).catch(() => []),
  ]);

  const costPerIssueToGreen =
    runIds.length > 0 && runCosts !== null
      ? computeCostPerIssueToGreen(runCosts, issueGroups)
      : EMPTY_COST_PER_ISSUE;

  return NextResponse.json({ costPerIssueToGreen, cacheRatio, agentBreakdown });
}
