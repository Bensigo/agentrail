import { NextRequest, NextResponse } from "next/server";
import {
  enqueueCurrentReviewJobPreviewBoot,
  CurrentReviewJobNotCurrentError,
  getJaceSessionByEveSessionId,
  getReviewJobById,
  readAcceptanceContracts,
  readChangeRecordTimelineByPr,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../lib/jace-console-auth";
import {
  confirmedVerificationContract,
  findStoredReviewJobVerificationPlan,
} from "../../../../../../../lib/review-job-verification-plan";
import {
  previewBootsDisabled,
  previewBootsDisabledResponse,
  previewBootsWorkspaces,
} from "../../../preview-boots/shared";

/**
 * POST /api/v1/runner/review-jobs/[jobId]/preview
 *
 * Admit an isolated preview for a running review job without trusting the
 * model to identify the workspace, repository, PR, or head. The request body
 * contains only the Eve session id; every code-identity field comes from the
 * already-bound review_jobs row. Admission also requires that same head to be
 * attached to a Change Record with exactly one confirmed Contract containing
 * valid criteria, plus an immutable full-criterion plan with at least one UI
 * flow assigned to this isolated environment. The existing preview worker
 * owns boot isolation, bounded lifetime, and teardown after this route
 * enqueues the exact tuple.
 */

interface PreviewRequestBody {
  eveSessionId: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parsePreviewRequestBody(raw: unknown): PreviewRequestBody | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const keys = Object.keys(input);
  if (
    keys.length !== 1 ||
    keys[0] !== "eveSessionId" ||
    !isNonEmptyString(input.eveSessionId)
  ) {
    return null;
  }
  return { eveSessionId: input.eveSessionId.trim() };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  if (previewBootsDisabled()) {
    return previewBootsDisabledResponse();
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const body = parsePreviewRequestBody(raw);
  const jobId = (await params).jobId?.trim();
  if (!body || !jobId) {
    return NextResponse.json(
      { error: "eveSessionId is required and must be the only request field" },
      { status: 400 }
    );
  }

  // Resolve the session before the job so an arbitrary bearer cannot use
  // guessed job ids as an existence oracle. This must be the identity-less
  // session created specifically for the claimed review job.
  const session = await getJaceSessionByEveSessionId(body.eveSessionId);
  if (
    !session ||
    session.eveSessionId !== body.eveSessionId ||
    session.channel !== "review-job" ||
    session.conversationKey !== `review-job:${jobId}` ||
    session.status !== "active"
  ) {
    return NextResponse.json(
      { error: "review session is not bound to this job" },
      { status: 409 }
    );
  }

  const job = await getReviewJobById(jobId);
  if (
    !job ||
    job.state !== "running" ||
    !session.workspaceId ||
    session.workspaceId !== job.workspaceId
  ) {
    return NextResponse.json(
      { error: "review job not found or not running" },
      { status: 409 }
    );
  }

  if (!previewBootsWorkspaces().has(job.workspaceId)) {
    return NextResponse.json({ error: "workspace not enrolled" }, { status: 403 });
  }

  const timeline = await readChangeRecordTimelineByPr({
    workspaceId: job.workspaceId,
    repo: job.repo,
    prNumber: job.prNumber,
  });
  if (
    !timeline ||
    timeline.record.workspaceId !== job.workspaceId ||
    timeline.record.repo !== job.repo ||
    timeline.record.prNumber !== job.prNumber ||
    timeline.record.currentPrHeadSha !== job.headSha ||
    timeline.record.currentPrHeadCycleId !== job.id ||
    timeline.record.currentPrHeadAuthoritative !== true
  ) {
    return NextResponse.json(
      { error: "review job is not attached to an Acceptance Record at this head" },
      { status: 409 }
    );
  }

  const contract = confirmedVerificationContract(await readAcceptanceContracts({
    workspaceId: job.workspaceId,
    recordId: timeline.record.id,
  }));
  if (!contract) {
    return NextResponse.json(
      { error: "review job has no valid confirmed Acceptance Contract" },
      { status: 409 }
    );
  }

  const verificationPlan = findStoredReviewJobVerificationPlan({
    events: timeline.events,
    job,
    recordId: timeline.record.id,
    contract,
  });
  if (!verificationPlan?.plans.some((plan) => plan.status === "planned")) {
    return NextResponse.json(
      { error: "review job has no planned exact-head verification criterion" },
      { status: 409 }
    );
  }

  let result: Awaited<ReturnType<typeof enqueueCurrentReviewJobPreviewBoot>>;
  try {
    result = await enqueueCurrentReviewJobPreviewBoot({
      workspaceId: job.workspaceId,
      recordId: timeline.record.id,
      jobId: job.id,
      repo: job.repo,
      prNumber: job.prNumber,
      headSha: job.headSha,
      ref: job.headSha,
    });
  } catch (error) {
    if (error instanceof CurrentReviewJobNotCurrentError) {
      return NextResponse.json(
        { error: "review job is no longer current for this pull request head" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "could not enqueue the exact-head preview" },
      { status: 503 }
    );
  }

  return NextResponse.json(
    { id: result.id, deduped: result.deduped },
    { status: 200 }
  );
}
