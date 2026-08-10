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
  REVIEW_JOB_API_ACTOR,
  REVIEW_JOB_API_STAGE,
  buildReviewJobApiAttempt,
  buildReviewJobApiCardReservation,
  buildReviewJobApiResult,
  findReviewJobApiAttemptByExecutionId,
  resolveReviewJobApiResult,
  reviewJobApiCardReservationEventKey,
  reviewJobApiResultEventKey,
  reviewJobApiResultResponse,
} from "../../../../../../../../../lib/review-job-api-execution";

function nonBlank(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function parseBody(
  value: unknown,
): { eveSessionId: string; observedStatus: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const eveSessionId = nonBlank(input.eveSessionId);
  const observedStatus = input.observedStatus;
  return isDeepStrictEqual(Object.keys(input).sort(), [
    "eveSessionId",
    "observedStatus",
  ]) &&
    typeof observedStatus === "number" &&
    Number.isInteger(observedStatus) &&
    observedStatus >= 100 &&
    observedStatus <= 599 &&
    eveSessionId
    ? { eveSessionId, observedStatus }
    : null;
}
function future(value: unknown): boolean {
  const time =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(time) && time > Date.now();
}
function evidenceStorageEnabled(): boolean {
  return (
    process.env.REVIEW_EVIDENCE_ENABLED === "1" &&
    storageConfigured(process.env)
  );
}

/** Complete only the server-reserved GET receipt; request bytes and headers never cross this boundary. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string; executionId: string }> },
) {
  const auth = requireJaceConsoleSecret(request);
  if (auth) return auth;
  if (!evidenceStorageEnabled())
    return NextResponse.json(
      { error: "evidence storage not enabled" },
      { status: 503 },
    );
  const body = parseBody(await request.json().catch(() => null));
  const route = await params;
  const jobId = nonBlank(route.jobId);
  const executionId = nonBlank(route.executionId);
  if (!body || !jobId || !executionId)
    return NextResponse.json(
      {
        error:
          "eveSessionId and observedStatus are required and must be the only fields",
      },
      { status: 400 },
    );
  const session = await getJaceSessionByEveSessionId(body.eveSessionId);
  if (
    !session ||
    session.eveSessionId !== body.eveSessionId ||
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
  const execution = findReviewJobApiAttemptByExecutionId({
    proof,
    executionId,
  });
  if (!execution)
    return NextResponse.json(
      { error: "API execution was not reserved for this exact review plan" },
      { status: 409 },
    );
  const { plan, attempt } = execution;
  const boot = await getPreviewBoot(attempt.previewBootId);
  const current =
    boot && future(boot.expiresAt)
      ? buildReviewJobApiAttempt({ proof, plan, boot })
      : null;
  if (!current || !isDeepStrictEqual(current, attempt))
    return NextResponse.json(
      { error: "exact-head preview is no longer ready for this API execution" },
      { status: 409 },
    );
  const card = Buffer.from(
    JSON.stringify({
      request: {
        method: attempt.apiRequest.method,
        path: attempt.apiRequest.path,
      },
      response: { status: body.observedStatus },
      assertion: {
        expectedStatus: attempt.apiRequest.expectedStatus,
        passed: body.observedStatus === attempt.apiRequest.expectedStatus,
      },
    }) + "\n",
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
  const result = buildReviewJobApiResult({
    attempt,
    plan,
    observedStatus: body.observedStatus,
    artifactKey: key,
    contentSha256: digest,
  });
  if (!result)
    return NextResponse.json(
      { error: "API result does not match the reserved execution" },
      { status: 409 },
    );
  const resolution = resolveReviewJobApiResult({ proof, plan });
  if (resolution.status === "invalid")
    return NextResponse.json(
      { error: "stored API card custody is invalid" },
      { status: 409 },
    );
  if (resolution.result) {
    if (!isDeepStrictEqual(resolution.result, result))
      return NextResponse.json(
        { error: "API execution result is immutable" },
        { status: 409 },
      );
    try {
      return NextResponse.json(
        reviewJobApiResultResponse(
          resolution.result,
          await signedGetUrl(resolution.result.artifactKey),
        ),
        { status: 200 },
      );
    } catch {
      return NextResponse.json(
        { error: "stored API card could not be signed" },
        { status: 500 },
      );
    }
  }
  const reservation = buildReviewJobApiCardReservation(result);
  let reserved: Awaited<
    ReturnType<typeof appendCurrentReviewJobEventsAtomically>
  >["events"][number];
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
          eventKey: reviewJobApiCardReservationEventKey({ proof, plan }),
          stage: REVIEW_JOB_API_STAGE,
          actor: REVIEW_JOB_API_ACTOR,
          payloadRef: reservation,
        },
      ],
    });
    reserved = reservationResult.events[0]!;
  } catch (error) {
    if (error instanceof CurrentReviewJobNotCurrentError)
      return NextResponse.json(
        { error: "review job is no longer current for this pull request head" },
        { status: 409 },
      );
    return NextResponse.json(
      { error: "could not reserve API card custody" },
      { status: 503 },
    );
  }
  if (!isDeepStrictEqual(reserved.event.payloadRef, reservation))
    return NextResponse.json(
      { error: "API card upload is immutable" },
      { status: 409 },
    );
  try {
    await putArtifact(key, card, "application/json");
  } catch {
    return NextResponse.json(
      { error: "failed to store the API card" },
      { status: 500 },
    );
  }
  let recorded: Awaited<ReturnType<typeof appendChangeRecordEvent>>;
  try {
    recorded = await appendChangeRecordEvent({
      recordId: proof.timeline.record.id,
      eventKey: reviewJobApiResultEventKey({ proof, plan }),
      stage: REVIEW_JOB_API_STAGE,
      actor: REVIEW_JOB_API_ACTOR,
      payloadRef: result,
    });
  } catch {
    return NextResponse.json(
      {
        error:
          "API card stored under durable reservation but receipt could not be recorded",
      },
      { status: 503 },
    );
  }
  if (!isDeepStrictEqual(recorded.event.payloadRef, result))
    return NextResponse.json(
      { error: "API execution result is immutable" },
      { status: 409 },
    );
  try {
    return NextResponse.json(
      reviewJobApiResultResponse(result, await signedGetUrl(key)),
      { status: recorded.inserted ? 201 : 200 },
    );
  } catch {
    return NextResponse.json(
      { error: "API result was stored but card could not be signed" },
      { status: 500 },
    );
  }
}
