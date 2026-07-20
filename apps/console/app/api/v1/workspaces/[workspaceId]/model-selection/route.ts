/**
 * GET /api/v1/workspaces/[workspaceId]/model-selection
 *
 * #1338 PR③ observe view: per-task-type "which model is winning" breakdown —
 * every model ELIGIBLE for that task type (`eligibility.ts`), including ones
 * with zero recorded runs so far, alongside `run_outcomes` stats where they
 * exist. This route never calls `selector.ts`'s `selectExecuteModel` and
 * never exercises its ε-exploration: it is read-only insight into what the
 * selector is working with, not the selection path itself, so repeated
 * requests are stable and side-effect-free. `qualified` mirrors the
 * selector's own `DEFAULT_MIN_RUNS` sample-size bar so the observe view and
 * the live picker can't silently drift apart on what counts as "enough
 * data." Session-authenticated; the caller must be a member of the
 * workspace.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, getModelOutcomeStats } from "@agentrail/db-postgres";
import {
  ALL_TASK_TYPES,
  eligibleModelsForTaskType,
  isModelSelectionLearningEnabled,
  seedModel,
  MODEL_SEATS,
} from "../../../../../../lib/alignment";
import { DEFAULT_MIN_RUNS } from "../../../../../../lib/alignment/selector";

interface ModelBreakdownEntry {
  model: string;
  displayName: string;
  isSeed: boolean;
  qualified: boolean;
  runCount: number;
  successCount: number;
  successRate: number;
  avgCostUsd: number;
  costPerSuccess: number | null;
}

/** Sort qualified rows first (best success rate, then lowest cost-per-success —
 * a null cost, i.e. zero successes, never wins that tiebreak), unqualified
 * rows after, in the same relative order. Mirrors selector.ts's own exploit
 * ranking without its ε-exploration randomness. */
function compareModels(a: ModelBreakdownEntry, b: ModelBreakdownEntry): number {
  if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
  if (b.successRate !== a.successRate) return b.successRate - a.successRate;
  if (a.costPerSuccess === null && b.costPerSuccess === null) return 0;
  if (a.costPerSuccess === null) return 1;
  if (b.costPerSuccess === null) return -1;
  return a.costPerSuccess - b.costPerSuccess;
}

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

  const stats = await getModelOutcomeStats({ workspaceId });
  const statsByTaskAndModel = new Map<string, (typeof stats)[number]>();
  for (const row of stats) {
    if (row.taskType && row.executeModel) {
      statsByTaskAndModel.set(`${row.taskType}:${row.executeModel}`, row);
    }
  }

  const taskTypes = ALL_TASK_TYPES.map((taskType) => {
    const seed = seedModel(taskType).slug;

    const models: ModelBreakdownEntry[] = eligibleModelsForTaskType(taskType).map((model) => {
      const row = statsByTaskAndModel.get(`${taskType}:${model}`);
      const runCount = row?.runCount ?? 0;
      return {
        model,
        displayName: MODEL_SEATS[model]?.displayName ?? model,
        isSeed: model === seed,
        qualified: runCount >= DEFAULT_MIN_RUNS,
        runCount,
        successCount: row?.successCount ?? 0,
        successRate: row?.successRate ?? 0,
        avgCostUsd: row?.avgCostUsd ?? 0,
        costPerSuccess: row?.costPerSuccess ?? null,
      };
    });

    models.sort(compareModels);

    return { taskType, seedModel: seed, models };
  });

  return NextResponse.json({
    learningEnabled: isModelSelectionLearningEnabled(workspaceId),
    taskTypes,
  });
}
