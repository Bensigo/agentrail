import { isDeepStrictEqual } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import {
  appendChangeRecordEvent,
  getJaceSessionByEveSessionId,
  getPreviewBoot,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../../lib/jace-console-auth";
import { resolveCurrentReviewJobPlan } from "../../../../../../../../lib/review-job-proof-attestation";
import {
  REVIEW_JOB_API_ACTOR,
  REVIEW_JOB_API_STAGE,
  buildReviewJobApiAttempt,
  plannedApiCriterion,
  reviewJobApiAttemptEventKey,
} from "../../../../../../../../lib/review-job-api-execution";

function nonBlank(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function parseBody(
  value: unknown,
): { eveSessionId: string; criterionId: string; previewBootId: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (
    !isDeepStrictEqual(keys, ["criterionId", "eveSessionId", "previewBootId"])
  )
    return null;
  const eveSessionId = nonBlank(input.eveSessionId);
  const criterionId = nonBlank(input.criterionId);
  const previewBootId = nonBlank(input.previewBootId);
  return eveSessionId && criterionId && previewBootId
    ? { eveSessionId, criterionId, previewBootId }
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

/** Reserve one deterministic GET-only API execution before any preview request. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const auth = requireJaceConsoleSecret(request);
  if (auth) return auth;
  const body = parseBody(await request.json().catch(() => null));
  const jobId = nonBlank((await params).jobId);
  if (!body || !jobId)
    return NextResponse.json(
      {
        error:
          "eveSessionId, criterionId, and previewBootId are required and must be the only fields",
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
  const plan = plannedApiCriterion(proof, body.criterionId);
  if (!plan)
    return NextResponse.json(
      { error: "criterion has no executable planned GET flow" },
      { status: 409 },
    );
  const boot = await getPreviewBoot(body.previewBootId);
  if (!boot || !future(boot.expiresAt))
    return NextResponse.json(
      { error: "exact-head preview is not ready for a new API execution" },
      { status: 409 },
    );
  const attempt = buildReviewJobApiAttempt({ proof, plan, boot });
  if (!attempt)
    return NextResponse.json(
      {
        error: "exact-head preview is not ready for this planned API criterion",
      },
      { status: 409 },
    );
  const eventKey = reviewJobApiAttemptEventKey({ proof, plan });
  if (proof.timeline.events.some((event) => event.eventKey === eventKey))
    return NextResponse.json(
      { error: "API execution is already reserved; replay is held" },
      { status: 409 },
    );
  let recorded: Awaited<ReturnType<typeof appendChangeRecordEvent>>;
  try {
    recorded = await appendChangeRecordEvent({
      recordId: proof.timeline.record.id,
      eventKey,
      stage: REVIEW_JOB_API_STAGE,
      actor: REVIEW_JOB_API_ACTOR,
      payloadRef: attempt,
    });
  } catch {
    return NextResponse.json(
      { error: "could not reserve the API execution" },
      { status: 503 },
    );
  }
  if (
    !recorded.inserted ||
    !isDeepStrictEqual(recorded.event.payloadRef, attempt)
  )
    return NextResponse.json(
      { error: "API execution is already reserved; replay is held" },
      { status: 409 },
    );
  return NextResponse.json(
    {
      ok: true,
      executionId: attempt.executionId,
      jobId: attempt.jobId,
      criterionId: attempt.criterionId,
      expected: attempt.criterionTextSnapshot,
      previewBootId: attempt.previewBootId,
      previewUrl: attempt.previewUrl,
      apiRequest: attempt.apiRequest,
    },
    { status: 201 },
  );
}
