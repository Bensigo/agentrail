import { NextRequest, NextResponse } from "next/server";
import {
  recordRunnerResult,
  touchApiKeyLastUsed,
  getMergePermission,
  getGithubToken,
  type RunnerStatus,
} from "@agentrail/db-postgres";
import {
  insertFailureEvents,
  recordRunLifecycleEvent,
  type FailureEventInput,
} from "@agentrail/db-clickhouse";
import { requireBearer } from "../../../../../lib/bearer-auth";
import { boundEvidence } from "../../../../../lib/evidence";
import {
  parseGithubPrUrl,
  prUrlMatchesQueueEntryRepo,
  mergePullRequestSquash,
} from "../../../../../lib/github-merge";
import { reconcileAlignmentBriefs } from "../../../../../lib/alignment-reconciler";
import { notifyRunOutcome } from "./notify";
import { notifyOnboardOutcome, onboardRepoFullName } from "./onboard-notify";

/** The issue number for a queue entry's external id (trailing digits, else ""). */
function issueNumberOf(externalId: string): string {
  const m = externalId.match(/(\d+)\s*$/);
  return m ? m[1]! : "";
}

const RUNNER_STATUSES: readonly RunnerStatus[] = [
  "green",
  "red",
  "error",
  "running",
];

function isRunnerStatus(value: unknown): value is RunnerStatus {
  return (
    typeof value === "string" &&
    (RUNNER_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Runner result report. Bearer-authenticated with the runner token. Maps the
 * runner status onto the queue state-machine (green→green terminal, red→queued
 * for retry, error→blocked, running→running) and updates the queue entry.
 *
 * NOTE: this updates `queue_entries` only — it does NOT write a `runs` row.
 * The `runs` table requires a `repository_id` (text, not nullable) plus agent /
 * branch fields that aren't part of this result payload, and run-registration is
 * already owned by the dedicated ingest endpoints (`/api/v1/ingest/run-events`,
 * `/api/v1/ingest/runs`). Cost/visibility flows through those; folding a partial
 * run write in here would create under-specified `runs` rows. See report.
 */
export async function POST(request: NextRequest) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) {
    return auth;
  }

  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    workspace_id?: string;
    repository_id?: string;
    status?: string;
    cost_usd?: number;
    branch?: string;
    gate_reason?: string;
    logs_tail?: string;
    pr_url?: string;
  };

  const { id, workspace_id, status } = body;
  if (!id || !workspace_id || !status) {
    return NextResponse.json(
      { error: "id, workspace_id and status are required" },
      { status: 400 }
    );
  }

  if (auth.workspaceId !== workspace_id) {
    return NextResponse.json(
      { error: "API key does not belong to the specified workspace" },
      { status: 403 }
    );
  }

  if (!isRunnerStatus(status)) {
    return NextResponse.json(
      { error: "status must be one of green, red, error, running" },
      { status: 400 }
    );
  }

  await touchApiKeyLastUsed(auth.apiKeyId);

  const result = await recordRunnerResult({
    id,
    workspaceId: workspace_id,
    status,
    costUsd: typeof body.cost_usd === "number" ? body.cost_usd : undefined,
    prUrl: typeof body.pr_url === "string" ? body.pr_url : undefined,
    // #1267 PR③: thread the runner's gate_reason into the queue transition so a
    // hosted-refusal `error` (gate_reason prefixed "hosted-refusal: ") escalates
    // straight to a human, spending no retry budget — without this passthrough
    // the refusal detection in recordRunnerResult can never fire. Any other
    // value (or absence) leaves the transition byte-identical to before.
    gateReason: typeof body.gate_reason === "string" ? body.gate_reason : undefined,
  });
  if (!result.updated) {
    return NextResponse.json(
      { error: "Queue entry not found in this workspace" },
      { status: 404 }
    );
  }

  // #1274 PR③: a runner result is genuine "next queue activity" — use it to
  // sweep for OTHER stale, brief-less parked entries IN THIS WORKSPACE
  // (workspace-scoped by the sweep itself — I2 fix round; see
  // findAlignmentBriefCandidates' own doc-comment): Python-admitted rows, a
  // prior postAlignmentBrief failure, a v2-guardrail park unparkDependents
  // relabeled once ITS unrelated dependency happened to clear via THIS
  // result. Bounded, best-effort, NON-FATAL — a reconciler failure must
  // never fail this route's 202, matching every other best-effort block
  // below (notify/merge/failure evidence).
  try {
    await reconcileAlignmentBriefs(workspace_id, 5);
  } catch (err) {
    console.error("[runner/result] alignment-reconciler sweep failed:", err);
  }

  // Merge enforcement (#1278 PR②): the CONSOLE-SIDE decision, at result time.
  // workspace.merge_permission is read FRESH here (never cached, never
  // threaded through the WorkItem/claim) — a revoke between claim and this
  // result is honored immediately. Only ever attempted on the issue-kind
  // path (an onboard row never carries a real pr_url); scoped by the SAME
  // onboardRepoFullName detection the notify branch below uses.
  //
  // Permission OFF is the byte-identical-to-before path: getGithubToken and
  // mergePullRequestSquash are only ever called inside the `permitted`
  // branch, so an OFF workspace makes ZERO GitHub calls here, exactly as
  // before this feature existed.
  //
  // SECURITY (non-negotiable): the runner self-reports pr_url, so before
  // spending the workspace's GitHub token on a merge, prUrlMatchesQueueEntryRepo
  // proves the PR's owner/repo EXACTLY matches the repo this queue entry was
  // admitted under (queue_entries.external_id, server-controlled — never
  // something the runner sets). A mismatch (forged/wrong-repo/wrong-host
  // pr_url) never merges — loud log, no throw, the PR link still goes out
  // in the notification below.
  //
  // Whole block is best-effort, matching this route's existing convention
  // for notify/lifecycle/failure-evidence: any failure here (a DB blip
  // reading the permission/token, the merge call itself failing) is logged
  // and turned into an honest `merge_failed` outcome — it NEVER retries and
  // NEVER changes the 202 response below (AC3-equivalent for this feature).
  let mergeOutcome: "merged" | "merge_failed" | "not_attempted" = "not_attempted";
  if (
    result.terminalState === "green" &&
    typeof body.pr_url === "string" &&
    body.pr_url &&
    !onboardRepoFullName(result.externalId)
  ) {
    try {
      const permitted = await getMergePermission(workspace_id);
      if (permitted) {
        const parsedPr = parseGithubPrUrl(body.pr_url);
        const repoMatches = prUrlMatchesQueueEntryRepo(
          body.pr_url,
          result.externalId
        );
        if (!parsedPr || !repoMatches) {
          console.error(
            `[runner/result] merge SKIPPED — pr_url does not match this queue entry's own repo (id=${id})`
          );
          mergeOutcome = "merge_failed";
        } else {
          const token = await getGithubToken(workspace_id);
          if (!token) {
            console.error(
              `[runner/result] merge SKIPPED — workspace ${workspace_id} has no GitHub token`
            );
            mergeOutcome = "merge_failed";
          } else {
            const mergeResult = await mergePullRequestSquash(token, parsedPr);
            if (mergeResult.ok) {
              mergeOutcome = "merged";
            } else {
              console.error(
                `[runner/result] merge FAILED (id=${id}): ${mergeResult.reason}` +
                  (mergeResult.status ? ` (status ${mergeResult.status})` : "")
              );
              mergeOutcome = "merge_failed";
            }
          }
        }
      }
    } catch (err) {
      console.error("[runner/result] merge attempt threw:", err);
      mergeOutcome = "merge_failed";
    }
  }

  // Gateway notify (#888): fire ONLY on a TERMINAL outcome. A red/error that
  // re-queues for retry (and a `running` heartbeat) yields terminalState=null,
  // so we never spam a message on every attempt (the correctness trap). The
  // issue number comes from the queue entry's external id; pr/cost from the body.
  // BEST-EFFORT: any failure is swallowed and never changes the 202 below (AC3).
  //
  // Kind branch (#1268 PR②): an onboard row's external_id is `onboard:<repo>`
  // (see onboardRepoFullName's doc-comment) — the one detection point, no
  // `kind` column read. Onboard rides its OWN honest, workspace-scoped notice
  // (onboard-notify.ts) instead of notifyRunOutcome, whose issue-shaped
  // message ("PR ready — issue #", empty number) is wrong for onboarding.
  // Everything else (the issue-kind path) is byte-identical to before.
  if (result.terminalState) {
    const repoFullName = onboardRepoFullName(result.externalId);
    try {
      if (repoFullName) {
        await notifyOnboardOutcome(workspace_id, repoFullName, result.terminalState);
      } else {
        await notifyRunOutcome(workspace_id, {
          issueNumber: issueNumberOf(result.externalId),
          outcome: result.terminalState,
          prUrl: typeof body.pr_url === "string" ? body.pr_url : undefined,
          costUsd: typeof body.cost_usd === "number" ? body.cost_usd : undefined,
          merged: mergeOutcome === "merged",
        });
      }
    } catch {
      // notify is best-effort; the runner result is already recorded.
    }
  }

  // Timeline state markers: gate verdict, then the PR if one was opened.
  const now = Date.now();
  await recordRunLifecycleEvent(
    workspace_id,
    id,
    `gate_${status}`,
    status === "green"
      ? "Objective gate green"
      : status === "running"
        ? "Run in progress"
        : `Objective gate ${status}${body.gate_reason ? `: ${body.gate_reason}` : ""}`,
    now
  );
  if (typeof body.pr_url === "string" && body.pr_url) {
    await recordRunLifecycleEvent(
      workspace_id,
      id,
      "pr_opened",
      `Pull request opened: ${body.pr_url}`,
      now + 1
    );
  }
  // #1278 PR②: the merge outcome, same idiom as pr_opened above (a labeled
  // dot on the run-detail timeline). Only fires when a merge was actually
  // attempted (mergeOutcome stays "not_attempted" — no event — for every
  // permission-OFF run, byte-identical to before this feature existed).
  if (mergeOutcome === "merged") {
    await recordRunLifecycleEvent(
      workspace_id,
      id,
      "merged",
      `Pull request merged: ${body.pr_url}`,
      now + 2
    );
  } else if (mergeOutcome === "merge_failed") {
    await recordRunLifecycleEvent(
      workspace_id,
      id,
      "merge_failed",
      `Merge attempt failed — PR left open: ${body.pr_url}`,
      now + 2
    );
  }

  // Failure evidence (#1146 AC2): a red/error result carrying a logs_tail is the
  // runner's second, dormant evidence channel — the durable outcome report, as
  // opposed to `report_telemetry`'s ingest push. Persist it as a failure_event
  // so the tail survives even when a client only reports results. The tail
  // arrives raw (report_result does not scrub), so bound+scrub it at this write
  // boundary. Fingerprint/failure_type mirror report_telemetry so both channels
  // cluster on the failures UI. BEST-EFFORT: any failure here is swallowed and
  // never changes the 202 — console storage trouble must not break a run (AC4).
  if (
    (status === "red" || status === "error") &&
    typeof body.logs_tail === "string" &&
    body.logs_tail
  ) {
    try {
      const failure: FailureEventInput = {
        workspace_id,
        run_id: id,
        repository_id:
          typeof body.repository_id === "string" ? body.repository_id : "",
        failure_type: status === "red" ? "objective_gate" : "execution_error",
        message: body.gate_reason || `run ${status}`,
        normalized_error: "",
        fingerprint: "",
        evidence: boundEvidence(body.logs_tail),
        phase: status === "red" ? "verify" : "execute",
        severity: "error",
        occurred_at: new Date(now).toISOString(),
      };
      await insertFailureEvents([failure]);
    } catch (err) {
      console.error("[runner/result] failure evidence persist failed:", err);
    }
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}
