import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import {
  appendChangeRecordEvent,
  appendCurrentReviewJobEventsAtomically,
  CurrentReviewJobNotCurrentError,
  getJaceSessionByEveSessionId,
  getPreviewBoot,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../../../lib/jace-console-auth";
import {
  artifactKey,
  putArtifact,
  signedGetUrl,
  storageConfigured,
} from "../../../../../../../../../lib/artifacts/store";
import { resolveCurrentReviewJobPlan } from "../../../../../../../../../lib/review-job-proof-attestation";
import {
  REVIEW_JOB_EXECUTION_ACTOR,
  REVIEW_JOB_EXECUTION_STAGE,
  buildReviewJobAttempt,
  buildReviewJobCard,
  buildReviewJobCardReservation,
  buildReviewJobResult,
  findReviewJobAttemptByExecutionId,
  resolveReviewJobResult,
  reviewJobCardReservationEventKey,
  reviewJobResultEventKey,
  reviewJobResultResponse,
} from "../../../../../../../../../lib/review-job-job-execution";
import { reviewDataHmacKeyById } from "../../../../../../../../../lib/review-job-verification-plan";
const nonBlank = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
function body(
  value: unknown,
): {
  eveSessionId: string;
  observedTriggerStatus: number;
  observedReadbackStatus: number | null;
  observations: unknown[];
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>,
    eveSessionId = nonBlank(input.eveSessionId);
  const trigger = input.observedTriggerStatus,
    readback = input.observedReadbackStatus;
  return isDeepStrictEqual(Object.keys(input).sort(), [
    "eveSessionId",
    "observations",
    "observedReadbackStatus",
    "observedTriggerStatus",
  ]) &&
    eveSessionId &&
    Number.isInteger(trigger) &&
    (trigger as number) >= 100 &&
    (trigger as number) <= 599 &&
    (readback === null ||
      (Number.isInteger(readback) &&
        (readback as number) >= 100 &&
        (readback as number) <= 599)) &&
    Array.isArray(input.observations)
    ? {
        eveSessionId,
        observedTriggerStatus: trigger as number,
        observedReadbackStatus: readback as number | null,
        observations: input.observations,
      }
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
const enabled = () =>
  process.env.REVIEW_EVIDENCE_ENABLED === "1" && storageConfigured(process.env);
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string; executionId: string }> },
) {
  const auth = requireJaceConsoleSecret(request);
  if (auth) return auth;
  if (!enabled())
    return NextResponse.json(
      { error: "evidence storage not enabled" },
      { status: 503 },
    );
  const input = body(await request.json().catch(() => null)),
    route = await params,
    jobId = nonBlank(route.jobId),
    executionId = nonBlank(route.executionId);
  if (!input || !jobId || !executionId)
    return NextResponse.json(
      {
        error:
          "eveSessionId, observedTriggerStatus, observedReadbackStatus, and observations are required and must be the only fields",
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
  const execution = findReviewJobAttemptByExecutionId({ proof, executionId });
  if (!execution)
    return NextResponse.json(
      { error: "job execution was not reserved for this exact review plan" },
      { status: 409 },
    );
  const { plan, attempt } = execution;
  if (
    !reviewDataHmacKeyById(process.env, attempt.jobRequest.readback.digestKeyId)
  )
    return NextResponse.json(
      {
        error: "planned review-job HMAC key is unavailable; completion is held",
      },
      { status: 409 },
    );
  const boot = await getPreviewBoot(attempt.previewBootId),
    current =
      boot && future(boot.expiresAt)
        ? buildReviewJobAttempt({ proof, plan, boot })
        : null;
  if (!current || !isDeepStrictEqual(current, attempt))
    return NextResponse.json(
      { error: "exact-head preview is no longer ready for this job execution" },
      { status: 409 },
    );
  const provisional = buildReviewJobResult({
    attempt,
    plan,
    observedTriggerStatus: input.observedTriggerStatus,
    observedReadbackStatus: input.observedReadbackStatus,
    observations: input.observations,
    artifactKey: "pending",
    contentSha256: "0".repeat(64),
  });
  if (!provisional)
    return NextResponse.json(
      { error: "job observations do not match the reserved execution" },
      { status: 400 },
    );
  const card = Buffer.from(
      JSON.stringify(buildReviewJobCard(provisional)) + "\n",
      "utf8",
    ),
    digest = createHash("sha256").update(card).digest("hex");
  let key: string;
  try {
    key = artifactKey({
      workspaceId: proof.job.workspaceId,
      repo: proof.job.repo,
      prNumber: proof.job.prNumber,
      headSha: proof.job.headSha,
      acId: `${attempt.executionId}-${digest.slice(0, 16)}`,
      index: 1,
      ext: "json",
    });
  } catch {
    return NextResponse.json(
      { error: "stored review coordinates are not safe for artifact custody" },
      { status: 409 },
    );
  }
  const result = buildReviewJobResult({
    attempt,
    plan,
    observedTriggerStatus: input.observedTriggerStatus,
    observedReadbackStatus: input.observedReadbackStatus,
    observations: input.observations,
    artifactKey: key,
    contentSha256: digest,
  });
  if (!result)
    return NextResponse.json(
      { error: "job result does not match the reserved execution" },
      { status: 409 },
    );
  const resolution = resolveReviewJobResult({ proof, plan });
  if (resolution.status === "invalid")
    return NextResponse.json(
      { error: "stored job card custody is invalid" },
      { status: 409 },
    );
  if (resolution.result) {
    if (!isDeepStrictEqual(resolution.result, result))
      return NextResponse.json(
        { error: "job execution result is immutable" },
        { status: 409 },
      );
    try {
      return NextResponse.json(
        reviewJobResultResponse(
          resolution.result,
          await signedGetUrl(resolution.result.artifactKey),
        ),
        { status: 200 },
      );
    } catch {
      return NextResponse.json(
        { error: "stored job card could not be signed" },
        { status: 500 },
      );
    }
  }
  const reservation = buildReviewJobCardReservation(result);
  try {
    const reservationResult = await appendCurrentReviewJobEventsAtomically({
      workspaceId: proof.job.workspaceId,
      recordId: proof.timeline.record.id,
      jobId: proof.job.id,
      repo: proof.job.repo,
      prNumber: proof.job.prNumber,
      headSha: proof.job.headSha,
      events: [
        {
          eventKey: reviewJobCardReservationEventKey({ proof, plan }),
          stage: REVIEW_JOB_EXECUTION_STAGE,
          actor: REVIEW_JOB_EXECUTION_ACTOR,
          payloadRef: reservation,
        },
      ],
    });
    const reserved = reservationResult.events[0]!;
    if (!isDeepStrictEqual(reserved.event.payloadRef, reservation))
      return NextResponse.json(
        { error: "job card upload is immutable" },
        { status: 409 },
      );
  } catch (error) {
    if (error instanceof CurrentReviewJobNotCurrentError)
      return NextResponse.json(
        { error: "review job is no longer current for this pull request head" },
        { status: 409 },
      );
    return NextResponse.json(
      { error: "could not reserve job card custody" },
      { status: 503 },
    );
  }
  try {
    await putArtifact(key, card, "application/json");
  } catch {
    return NextResponse.json(
      { error: "failed to store the job card" },
      { status: 500 },
    );
  }
  try {
    const recorded = await appendChangeRecordEvent({
      recordId: proof.timeline.record.id,
      eventKey: reviewJobResultEventKey({ proof, plan }),
      stage: REVIEW_JOB_EXECUTION_STAGE,
      actor: REVIEW_JOB_EXECUTION_ACTOR,
      payloadRef: result,
    });
    if (!isDeepStrictEqual(recorded.event.payloadRef, result))
      return NextResponse.json(
        { error: "job execution result is immutable" },
        { status: 409 },
      );
    try {
      return NextResponse.json(
        reviewJobResultResponse(result, await signedGetUrl(key)),
        { status: recorded.inserted ? 201 : 200 },
      );
    } catch {
      return NextResponse.json(
        { error: "job result was stored but card could not be signed" },
        { status: 500 },
      );
    }
  } catch {
    return NextResponse.json(
      {
        error:
          "job card stored under durable reservation but receipt could not be recorded",
      },
      { status: 503 },
    );
  }
}
