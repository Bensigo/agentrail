import { isDeepStrictEqual } from "util";
import { NextRequest, NextResponse } from "next/server";
import {
  appendChangeRecordEvent,
  getJaceSessionByEveSessionId,
  getReviewJobById,
  readAcceptanceContracts,
  readChangeRecordTimelineByPr,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../lib/jace-console-auth";
import {
  REVIEW_JOB_VERIFICATION_PLAN_ACTOR,
  REVIEW_JOB_VERIFICATION_PLAN_STAGE,
  activeReviewDataHmacKey,
  buildReviewJobVerificationPlan,
  confirmedVerificationContract,
  reviewJobVerificationPlanEventKey,
} from "../../../../../../../lib/review-job-verification-plan";

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseBody(raw: unknown): { eveSessionId: string; plans: unknown[] } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "eveSessionId" ||
    keys[1] !== "plans" ||
    !nonBlank(input.eveSessionId) ||
    !Array.isArray(input.plans) ||
    input.plans.length === 0
  ) {
    return null;
  }
  return { eveSessionId: input.eveSessionId.trim(), plans: input.plans };
}

function exactTimeline(
  job: { workspaceId: string; repo: string; prNumber: number; headSha: string },
  timeline: Awaited<ReturnType<typeof readChangeRecordTimelineByPr>>
): timeline is NonNullable<typeof timeline> {
  return !!timeline &&
    timeline.record.workspaceId === job.workspaceId &&
    timeline.record.repo === job.repo &&
    timeline.record.prNumber === job.prNumber &&
    timeline.record.headShas.includes(job.headSha);
}

/** Persist one immutable safe-environment choice for every confirmed criterion. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  const body = parseBody(await request.json().catch(() => null));
  const jobId = (await params).jobId?.trim();
  if (!body || !jobId) {
    return NextResponse.json(
      { error: "eveSessionId and plans must be the only request fields" },
      { status: 400 }
    );
  }

  const session = await getJaceSessionByEveSessionId(body.eveSessionId);
  if (
    !session ||
    session.eveSessionId !== body.eveSessionId ||
    session.channel !== "review-job" ||
    session.conversationKey !== `review-job:${jobId}` ||
    session.status !== "active"
  ) {
    return NextResponse.json({ error: "review session is not bound to this job" }, { status: 409 });
  }

  const job = await getReviewJobById(jobId);
  if (
    !job ||
    job.state !== "running" ||
    !session.workspaceId ||
    session.workspaceId !== job.workspaceId
  ) {
    return NextResponse.json({ error: "review job not found or not running" }, { status: 409 });
  }

  const timeline = await readChangeRecordTimelineByPr({
    workspaceId: job.workspaceId,
    repo: job.repo,
    prNumber: job.prNumber,
  });
  if (!exactTimeline(job, timeline)) {
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

  const built = buildReviewJobVerificationPlan({
    job,
    recordId: timeline.record.id,
    contract,
    // Stable across stale-claim retries. The bound active session authorizes
    // this call above, while the durable actor is the review worker role;
    // baking a transient Eve session id into an immutable plan would make an
    // otherwise identical retry conflict with its predecessor.
    plannedBy: "jace:review-job-worker",
    plans: body.plans,
    dataHmacKey: activeReviewDataHmacKey(process.env),
  });
  if (!built.ok) {
    return NextResponse.json({ error: built.error }, { status: 400 });
  }

  const eventKey = reviewJobVerificationPlanEventKey(job.id);
  const existing = timeline.events.find((event) => event.eventKey === eventKey);
  if (existing) {
    if (!isDeepStrictEqual(existing.payloadRef, built.value)) {
      return NextResponse.json(
        { error: "verification plan is immutable for this review job" },
        { status: 409 }
      );
    }
    return NextResponse.json({
      ok: true,
      inserted: false,
      headSha: job.headSha,
      acceptanceContractVersion: contract.version,
      plans: built.value.plans,
    });
  }

  const recorded = await appendChangeRecordEvent({
    recordId: timeline.record.id,
    eventKey,
    stage: REVIEW_JOB_VERIFICATION_PLAN_STAGE,
    actor: REVIEW_JOB_VERIFICATION_PLAN_ACTOR,
    payloadRef: built.value,
  });
  if (!isDeepStrictEqual(recorded.event.payloadRef, built.value)) {
    return NextResponse.json(
      { error: "verification plan is immutable for this review job" },
      { status: 409 }
    );
  }

  return NextResponse.json(
    {
      ok: true,
      inserted: recorded.inserted,
      headSha: job.headSha,
      acceptanceContractVersion: contract.version,
      plans: built.value.plans,
    },
    { status: recorded.inserted ? 201 : 200 }
  );
}
