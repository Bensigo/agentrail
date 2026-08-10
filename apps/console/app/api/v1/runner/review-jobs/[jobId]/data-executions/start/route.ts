import { isDeepStrictEqual } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import {
  appendCurrentReviewJobEventsAtomically,
  CurrentReviewJobNotCurrentError,
  getJaceSessionByEveSessionId,
  getPreviewBoot,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../../lib/jace-console-auth";
import { resolveCurrentReviewJobPlan } from "../../../../../../../../lib/review-job-proof-attestation";
import {
  REVIEW_JOB_DATA_ACTOR,
  REVIEW_JOB_DATA_STAGE,
  buildReviewJobDataAttempt,
  plannedDataCriterion,
  reviewJobDataAttemptEventKey,
} from "../../../../../../../../lib/review-job-data-execution";
import {
  parseReviewDataHmacKeyIds,
  reviewDataHmacKeyById,
} from "../../../../../../../../lib/review-job-verification-plan";
const nonBlank = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
function body(value: unknown): {
  eveSessionId: string;
  criterionId: string;
  previewBootId: string;
  digestKeyIds: string[];
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const eveSessionId = nonBlank(input.eveSessionId);
  const criterionId = nonBlank(input.criterionId);
  const previewBootId = nonBlank(input.previewBootId);
  const digestKeyIds = parseReviewDataHmacKeyIds(input.digestKeyIds);
  return isDeepStrictEqual(Object.keys(input).sort(), [
    "criterionId",
    "digestKeyIds",
    "eveSessionId",
    "previewBootId",
  ]) &&
    eveSessionId &&
    criterionId &&
    previewBootId &&
    digestKeyIds
    ? { eveSessionId, criterionId, previewBootId, digestKeyIds }
    : null;
}
const future = (value: unknown) => {
  const time =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(time) && time > Date.now();
};
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const auth = requireJaceConsoleSecret(request);
  if (auth) return auth;
  const input = body(await request.json().catch(() => null));
  const jobId = nonBlank((await params).jobId);
  if (!input || !jobId)
    return NextResponse.json(
      {
        error:
          "eveSessionId, criterionId, previewBootId, and digestKeyIds are required and must be the only fields",
      },
      { status: 400 },
    );
  const session = await getJaceSessionByEveSessionId(input.eveSessionId);
  if (
    !session ||
    session.eveSessionId !== input.eveSessionId ||
    session.channel !== "review-job" ||
    session.conversationKey !== `review-job:${jobId}` ||
    session.status !== "active"
  )
    return NextResponse.json(
      { error: "review session is not bound to this job" },
      { status: 409 },
    );
  const proof = await resolveCurrentReviewJobPlan(jobId);
  if (
    !proof ||
    !session.workspaceId ||
    session.workspaceId !== proof.job.workspaceId
  )
    return NextResponse.json(
      { error: "review job plan is not current for this session" },
      { status: 409 },
    );
  const plan = plannedDataCriterion(proof, input.criterionId);
  if (!plan)
    return NextResponse.json(
      { error: "criterion has no executable planned data flow" },
      { status: 409 },
    );
  if (
    !input.digestKeyIds.includes(plan.dataRequest.digestKeyId) ||
    !reviewDataHmacKeyById(process.env, plan.dataRequest.digestKeyId)
  )
    return NextResponse.json(
      {
        error: "planned review-data HMAC key is unavailable; execution is held",
      },
      { status: 409 },
    );
  const boot = await getPreviewBoot(input.previewBootId);
  if (!boot || !future(boot.expiresAt))
    return NextResponse.json(
      { error: "exact-head preview is not ready for a new data execution" },
      { status: 409 },
    );
  const attempt = buildReviewJobDataAttempt({ proof, plan, boot });
  if (!attempt)
    return NextResponse.json(
      {
        error:
          "exact-head preview is not ready for this planned data criterion",
      },
      { status: 409 },
    );
  const eventKey = reviewJobDataAttemptEventKey({ proof, plan });
  if (proof.timeline.events.some((event) => event.eventKey === eventKey))
    return NextResponse.json(
      { error: "data execution is already reserved; replay is held" },
      { status: 409 },
    );
  try {
    const result = await appendCurrentReviewJobEventsAtomically({
      workspaceId: proof.job.workspaceId,
      recordId: proof.timeline.record.id,
      jobId: proof.job.id,
      repo: proof.job.repo,
      prNumber: proof.job.prNumber,
      headSha: proof.job.headSha,
      events: [
        {
          eventKey,
          stage: REVIEW_JOB_DATA_STAGE,
          actor: REVIEW_JOB_DATA_ACTOR,
          payloadRef: attempt,
        },
      ],
    });
    const recorded = result.events[0]!;
    if (
      !recorded.inserted ||
      !isDeepStrictEqual(recorded.event.payloadRef, attempt)
    )
      return NextResponse.json(
        { error: "data execution is already reserved; replay is held" },
        { status: 409 },
      );
  } catch (error) {
    if (error instanceof CurrentReviewJobNotCurrentError)
      return NextResponse.json(
        { error: "review job is no longer current for this pull request head" },
        { status: 409 },
      );
    return NextResponse.json(
      { error: "could not reserve the data execution" },
      { status: 503 },
    );
  }
  return NextResponse.json(
    {
      ok: true,
      executionId: attempt.executionId,
      jobId: attempt.jobId,
      criterionId: attempt.criterionId,
      expected: attempt.criterionTextSnapshot,
      previewBootId: attempt.previewBootId,
      previewUrl: attempt.previewUrl,
      dataRequest: attempt.dataRequest,
    },
    { status: 201 },
  );
}
