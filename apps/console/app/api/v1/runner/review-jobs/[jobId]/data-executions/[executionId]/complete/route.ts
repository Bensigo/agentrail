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
  REVIEW_JOB_DATA_ACTOR,
  REVIEW_JOB_DATA_STAGE,
  buildReviewJobDataAttempt,
  buildReviewJobDataCard,
  buildReviewJobDataCardReservation,
  buildReviewJobDataResult,
  findReviewJobDataAttemptByExecutionId,
  resolveReviewJobDataResult,
  reviewJobDataCardReservationEventKey,
  reviewJobDataResultEventKey,
  reviewJobDataResultResponse,
} from "../../../../../../../../../lib/review-job-data-execution";
import { reviewDataHmacKeyById } from "../../../../../../../../../lib/review-job-verification-plan";
const nonBlank = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
function body(value: unknown): {
  eveSessionId: string;
  observedStatus: number;
  observations: unknown[];
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const eveSessionId = nonBlank(input.eveSessionId);
  return isDeepStrictEqual(Object.keys(input).sort(), [
    "eveSessionId",
    "observations",
    "observedStatus",
  ]) &&
    eveSessionId &&
    Number.isInteger(input.observedStatus) &&
    (input.observedStatus as number) >= 100 &&
    (input.observedStatus as number) <= 599 &&
    Array.isArray(input.observations)
    ? {
        eveSessionId,
        observedStatus: input.observedStatus as number,
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
  const input = body(await request.json().catch(() => null));
  const route = await params;
  const jobId = nonBlank(route.jobId);
  const executionId = nonBlank(route.executionId);
  if (!input || !jobId || !executionId)
    return NextResponse.json(
      {
        error:
          "eveSessionId, observedStatus, and observations are required and must be the only fields",
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
  const execution = findReviewJobDataAttemptByExecutionId({
    proof,
    executionId,
  });
  if (!execution)
    return NextResponse.json(
      { error: "data execution was not reserved for this exact review plan" },
      { status: 409 },
    );
  const { plan, attempt } = execution;
  if (!reviewDataHmacKeyById(process.env, attempt.dataRequest.digestKeyId))
    return NextResponse.json(
      {
        error:
          "planned review-data HMAC key is unavailable; completion is held",
      },
      { status: 409 },
    );
  const boot = await getPreviewBoot(attempt.previewBootId);
  const current =
    boot && future(boot.expiresAt)
      ? buildReviewJobDataAttempt({ proof, plan, boot })
      : null;
  if (!current || !isDeepStrictEqual(current, attempt))
    return NextResponse.json(
      {
        error: "exact-head preview is no longer ready for this data execution",
      },
      { status: 409 },
    );
  const provisional = buildReviewJobDataResult({
    attempt,
    plan,
    observedStatus: input.observedStatus,
    observations: input.observations,
    artifactKey: "pending",
    contentSha256: "0".repeat(64),
  });
  if (!provisional)
    return NextResponse.json(
      { error: "data observations do not match the reserved execution" },
      { status: 400 },
    );
  const card = Buffer.from(
    JSON.stringify(buildReviewJobDataCard(provisional)) + "\n",
    "utf8",
  );
  const digest = createHash("sha256").update(card).digest("hex");
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
  const result = buildReviewJobDataResult({
    attempt,
    plan,
    observedStatus: input.observedStatus,
    observations: input.observations,
    artifactKey: key,
    contentSha256: digest,
  });
  if (!result)
    return NextResponse.json(
      { error: "data result does not match the reserved execution" },
      { status: 409 },
    );
  const resolution = resolveReviewJobDataResult({ proof, plan });
  if (resolution.status === "invalid")
    return NextResponse.json(
      { error: "stored data card custody is invalid" },
      { status: 409 },
    );
  if (resolution.result) {
    if (!isDeepStrictEqual(resolution.result, result))
      return NextResponse.json(
        { error: "data execution result is immutable" },
        { status: 409 },
      );
    try {
      return NextResponse.json(
        reviewJobDataResultResponse(
          resolution.result,
          await signedGetUrl(resolution.result.artifactKey),
        ),
        { status: 200 },
      );
    } catch {
      return NextResponse.json(
        { error: "stored data card could not be signed" },
        { status: 500 },
      );
    }
  }
  const reservation = buildReviewJobDataCardReservation(result);
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
          eventKey: reviewJobDataCardReservationEventKey({ proof, plan }),
          stage: REVIEW_JOB_DATA_STAGE,
          actor: REVIEW_JOB_DATA_ACTOR,
          payloadRef: reservation,
        },
      ],
    });
    const reserved = reservationResult.events[0]!;
    if (!isDeepStrictEqual(reserved.event.payloadRef, reservation))
      return NextResponse.json(
        { error: "data card upload is immutable" },
        { status: 409 },
      );
  } catch (error) {
    if (error instanceof CurrentReviewJobNotCurrentError)
      return NextResponse.json(
        { error: "review job is no longer current for this pull request head" },
        { status: 409 },
      );
    return NextResponse.json(
      { error: "could not reserve data card custody" },
      { status: 503 },
    );
  }
  try {
    await putArtifact(key, card, "application/json");
  } catch {
    return NextResponse.json(
      { error: "failed to store the data card" },
      { status: 500 },
    );
  }
  try {
    const recorded = await appendChangeRecordEvent({
      recordId: proof.timeline.record.id,
      eventKey: reviewJobDataResultEventKey({ proof, plan }),
      stage: REVIEW_JOB_DATA_STAGE,
      actor: REVIEW_JOB_DATA_ACTOR,
      payloadRef: result,
    });
    if (!isDeepStrictEqual(recorded.event.payloadRef, result))
      return NextResponse.json(
        { error: "data execution result is immutable" },
        { status: 409 },
      );
    try {
      return NextResponse.json(
        reviewJobDataResultResponse(result, await signedGetUrl(key)),
        { status: recorded.inserted ? 201 : 200 },
      );
    } catch {
      return NextResponse.json(
        { error: "data result was stored but card could not be signed" },
        { status: 500 },
      );
    }
  } catch {
    return NextResponse.json(
      {
        error:
          "data card stored under durable reservation but receipt could not be recorded",
      },
      { status: 503 },
    );
  }
}
