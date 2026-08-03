import { NextRequest, NextResponse } from "next/server";
import {
  appendChangeRecordEvent,
  completeReviewJob,
  findOrCreateChangeRecord,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";
import { sendWorkspaceNotification } from "../../result/notify";

/**
 * POST /api/v1/runner/review-jobs/complete
 *
 * Arc B §3 (reviewer of record, spec
 * docs/superpowers/specs/2026-07-31-reviewer-of-record-design.md). The
 * headless Jace review worker's completion seam: resolve a claimed
 * (`running`) `review_jobs` row via the guarded `completeReviewJob`
 * (`@agentrail/db-postgres` — `WHERE id = $1 AND state = 'running'`, so a
 * duplicate/late completion is a no-op), then — ONLY on `outcome: "posted"`
 * — fire the owner notification exactly once through the console's EXISTING
 * notify machinery (`../../result/notify.ts`'s `sendWorkspaceNotification`,
 * the same per-channel legacy-vs-`jaceOwns<Channel>Notify` fan-out
 * `notifyRunOutcome` uses for run outcomes — see that module's own
 * doc-comment). This route does NOT build a new notification system.
 *
 * AUTH: the central `JACE_CONSOLE_TOKEN` secret via `requireJaceConsoleSecret`
 * — the worker IS Jace, the same guard the sibling `claim` route uses.
 *
 * BODY: `{ jobId, outcome: "posted"|"failed", postedReviewUrl?, verdict?,
 * summaryLine?, error?, evidenceKeys? }`. `jobId`/`outcome` are the only
 * required fields (400 otherwise, before any db call); the rest are
 * pass-through fields `completeReviewJob` itself treats as optional.
 *
 * `evidenceKeys` (B2a §1 Task 3): when present, must be an array of strings
 * — a present-but-malformed value (not an array, or an array with a
 * non-string element) is a 400, same as a missing required field; ABSENT is
 * fine (undefined rides straight through to `completeReviewJob`, which
 * leaves `evidence_keys` untouched at NULL — see that function's own
 * doc-comment). This route never inspects the array's contents beyond the
 * type check — it is Task 2's `review-evidence` upload route, not this one,
 * that owns key-shape validation.
 *
 * CONTENT OWNERSHIP (worker composes, console only routes): the worker's
 * canned choreography (design spec §4) already assembles the human-facing
 * line — repo+PR, the judgment verdicts, any `blocker` items — into
 * `summaryLine` before calling this route. This route's ENTIRE
 * responsibility for notify content is appending the review URL to that
 * already-composed line (`buildNotifyText` below) and handing the result to
 * `sendWorkspaceNotification` — it never re-derives or re-formats the
 * judgment content itself, and never inspects `verdict` beyond passing it
 * through to `completeReviewJob` for storage.
 *
 * UNKNOWN JOB OR NOT-RUNNING: `completeReviewJob` returns `null` when its own
 * guarded UPDATE matched no row (unknown `jobId`, or a job that already
 * resolved/was never claimed) — 409, no notify.
 *
 * `outcome: "failed"`: recorded via `completeReviewJob` (which owns the
 * retry/backoff/terminal-escalate policy — see that function's own
 * doc-comment), no notify, 200. A worker-reported failure is not an owner
 * notification event; only a posted review is.
 */

type Outcome = "posted" | "failed";

interface CompleteBody {
  jobId: string;
  outcome: Outcome;
  postedReviewUrl?: string;
  verdict?: string;
  summaryLine?: string;
  error?: string;
  evidenceKeys?: string[];
}

type CompletedReviewJob = Awaited<ReturnType<typeof completeReviewJob>>;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isOutcome(v: unknown): v is Outcome {
  return v === "posted" || v === "failed";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === "string");
}

function parseCompleteBody(raw: unknown): CompleteBody | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!isNonEmptyString(o.jobId) || !isOutcome(o.outcome)) return null;
  // Present-but-malformed evidenceKeys is a 400 (same generic parse-failure
  // shape every other body-shape violation in this route gets); absent
  // (undefined) is fine and falls through to the mapping below.
  if (o.evidenceKeys !== undefined && !isStringArray(o.evidenceKeys)) return null;
  return {
    jobId: o.jobId,
    outcome: o.outcome,
    postedReviewUrl: typeof o.postedReviewUrl === "string" ? o.postedReviewUrl : undefined,
    verdict: typeof o.verdict === "string" ? o.verdict : undefined,
    summaryLine: typeof o.summaryLine === "string" ? o.summaryLine : undefined,
    error: typeof o.error === "string" ? o.error : undefined,
    evidenceKeys: isStringArray(o.evidenceKeys) ? o.evidenceKeys : undefined,
  };
}

/**
 * The worker composes the full human-facing content (repo+PR line, judgment
 * verdicts, blockers) into `summaryLine`; this route's only job is to append
 * the review URL — see this file's own doc-comment "CONTENT OWNERSHIP".
 * Either half may be absent (both are optional on the wire); this never
 * fabricates content the worker didn't send.
 */
function buildNotifyText(
  summaryLine: string | undefined,
  postedReviewUrl: string | undefined
): string {
  const line = summaryLine?.trim() ?? "";
  const url = postedReviewUrl?.trim() ?? "";
  if (line && url) return `${line}\n${url}`;
  return line || url;
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

async function appendReviewPostedChangeRecordEvent(
  job: NonNullable<CompletedReviewJob>,
  body: CompleteBody
): Promise<void> {
  const prNumber = positiveIntegerOrNull(job.prNumber);
  if (!job.workspaceId || !job.repo || prNumber == null) {
    console.warn(
      `[review-jobs/complete] change-record attach skipped for job ${body.jobId}: missing workspace/repo/pr anchor`
    );
    return;
  }

  try {
    const record = await findOrCreateChangeRecord({
      workspaceId: job.workspaceId,
      repo: job.repo,
      prNumber,
      headShas: job.headSha ? [job.headSha] : undefined,
    });
    await appendChangeRecordEvent({
      recordId: record.id,
      eventKey: `review:posted:${job.id}`,
      stage: "review",
      actor: "reviewer-of-record",
      payloadRef: {
        kind: "review_job",
        jobId: job.id,
        repo: job.repo,
        prNumber,
        headSha: job.headSha,
        postedReviewUrl: body.postedReviewUrl ?? job.postedReviewUrl ?? null,
        verdict: body.verdict ?? job.verdict ?? null,
        evidenceKeys: body.evidenceKeys ?? job.evidenceKeys ?? null,
      },
      at: job.updatedAt instanceof Date ? job.updatedAt : undefined,
    });
  } catch (err) {
    console.error(
      `[review-jobs/complete] change-record attach failed for job ${body.jobId}:`,
      err
    );
  }
}

export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const body = parseCompleteBody(raw);
  if (!body) {
    return NextResponse.json(
      { error: "jobId (string) and outcome ('posted'|'failed') are required" },
      { status: 400 }
    );
  }

  const result = await completeReviewJob({
    jobId: body.jobId,
    outcome: body.outcome,
    postedReviewUrl: body.postedReviewUrl ?? null,
    verdict: body.verdict ?? null,
    error: body.error ?? null,
    // Deliberately NOT `?? null` like the three fields above: `undefined`
    // (never coalesced) when absent from the request, so an omitted
    // evidenceKeys produces the EXACT SAME completeReviewJob call shape as
    // before this field existed — completeReviewJob's own `== null` check
    // treats undefined and null identically for the DB write either way, so
    // this is a style choice for call-shape stability, not a behavior fork.
    evidenceKeys: body.evidenceKeys,
  });

  if (!result) {
    return NextResponse.json(
      { error: "review job not found or not running" },
      { status: 409 }
    );
  }

  if (body.outcome === "posted") {
    await appendReviewPostedChangeRecordEvent(result, body);

    try {
      await sendWorkspaceNotification(
        result.workspaceId,
        buildNotifyText(body.summaryLine, body.postedReviewUrl)
      );
    } catch (err) {
      // Best-effort, matching runner/result/route.ts's own convention for
      // notify: a gateway blip must never change this route's response.
      // sendWorkspaceNotification's own contract already never throws; this
      // is defense-in-depth only.
      console.error(`[review-jobs/complete] notify failed for job ${body.jobId}:`, err);
    }
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
