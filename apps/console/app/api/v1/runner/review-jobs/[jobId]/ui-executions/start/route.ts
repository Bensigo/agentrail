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
  REVIEW_JOB_UI_ACTOR,
  REVIEW_JOB_UI_STAGE,
  buildReviewJobUiAttempt,
  plannedUiCriterion,
  reviewJobUiAttemptEventKey,
} from "../../../../../../../../lib/review-job-ui-execution";

interface StartBody {
  eveSessionId: string;
  criterionId: string;
  previewBootId: string;
}

function nonBlank(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function parseBody(value: unknown): StartBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  const expected = ["criterionId", "eveSessionId", "previewBootId"];
  if (
    keys.length !== expected.length ||
    !keys.every((key, index) => key === expected[index])
  ) {
    return null;
  }
  const eveSessionId = nonBlank(input.eveSessionId);
  const criterionId = nonBlank(input.criterionId);
  const previewBootId = nonBlank(input.previewBootId);
  return eveSessionId && criterionId && previewBootId
    ? { eveSessionId, criterionId, previewBootId }
    : null;
}

function activeFutureExpiry(value: unknown): boolean {
  const timestamp =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

/** Reserve one deterministic, plan-bound UI execution before browser actions. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;

  const body = parseBody(await request.json().catch(() => null));
  const jobId = nonBlank((await params).jobId);
  if (!body || !jobId) {
    return NextResponse.json(
      {
        error:
          "eveSessionId, criterionId, and previewBootId are required and must be the only fields",
      },
      { status: 400 }
    );
  }

  // Bind the worker session before resolving an arbitrary job identifier.
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

  const proof = await resolveCurrentReviewJobPlan(jobId);
  if (
    !proof ||
    !session.workspaceId ||
    session.workspaceId !== proof.job.workspaceId
  ) {
    return NextResponse.json(
      { error: "review job plan is not current for this session" },
      { status: 409 }
    );
  }
  const plan = plannedUiCriterion(proof, body.criterionId);
  if (!plan) {
    return NextResponse.json(
      { error: "criterion has no executable planned UI flow" },
      { status: 409 }
    );
  }

  const boot = await getPreviewBoot(body.previewBootId);
  if (!boot || !activeFutureExpiry(boot.expiresAt)) {
    return NextResponse.json(
      { error: "exact-head preview is not ready for a new UI execution" },
      { status: 409 }
    );
  }
  const attempt = buildReviewJobUiAttempt({ proof, plan, boot });
  if (!attempt) {
    return NextResponse.json(
      { error: "exact-head preview is not ready for this planned UI criterion" },
      { status: 409 }
    );
  }

  const eventKey = reviewJobUiAttemptEventKey({ proof, plan });
  if (proof.timeline.events.some((event) => event.eventKey === eventKey)) {
    return NextResponse.json(
      {
        error:
          "UI execution is already reserved; automatic replay is held to avoid repeating browser mutations",
      },
      { status: 409 }
    );
  }

  let recorded: Awaited<
    ReturnType<typeof appendCurrentReviewJobEventsAtomically>
  >["events"][number];
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
          stage: REVIEW_JOB_UI_STAGE,
          actor: REVIEW_JOB_UI_ACTOR,
          payloadRef: attempt,
        },
      ],
    });
    recorded = result.events[0]!;
  } catch (error) {
    if (error instanceof CurrentReviewJobNotCurrentError) {
      return NextResponse.json(
        { error: "review job is no longer current for this pull request head" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "could not reserve the UI execution" },
      { status: 503 }
    );
  }
  if (
    !recorded.inserted ||
    !isDeepStrictEqual(recorded.event.payloadRef, attempt)
  ) {
    return NextResponse.json(
      {
        error:
          "UI execution is already reserved; automatic replay is held to avoid repeating browser mutations",
      },
      { status: 409 }
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
      uiSteps: attempt.uiSteps,
    },
    { status: 201 }
  );
}
