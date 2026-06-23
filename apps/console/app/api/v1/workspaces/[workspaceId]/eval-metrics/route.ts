/**
 * GET /api/v1/workspaces/[workspaceId]/eval-metrics
 *
 * Returns the per-arm metrics of the LATEST eval run recorded for this
 * workspace, or an explicit empty payload when no eval run has been ingested.
 * Session-authenticated; the caller must be a member of the workspace.
 *
 * These are the falsifiable numbers (solve-rate, dollars-per-solved-task,
 * Objective Gate false-green rate) the Context Quality page renders in place of
 * the always-zero context-quality placeholders (issue #942). NULL
 * dollars_per_solved / false_green_rate mean an undefined denominator and are
 * passed through as null, never coalesced to 0.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  getLatestEvalArmMetrics,
} from "@agentrail/db-postgres";

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

  const latest = await getLatestEvalArmMetrics(workspaceId);
  if (!latest) {
    return NextResponse.json({ run: null, arms: [] });
  }

  return NextResponse.json({
    run: { run_id: latest.runId, created_at: latest.createdAt.toISOString() },
    arms: latest.arms.map((a) => ({
      arm: a.arm,
      repetitions: a.repetitions,
      solved_count: a.solvedCount,
      failed_count: a.failedCount,
      solve_rate: a.solveRate,
      spread: a.spread,
      total_tokens: a.totalTokens,
      total_cost_usd: a.totalCostUsd,
      dollars_per_solved: a.dollarsPerSolved,
      gate_passed_count: a.gatePassedCount,
      false_green_count: a.falseGreenCount,
      false_green_rate: a.falseGreenRate,
    })),
  });
}
