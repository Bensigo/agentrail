import { NextRequest, NextResponse } from "next/server";
import { getReviewJobState, bindReviewJobSession, releaseReviewJob } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";

/**
 * POST /api/v1/runner/review-jobs/bind
 *
 * Arc B review fix wave (per-job session restructure) — NEW route. Binds a
 * headless eve session to a claimed job, separately from claim (the sibling
 * `../claim/route.ts` no longer does this — see that file's own doc-comment
 * for why). Called by the Jace worker AFTER it opens a session for an
 * actual claimed job, and BEFORE it sends the real review turn: every
 * session-resolving tool the review turn calls (the reviewer subagent's
 * tools + root's `post_pr_review`, each resolving
 * `ctx.session.parent?.rootSessionId ?? ctx.session.id` -> console ->
 * `getJaceSessionByEveSessionId` -> workspace) depends on this row existing
 * by the time the review turn runs. Binding-before-the-real-turn is the
 * invariant that matters — it does not need to happen in the SAME call as
 * claim, only before the turn.
 *
 * AUTH: the central `JACE_CONSOLE_TOKEN` secret via `requireJaceConsoleSecret`
 * — the worker IS Jace, the same guard every other Jace-coordinator route
 * uses.
 *
 * BODY: `{ jobId, eveSessionId }`, both required non-empty strings — 400
 * otherwise, before any db call.
 *
 * JOB NOT RUNNING: `bindReviewJobSession` itself has no state precondition
 * (a plain SELECT with no `WHERE state = ...`, unlike `completeReviewJob`/
 * `releaseReviewJob`'s own guarded UPDATEs), so this route checks
 * `getReviewJobState` FIRST — `state !== "running"` (true for BOTH "no such
 * job" and "exists but some other state", e.g. reclaimed by the 15-minute
 * stale-running pre-pass while this worker was mid-bootstrap, or already
 * resolved by some other path) -> 409, and `bindReviewJobSession` is never
 * even called. Mirrors `../complete/route.ts`'s own established "unknown
 * job OR not-running -> 409" precedent (see that route's own doc-comment)
 * rather than inventing a distinct status for an edge case with the same
 * practical remedy. This check-then-bind is NOT one atomic transaction (the
 * same small, documented residual as the original claim+bind design — see
 * this route's git history / the fix-wave report for the accepted window),
 * but the failure mode of that narrow race is the SAME bind-failure path
 * below, not a new one.
 *
 * BIND-FAILURE RELEASE (never leak a claim, moved here verbatim from the
 * original claim route): a `bindReviewJobSession` throw flips the SAME job
 * back to `queued` (`releaseReviewJob`, guarded, so it can never clobber a
 * job that moved on some other way) and responds 503 — the worker's next
 * poll picks it (or another eligible job) back up right away instead of
 * waiting out the stale-running window. The release attempt is itself
 * best-effort: if it ALSO fails (e.g. the same db outage that broke the
 * bind), this still responds 503 rather than 500 — the row self-heals via
 * the stale-running pre-pass regardless, so a release failure degrades
 * gracefully rather than compounding into a crash.
 */

interface BindBody {
  jobId: string;
  eveSessionId: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parseBindBody(raw: unknown): BindBody | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!isNonEmptyString(o.jobId) || !isNonEmptyString(o.eveSessionId)) {
    return null;
  }
  return { jobId: o.jobId, eveSessionId: o.eveSessionId };
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

  const body = parseBindBody(raw);
  if (!body) {
    return NextResponse.json(
      { error: "jobId and eveSessionId are required" },
      { status: 400 }
    );
  }

  const state = await getReviewJobState(body.jobId);
  if (state !== "running") {
    return NextResponse.json(
      { error: "review job not found or not running" },
      { status: 409 }
    );
  }

  try {
    await bindReviewJobSession({ jobId: body.jobId, eveSessionId: body.eveSessionId });
  } catch (err) {
    console.error(
      `[review-jobs/bind] bindReviewJobSession failed for job ${body.jobId} — releasing the claim:`,
      err
    );
    try {
      await releaseReviewJob({ jobId: body.jobId });
    } catch (releaseErr) {
      console.error(
        `[review-jobs/bind] releaseReviewJob ALSO failed for job ${body.jobId} — it will self-heal via the 15-minute stale-running pre-pass:`,
        releaseErr
      );
    }
    return NextResponse.json(
      { error: "failed to bind the worker session — job released back to the queue" },
      { status: 503 }
    );
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
