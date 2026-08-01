import { NextRequest, NextResponse } from "next/server";
import {
  claimReviewJob,
  bindReviewJobSession,
  releaseReviewJob,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";

/**
 * POST /api/v1/runner/review-jobs/claim
 *
 * Arc B §3 (reviewer of record, spec
 * docs/superpowers/specs/2026-07-31-reviewer-of-record-design.md). The
 * headless Jace review worker's claim seam: atomically claim the next
 * eligible `review_jobs` row (`claimReviewJob`, `@agentrail/db-postgres` —
 * SKIP LOCKED, per-workspace running bound, daily budget), then bind the
 * worker's freshly-created headless eve session to that job
 * (`bindReviewJobSession`) so every session-resolving tool (the reviewer
 * subagent's tools + root's `post_pr_review`) resolves this job's workspace
 * unchanged, through the SAME `eveSessionId` -> `jace_sessions` ledger chain
 * `pr-review` and every other Jace-coordinator route already use. See that
 * route's own doc-comment for the full resolution chain this mirrors.
 *
 * AUTH: the central `JACE_CONSOLE_TOKEN` secret via `requireJaceConsoleSecret`
 * — the worker IS Jace, the same guard every other Jace-coordinator route
 * uses.
 *
 * BODY: `{ workerId, eveSessionId }`, both required non-empty strings — 400
 * otherwise, before any claim is attempted.
 *
 * NO ELIGIBLE JOB: 204 with an empty body (mirrors the queue_entries claim
 * route's own `new NextResponse(null, { status: 204 })` convention,
 * `runner/claim/route.ts`) — not an error, just nothing to do right now.
 *
 * BIND-FAILURE RELEASE (never leak a claim): `claimReviewJob` and
 * `bindReviewJobSession` are two separate round trips (not one shared db
 * transaction — see this task's own report for why), so a failure in the
 * SECOND call after the FIRST already succeeded would otherwise strand the
 * row `running` with no session bound to it, recoverable only after the
 * 15-minute stale-running pre-pass. `releaseReviewJob` (added alongside this
 * route — no release helper existed in the Task 2 query layer) closes that
 * gap immediately: on any `bindReviewJobSession` throw, flip the SAME job
 * back to `queued` (guarded, so it can never clobber a job that moved on by
 * some other path) and respond 503 — the worker's next poll picks it (or
 * another eligible job) back up right away instead of waiting out the
 * stale-running window. The release attempt is itself best-effort: if it
 * ALSO fails (e.g. the same db outage that broke the bind), this still
 * responds 503 rather than 500 — the row self-heals via the stale-running
 * pre-pass regardless, so a release failure degrades gracefully rather than
 * compounding into a crash.
 */

const DAILY_BUDGET_ENV = "REVIEW_JOBS_DAILY_BUDGET";
const DEFAULT_DAILY_BUDGET = 50;

/** REVIEW_JOBS_DAILY_BUDGET (design spec §2 "Budget"), default 50 when
 *  unset, empty, or not a finite non-negative number. */
function resolveDailyBudget(): number {
  const raw = process.env[DAILY_BUDGET_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_BUDGET;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_BUDGET;
}

interface ClaimBody {
  workerId: string;
  eveSessionId: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parseClaimBody(raw: unknown): ClaimBody | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!isNonEmptyString(o.workerId) || !isNonEmptyString(o.eveSessionId)) {
    return null;
  }
  return { workerId: o.workerId, eveSessionId: o.eveSessionId };
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

  const body = parseClaimBody(raw);
  if (!body) {
    return NextResponse.json(
      { error: "workerId and eveSessionId are required" },
      { status: 400 }
    );
  }

  const job = await claimReviewJob({
    workerId: body.workerId,
    dailyBudget: resolveDailyBudget(),
  });
  if (!job) {
    return new NextResponse(null, { status: 204 });
  }

  try {
    await bindReviewJobSession({ jobId: job.id, eveSessionId: body.eveSessionId });
  } catch (err) {
    console.error(
      `[review-jobs/claim] bindReviewJobSession failed for job ${job.id} — releasing the claim:`,
      err
    );
    try {
      await releaseReviewJob({ jobId: job.id });
    } catch (releaseErr) {
      console.error(
        `[review-jobs/claim] releaseReviewJob ALSO failed for job ${job.id} — it will self-heal via the 15-minute stale-running pre-pass:`,
        releaseErr
      );
    }
    return NextResponse.json(
      { error: "failed to bind the worker session — job released back to the queue" },
      { status: 503 }
    );
  }

  return NextResponse.json({
    job: {
      id: job.id,
      repo: job.repo,
      prNumber: job.prNumber,
      headSha: job.headSha,
      event: job.event,
      workspaceId: job.workspaceId,
    },
  });
}
