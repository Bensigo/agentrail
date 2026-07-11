import { NextRequest, NextResponse } from "next/server";
import {
  getRun,
  getReviewGatesForRun,
  touchApiKeyLastUsed,
} from "@agentrail/db-postgres";
import {
  getFailuresForRun,
  getRunEventsByRunId,
} from "@agentrail/db-clickhouse";
import { requireBearer } from "../../../../../lib/bearer-auth";

/**
 * GET /api/v1/runner/failure-bundle?run_id=…
 *
 * The single read a triage step needs to diagnose a failed run: the run row,
 * its failure_events (WITH the bounded/scrubbed evidence excerpt the producers
 * now populate — #1146), its review-gate verdicts, and the run-event timeline
 * (agent activity + lifecycle markers), all scoped to the caller's workspace.
 *
 * Bearer-authenticated with the runner token; every read is filtered by the
 * key's `workspaceId`, so a token can never pull another workspace's run.
 *
 * 401 — bad/missing bearer. 400 — no `run_id`. 404 — the id resolves to nothing
 * in this workspace (no run, no failures, no gates, no timeline). 502 — a
 * backing store errored. 200 — the bundle.
 */
export async function GET(request: NextRequest) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) {
    return auth;
  }
  const { workspaceId } = auth;

  const runId = request.nextUrl.searchParams.get("run_id")?.trim();
  if (!runId) {
    return NextResponse.json({ error: "run_id is required" }, { status: 400 });
  }

  await touchApiKeyLastUsed(auth.apiKeyId);

  let run;
  let reviewGates;
  let failureEvents;
  let timeline;
  try {
    [run, reviewGates, failureEvents, timeline] = await Promise.all([
      getRun(workspaceId, runId),
      getReviewGatesForRun(workspaceId, runId),
      getFailuresForRun(workspaceId, runId),
      getRunEventsByRunId(workspaceId, runId),
    ]);
  } catch (err) {
    console.error("[runner/failure-bundle] read failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  // A run_id that resolves to nothing anywhere in this workspace is a 404 — not
  // an empty-but-200 bundle — so a caller can distinguish "unknown run" from
  // "known run that happened to pass with no failures".
  if (
    !run &&
    reviewGates.length === 0 &&
    failureEvents.length === 0 &&
    timeline.length === 0
  ) {
    return NextResponse.json(
      { error: "No run found for this run_id in the workspace" },
      { status: 404 }
    );
  }

  return NextResponse.json(
    {
      run: run ?? null,
      failure_events: failureEvents,
      review_gates: reviewGates,
      timeline,
    },
    { status: 200 }
  );
}
