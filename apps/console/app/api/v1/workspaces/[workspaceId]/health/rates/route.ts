import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listRuns } from "@agentrail/db-postgres";
import { computeHealthRates, type IssueOutcome } from "@agentrail/db-clickhouse";

/** Default per-issue budget, matching queue_state.QueueEntry.remaining_budget. */
const DEFAULT_BUDGET = 2;
/** Run statuses that count as a failed attempt (consume one budget unit). */
const FAILED_STATUSES = new Set(["failed", "error"]);

const EMPTY_RATES = {
  attempted: 0,
  green: 0,
  escalated: 0,
  acceptRate: null as number | null,
  escalationRate: null as number | null,
  belowHealthLine: false,
};

/**
 * Project one issue's run statuses to its Run Outcome terminal (or in-flight),
 * mirroring agentrail/afk/queue_state.py and the console queue projection:
 *
 * - any run succeeded            → green (Objective Gate + verification pass)
 * - else any run still running   → in-flight (not yet graded)
 * - else failed attempts ≥ budget → escalated-to-human (a hard stop fired)
 * - else                          → in-flight (queued, budget remaining)
 *
 * Blocked (an unmet blocked-by dependency) is not derivable from run status
 * alone, so it never appears here — and the accept/escalation denominator
 * excludes it by construction.
 */
function resolveOutcome(statuses: string[]): IssueOutcome {
  if (statuses.some((s) => s === "success")) return "green";
  if (statuses.some((s) => s === "running")) return "in-flight";
  const failed = statuses.filter((s) => FAILED_STATUSES.has(s)).length;
  if (failed > 0 && failed >= DEFAULT_BUDGET) return "escalated-to-human";
  return "in-flight";
}

/**
 * Falsifiable system-health surface (M034 / ADR 0009): accept rate
 * (green ÷ attempted) and escalation rate (escalated ÷ attempted). Runs are
 * grouped into issues by branch — the same convention as the
 * Cost-per-Issue-to-Green meter (escalation re-enqueues the same issue on the
 * same branch) — then each issue's terminal outcome feeds computeHealthRates.
 * Accept rate can come back below the 50% health line for a losing loop, which
 * is what makes it falsifiable.
 */
export async function GET(
  _request: NextRequest,
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

  let outcomes: IssueOutcome[] = [];
  try {
    const runs = (await listRuns(workspaceId)) as {
      id: string;
      branch: string;
      status: string;
    }[];
    const byBranch = new Map<string, string[]>();
    for (const run of runs) {
      const issueKey = run.branch || run.id;
      const group = byBranch.get(issueKey) ?? [];
      group.push(run.status);
      byBranch.set(issueKey, group);
    }
    outcomes = [...byBranch.values()].map(resolveOutcome);
  } catch {
    return NextResponse.json({ rates: EMPTY_RATES });
  }

  const rates = computeHealthRates(outcomes);
  return NextResponse.json({ rates });
}
