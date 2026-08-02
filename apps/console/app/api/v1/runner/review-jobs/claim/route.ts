import { NextRequest, NextResponse } from "next/server";
import { claimReviewJob } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";

/**
 * POST /api/v1/runner/review-jobs/claim
 *
 * Arc B §3 (reviewer of record, spec
 * docs/superpowers/specs/2026-07-31-reviewer-of-record-design.md). The
 * headless Jace review worker's claim seam: atomically claim the next
 * eligible `review_jobs` row (`claimReviewJob`, `@agentrail/db-postgres` —
 * SKIP LOCKED, per-workspace running bound, daily budget).
 *
 * ARC B REVIEW FIX WAVE (per-job session restructure): this route no longer
 * binds a session. The original version claimed AND bound an eve session in
 * the same call, atomically — that meant the worker had to open a real eve
 * session (a real, if minimal, model turn) BEFORE every single claim
 * attempt, including every idle poll that found nothing eligible. Review
 * flagged that Important-severity once the worker's actual session-minting
 * mechanism was concrete (`apps/jace/agent/lib/review_job_worker.mjs`'s own
 * header comment, "THE SESSION-MINTING PROBLEM"): 2,880 model turns/day at
 * rest for a worker that never finds a job. This route now does ONLY the
 * claim — cheap, no session cost — and the worker opens a session (and
 * binds it, via the sibling `POST .../bind` route) ONLY once it actually has
 * a job to review. See `../bind/route.ts` for where the binding logic
 * (including the release-on-bind-failure compensating action) moved to.
 *
 * AUTH: the central `JACE_CONSOLE_TOKEN` secret via `requireJaceConsoleSecret`
 * — the worker IS Jace, the same guard every other Jace-coordinator route
 * uses.
 *
 * BODY: `{ workerId }`, a required non-empty string — 400 otherwise, before
 * any claim is attempted.
 *
 * NO ELIGIBLE JOB: 204 with an empty body (mirrors the queue_entries claim
 * route's own `new NextResponse(null, { status: 204 })` convention,
 * `runner/claim/route.ts`) — not an error, just nothing to do right now.
 *
 * CLAIMED: 200 `{ job: { id, repo, prNumber, headSha, event, workspaceId } }`
 * — the worker binds a session to this job itself via `POST .../bind`
 * before running the review.
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
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parseClaimBody(raw: unknown): ClaimBody | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!isNonEmptyString(o.workerId)) return null;
  return { workerId: o.workerId };
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
    return NextResponse.json({ error: "workerId is required" }, { status: 400 });
  }

  const job = await claimReviewJob({
    workerId: body.workerId,
    dailyBudget: resolveDailyBudget(),
  });
  if (!job) {
    return new NextResponse(null, { status: 204 });
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
