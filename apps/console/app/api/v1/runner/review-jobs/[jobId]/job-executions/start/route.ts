import { isDeepStrictEqual } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import {
  appendChangeRecordEvent,
  getJaceSessionByEveSessionId,
  getPreviewBoot,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../../lib/jace-console-auth";
import { resolveCurrentReviewJobPlan } from "../../../../../../../../lib/review-job-proof-attestation";
import { storageConfigured } from "../../../../../../../../lib/artifacts/store";
import {
  REVIEW_JOB_EXECUTION_ACTOR,
  REVIEW_JOB_EXECUTION_STAGE,
  buildReviewJobAttempt,
  plannedJobCriterion,
  reviewJobAttemptEventKey,
} from "../../../../../../../../lib/review-job-job-execution";
import {
  parseReviewDataHmacKeyIds,
  reviewDataHmacKeyById,
} from "../../../../../../../../lib/review-job-verification-plan";
const nonBlank = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
function body(
  value: unknown,
): {
  eveSessionId: string;
  criterionId: string;
  previewBootId: string;
  digestKeyIds: string[];
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const eveSessionId = nonBlank(input.eveSessionId),
    criterionId = nonBlank(input.criterionId),
    previewBootId = nonBlank(input.previewBootId),
    digestKeyIds = parseReviewDataHmacKeyIds(input.digestKeyIds);
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
  if (
    process.env.REVIEW_EVIDENCE_ENABLED !== "1" ||
    !storageConfigured(process.env)
  )
    return NextResponse.json(
      { error: "evidence storage not enabled" },
      { status: 503 },
    );
  const input = body(await request.json().catch(() => null)),
    jobId = nonBlank((await params).jobId);
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
  const plan = plannedJobCriterion(proof, input.criterionId);
  if (!plan)
    return NextResponse.json(
      { error: "criterion has no executable planned job flow" },
      { status: 409 },
    );
  const keyId = plan.jobRequest.readback.digestKeyId;
  if (
    !input.digestKeyIds.includes(keyId) ||
    !reviewDataHmacKeyById(process.env, keyId)
  )
    return NextResponse.json(
      {
        error: "planned review-job HMAC key is unavailable; execution is held",
      },
      { status: 409 },
    );
  const boot = await getPreviewBoot(input.previewBootId);
  if (!boot || !future(boot.expiresAt))
    return NextResponse.json(
      { error: "exact-head preview is not ready for a new job execution" },
      { status: 409 },
    );
  const attempt = buildReviewJobAttempt({ proof, plan, boot });
  if (!attempt)
    return NextResponse.json(
      {
        error: "exact-head preview is not ready for this planned job criterion",
      },
      { status: 409 },
    );
  const eventKey = reviewJobAttemptEventKey({ proof, plan });
  if (proof.timeline.events.some((event) => event.eventKey === eventKey))
    return NextResponse.json(
      { error: "job execution is already reserved; replay is held" },
      { status: 409 },
    );
  try {
    const recorded = await appendChangeRecordEvent({
      recordId: proof.timeline.record.id,
      eventKey,
      stage: REVIEW_JOB_EXECUTION_STAGE,
      actor: REVIEW_JOB_EXECUTION_ACTOR,
      payloadRef: attempt,
    });
    if (
      !recorded.inserted ||
      !isDeepStrictEqual(recorded.event.payloadRef, attempt)
    )
      return NextResponse.json(
        { error: "job execution is already reserved; replay is held" },
        { status: 409 },
      );
  } catch {
    return NextResponse.json(
      { error: "could not reserve the job execution" },
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
      jobRequest: attempt.jobRequest,
    },
    { status: 201 },
  );
}
