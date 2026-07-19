import { NextRequest, NextResponse } from "next/server";
import { getRunById, getReviewGatesForRun } from "@agentrail/db-postgres";
import {
  getFailuresForRun,
  getRunEventsByRunId,
} from "@agentrail/db-clickhouse";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

/**
 * GET /api/v1/runner/failure-bundle?run_id=…
 *
 * The single read a triage step needs to diagnose a failed run: the run row,
 * its failure_events (WITH the bounded/scrubbed evidence excerpt the producers
 * now populate — #1146), its review-gate verdicts, and the run-event timeline
 * (agent activity + lifecycle markers), all scoped to the run's own workspace.
 *
 * AUTH + TENANT (updated for the central-secret fix, 2026-07-20): the central
 * `JACE_CONSOLE_TOKEN` secret via `requireJaceConsoleSecret` gates WHO may
 * call this route; it carries no per-caller `workspaceId` the way the old
 * per-workspace bearer (`requireBearer`) did. Unlike the other re-derived
 * route (`workspace-memory`, which threads an `eveSessionId`), this route
 * resolves its tenant from the RUN ITSELF: `getRunById(run_id)` is an
 * unscoped-by-workspace primary-key lookup (safe because `runs.id` is a
 * server-minted, non-caller-guessable uuid — see that function's own
 * doc-comment), and this route trusts ONLY the `workspaceId` field on the
 * row it gets back — never anything the request itself claims — to scope
 * every subsequent read (review gates, ClickHouse failure events / run
 * events). This route was picked over adding `eveSessionId` here too because
 * the caller is `apps/jace/agent/subagents/triage/tools/fetch_run_evidence.ts`,
 * a SUBAGENT tool whose own Eve session id is not established to be the SAME
 * `eveSessionId` the coordinator's `jace_sessions` ledger anchors (subagents
 * may run under their own nested session) — deriving tenant from the run row
 * avoids depending on that being true, and needs no jace-side change at all
 * since `run_id` was already the only input this route needed.
 *
 * `touchApiKeyLastUsed` is gone: it tracked a per-workspace `api_keys` row's
 * `last_used_at`, which has no equivalent under a bare shared secret.
 *
 * 400 — no `run_id`. 401 — bad/missing secret. 404 — `run_id` resolves to no
 * run at all. 502 — a backing store errored. 200 — the bundle (an existing
 * run with zero failures/gates/timeline entries is a legitimate 200, not a
 * 404 — only an unknown `run_id` is).
 */
export async function GET(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) {
    return authError;
  }

  const runId = request.nextUrl.searchParams.get("run_id")?.trim();
  if (!runId) {
    return NextResponse.json({ error: "run_id is required" }, { status: 400 });
  }

  let run;
  try {
    run = await getRunById(runId);
  } catch (err) {
    console.error("[runner/failure-bundle] run lookup failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  // Unknown run_id — this is the ONLY 404 case now: with the workspace
  // derived from the run row itself, there is no longer a "known run in a
  // DIFFERENT workspace" case that could masquerade as an empty bundle (see
  // getRunById's own doc-comment) — an existing run always resolves its own
  // real workspaceId, and downstream reads are scoped to that.
  if (!run) {
    return NextResponse.json(
      { error: "No run found for this run_id" },
      { status: 404 }
    );
  }
  const workspaceId = run.workspaceId;

  let reviewGates;
  let failureEvents;
  let timeline;
  try {
    [reviewGates, failureEvents, timeline] = await Promise.all([
      getReviewGatesForRun(workspaceId, runId),
      getFailuresForRun(workspaceId, runId),
      getRunEventsByRunId(workspaceId, runId),
    ]);
  } catch (err) {
    console.error("[runner/failure-bundle] read failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  return NextResponse.json(
    {
      run,
      failure_events: failureEvents,
      review_gates: reviewGates,
      timeline,
    },
    { status: 200 }
  );
}
