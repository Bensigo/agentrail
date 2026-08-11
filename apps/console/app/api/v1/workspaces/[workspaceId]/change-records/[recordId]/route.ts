import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  AcceptanceDependencyExternalBuilderPackConflictError,
  AcceptancePrDecisionConflictError,
  AcceptancePrReviewEffortConflictError,
  approveAcceptanceDependencyObservationAndMintExternalBuilderPack,
  getWorkspaceMembership,
  readAcceptancePrReviewMetrics,
  readAcceptanceRecordDetail,
  readCurrentAcceptanceDependencyObservations,
  readCurrentAcceptancePrDecision,
  readCurrentAcceptanceCorrectionPackets,
  readChangeRecordTimeline,
  readDependencyDraftProposalDetail,
  recordAcceptancePrDecision,
  recordAcceptancePrReviewEffort,
} from "@agentrail/db-postgres";

const MAX_PATCH_BODY_BYTES = 20 * 1024;
const MAX_DECISION_RATIONALE_CHARS = 4_000;

type AcceptancePrDecision =
  | "approved"
  | "changes_requested"
  | "rejected"
  | "approved_with_exception";

type ParsedDecisionBody = {
  action: "record_pr_decision";
  bindingId: string;
  decision: AcceptancePrDecision;
  rationale?: string;
};

type ParsedReviewEffortBody = {
  action: "record_pr_review_effort";
  bindingId: string;
  minutes: number;
};

type ParsedDependencyObservationApprovalBody = {
  action: "approve_dependency_observation";
  observationEventId: string;
};

type ParsedPatchBody = ParsedDecisionBody
  | ParsedReviewEffortBody
  | ParsedDependencyObservationApprovalBody;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_LIKE = /(?:\b(?:bearer|token|authorization)\s+|\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+))/i;
const REDACTED_DEPENDENCY_PROPOSAL_PAYLOAD = {
  kind: "redacted_dependency_observation_proposal",
  version: 1,
  disclosure: "bounded_projection_only",
} as const;

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function containsDependencyCommandFields(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(value)) {
    return value.some((item) => containsDependencyCommandFields(item, depth + 1));
  }
  if (!object(value)) return false;
  return Object.entries(value).some(([key, nested]) =>
    key === "manager_commands" || key === "verification_commands"
      || containsDependencyCommandFields(nested, depth + 1));
}

function timelinePayloadRef(event: {
  stage: string;
  eventKey: string;
  payloadRef: unknown;
}): Record<string, unknown> {
  const dependencyProposal = event.stage === "dependency_observation_proposal"
    || event.eventKey.startsWith("dependency-observation-proposal:")
    || (object(event.payloadRef)
      && typeof event.payloadRef.kind === "string"
      && event.payloadRef.kind.startsWith("dependency_observation_proposal"));
  if (dependencyProposal || containsDependencyCommandFields(event.payloadRef)) {
    return REDACTED_DEPENDENCY_PROPOSAL_PAYLOAD;
  }
  return object(event.payloadRef) ? event.payloadRef : { kind: "invalid_payload_reference" };
}

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function readBoundedJson(request: Request): Promise<unknown | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null
    && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_PATCH_BODY_BYTES)) {
    return null;
  }
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_PATCH_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* bounded failure */ }
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function parseDecisionBody(value: unknown): ParsedDecisionBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const expectedKeys = input.rationale === undefined
    ? ["action", "bindingId", "decision"]
    : ["action", "bindingId", "decision", "rationale"];
  const actualKeys = Object.keys(input);
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key) => !expectedKeys.includes(key))) return null;
  if (input.action !== "record_pr_decision"
    || typeof input.bindingId !== "string" || !UUID.test(input.bindingId)
    || (input.decision !== "approved"
      && input.decision !== "changes_requested"
      && input.decision !== "rejected"
      && input.decision !== "approved_with_exception")) return null;

  let rationale: string | undefined;
  if (input.rationale !== undefined) {
    if (typeof input.rationale !== "string") return null;
    rationale = input.rationale.trim();
    if (!rationale || rationale.length > MAX_DECISION_RATIONALE_CHARS
      || /[\u0000-\u001f\u007f]/u.test(rationale) || SECRET_LIKE.test(rationale)) return null;
  }
  if (input.decision === "approved_with_exception" && rationale === undefined) return null;
  return {
    action: "record_pr_decision",
    bindingId: input.bindingId,
    decision: input.decision,
    ...(rationale === undefined ? {} : { rationale }),
  };
}

function parseReviewEffortBody(value: unknown): ParsedReviewEffortBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 3
    || !Object.keys(input).every((key) => key === "action" || key === "bindingId" || key === "minutes")
    || input.action !== "record_pr_review_effort"
    || typeof input.bindingId !== "string" || !UUID.test(input.bindingId)
    || !Number.isSafeInteger(input.minutes)
    || (input.minutes as number) < 1 || (input.minutes as number) > 1_440) return null;
  return {
    action: "record_pr_review_effort",
    bindingId: input.bindingId,
    minutes: input.minutes as number,
  };
}

function parseDependencyObservationApprovalBody(
  value: unknown
): ParsedDependencyObservationApprovalBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2
    || !Object.keys(input).every((key) => key === "action" || key === "observationEventId")
    || input.action !== "approve_dependency_observation"
    || typeof input.observationEventId !== "string"
    || !UUID.test(input.observationEventId)) return null;
  return {
    action: "approve_dependency_observation",
    observationEventId: input.observationEventId,
  };
}

function parsePatchBody(value: unknown): ParsedPatchBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const action = (value as Record<string, unknown>).action;
  return action === "record_pr_decision"
    ? parseDecisionBody(value)
    : action === "record_pr_review_effort"
      ? parseReviewEffortBody(value)
      : action === "approve_dependency_observation"
        ? parseDependencyObservationApprovalBody(value)
        : null;
}

function serializeFinalDecision<T extends {
  kind: string;
  decision?: { decidedAt: Date } | null;
}>(result: T): Record<string, unknown> {
  if (!("decision" in result) || result.decision == null) return result;
  return {
    ...result,
    decision: {
      ...result.decision,
      decidedAt: result.decision.decidedAt.toISOString(),
    },
  };
}

function serializeDates(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeDates);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, serializeDates(nested)]),
    );
  }
  return value;
}

function currentDecisionMatchesTimeline(
  timeline: NonNullable<Awaited<ReturnType<typeof readChangeRecordTimeline>>>,
  result: Extract<Awaited<ReturnType<typeof readCurrentAcceptancePrDecision>>, { kind: "current" }>,
): boolean {
  return timeline.record.currentPrHeadAuthoritative
    && timeline.record.workspaceId === result.binding.workspaceId
    && timeline.record.id === result.binding.recordId
    && timeline.record.repo === result.binding.repo
    && timeline.record.prNumber === result.binding.prNumber
    && timeline.record.currentPrHeadSha === result.binding.headSha
    && timeline.record.currentPrHeadCycleId === result.binding.headCycleId
    && timeline.record.currentPrHeadAuthorityGeneration === result.binding.authorityGeneration;
}

function reviewMetricsMatchTimeline(
  timeline: NonNullable<Awaited<ReturnType<typeof readChangeRecordTimeline>>>,
  result: Extract<Awaited<ReturnType<typeof readAcceptancePrReviewMetrics>>, { kind: "record" }>,
): boolean {
  if (timeline.record.workspaceId !== result.workspaceId
    || timeline.record.id !== result.recordId
    || timeline.record.repo !== result.repo
    || timeline.record.prNumber !== result.prNumber) return false;
  if (result.currentCycle === null) return !timeline.record.currentPrHeadAuthoritative;
  return timeline.record.currentPrHeadAuthoritative
    && timeline.record.currentPrHeadSha === result.currentCycle.headSha
    && timeline.record.currentPrHeadCycleId === result.currentCycle.headCycleId
    && timeline.record.currentPrHeadAuthorityGeneration === result.currentCycle.authorityGeneration;
}

function dependencyObservationsMatchTimeline(
  timeline: NonNullable<Awaited<ReturnType<typeof readChangeRecordTimeline>>>,
  result: Extract<Awaited<ReturnType<typeof readCurrentAcceptanceDependencyObservations>>, { kind: "current" }>,
): boolean {
  return timeline.record.currentPrHeadAuthoritative
    && timeline.record.workspaceId === result.binding.workspaceId
    && timeline.record.id === result.binding.recordId
    && timeline.record.repo === result.binding.repo
    && timeline.record.prNumber === result.binding.prNumber
    && timeline.record.currentPrHeadSha === result.binding.headSha
    && timeline.record.currentPrHeadCycleId === result.binding.headCycleId
    && timeline.record.currentPrHeadAuthorityGeneration === result.binding.authorityGeneration;
}

function acceptanceDetailMatchesTimeline(
  timeline: NonNullable<Awaited<ReturnType<typeof readChangeRecordTimeline>>>,
  result: Extract<Awaited<ReturnType<typeof readAcceptanceRecordDetail>>, { kind: "record" }>,
): boolean {
  const { record } = timeline;
  const { detail } = result;
  if (detail.summary.workspaceId !== record.workspaceId
    || detail.summary.recordId !== record.id
    || detail.summary.repo !== record.repo
    || detail.summary.issueNumber !== record.issueNumber) return false;

  if (record.prNumber === null) {
    return detail.summary.pullRequest.kind === "not_attached"
      && detail.pullRequest.kind === "not_attached";
  }
  if (detail.summary.pullRequest.kind !== "attached"
    || detail.summary.pullRequest.prNumber !== record.prNumber
    || detail.pullRequest.kind !== "attached"
    || detail.pullRequest.prNumber !== record.prNumber) return false;

  const current = detail.pullRequest.current;
  if (record.currentPrHeadAuthoritative) {
    if (!current
      || current.repo !== record.repo
      || current.prNumber !== record.prNumber
      || current.headSha !== record.currentPrHeadSha
      || current.headCycleId !== record.currentPrHeadCycleId
      || current.authorityGeneration !== record.currentPrHeadAuthorityGeneration) return false;
  } else if (current !== null) {
    return false;
  }

  const merged = detail.pullRequest.merged;
  return record.mergedSha === null
    ? merged === null
    : merged !== null && merged.repo === record.repo
      && merged.prNumber === record.prNumber && merged.mergeSha === record.mergedSha;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; recordId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, recordId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const timeline = await readChangeRecordTimeline({ workspaceId, recordId });
    if (!timeline) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [
      resolvedCorrectionPackets,
      resolvedFinalDecision,
      resolvedReviewMetrics,
      resolvedDependencyObservations,
      resolvedAcceptanceDetail,
      dependencyDraftProposal,
    ] = await Promise.all([
      readCurrentAcceptanceCorrectionPackets({ workspaceId, recordId }),
      readCurrentAcceptancePrDecision({ workspaceId, recordId }),
      readAcceptancePrReviewMetrics({ workspaceId, recordId }),
      readCurrentAcceptanceDependencyObservations({ workspaceId, recordId }),
      readAcceptanceRecordDetail({ workspaceId, recordId }),
      readDependencyDraftProposalDetail({ workspaceId, recordId }),
    ]);
    const correctionPackets = resolvedCorrectionPackets.kind === "current" && (
      !timeline.record.currentPrHeadAuthoritative
      || timeline.record.workspaceId !== resolvedCorrectionPackets.binding.workspaceId
      || timeline.record.id !== resolvedCorrectionPackets.binding.recordId
      || timeline.record.repo !== resolvedCorrectionPackets.binding.repo
      || timeline.record.prNumber !== resolvedCorrectionPackets.binding.prNumber
      || timeline.record.currentPrHeadSha !== resolvedCorrectionPackets.binding.headSha
      || timeline.record.currentPrHeadCycleId !== resolvedCorrectionPackets.binding.headCycleId
      || timeline.record.currentPrHeadAuthorityGeneration
        !== resolvedCorrectionPackets.binding.authorityGeneration
    )
      ? { kind: "not_current" as const }
      : resolvedCorrectionPackets;
    const finalDecision = resolvedFinalDecision.kind === "current"
      && !currentDecisionMatchesTimeline(timeline, resolvedFinalDecision)
      ? { kind: "not_current" as const }
      : serializeFinalDecision(resolvedFinalDecision);
    const reviewMetrics = resolvedReviewMetrics.kind === "record"
      && !reviewMetricsMatchTimeline(timeline, resolvedReviewMetrics)
      ? { kind: "unavailable" as const, reason: "invalid_review_custody" as const }
      : serializeDates(resolvedReviewMetrics);
    const dependencyObservations = resolvedDependencyObservations.kind === "current"
      && !dependencyObservationsMatchTimeline(timeline, resolvedDependencyObservations)
      ? { kind: "not_current" as const }
      : serializeDates(resolvedDependencyObservations);
    const acceptanceDetail = resolvedAcceptanceDetail.kind === "record"
      && !acceptanceDetailMatchesTimeline(timeline, resolvedAcceptanceDetail)
      ? { kind: "unavailable" as const, reason: "invalid_record_custody" as const }
      : serializeDates(resolvedAcceptanceDetail);
    const canRecordHumanEvidence = membership.role === "owner" || membership.role === "admin";

    return json({
      record: {
        id: timeline.record.id,
        workspaceId: timeline.record.workspaceId,
        repo: timeline.record.repo,
        issueNumber: timeline.record.issueNumber,
        prNumber: timeline.record.prNumber,
        headShas: timeline.record.headShas,
        currentPrHeadSha: timeline.record.currentPrHeadSha,
        currentPrHeadCycleId: timeline.record.currentPrHeadCycleId,
        currentPrHeadAuthoritative: timeline.record.currentPrHeadAuthoritative,
        mergedSha: timeline.record.mergedSha,
        state: timeline.record.state,
        createdAt: timeline.record.createdAt.toISOString(),
        updatedAt: timeline.record.updatedAt.toISOString(),
      },
      events: timeline.events.map((event) => ({
        id: event.id,
        recordId: event.recordId,
        eventKey: event.eventKey,
        stage: event.stage,
        actor: event.actor,
        payloadRef: timelinePayloadRef(event),
        at: event.at.toISOString(),
        createdAt: event.createdAt.toISOString(),
      })),
      correctionPackets,
      finalDecision,
      reviewMetrics,
      dependencyObservations,
      acceptanceDetail,
      dependencyDraftProposal,
      canRecordFinalDecision: canRecordHumanEvidence,
      canRecordReviewEffort: canRecordHumanEvidence,
      canApproveDependencyObservation: canRecordHumanEvidence,
    });
  } catch (err) {
    console.error("[change-records] failed to load detail:", err);
    return NextResponse.json(
      { error: "Failed to load change record detail" },
      { status: 500 }
    );
  }
}

/**
 * Record bounded human evidence for the server-derived current exact-head review.
 * This route has no GitHub client and cannot merge or otherwise mutate the PR.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; recordId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id || !UUID.test(session.user.id)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { workspaceId, recordId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return json({ error: "Forbidden" }, 403);
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    !== "application/json") return json({ error: "Invalid Change Record action" }, 400);

  const body = parsePatchBody(await readBoundedJson(request));
  if (!body) return json({ error: "Invalid Change Record action" }, 400);

  try {
    if (body.action === "approve_dependency_observation") {
      const result = await approveAcceptanceDependencyObservationAndMintExternalBuilderPack({
        workspaceId,
        recordId,
        observationEventId: body.observationEventId,
        approvedBy: `user:${session.user.id}`,
      });
      if (result.kind === "approved" || result.kind === "replayed") {
        return json(serializeDates(result) as Record<string, unknown>, result.kind === "approved" ? 201 : 200);
      }
      if (result.kind === "not_found" || result.kind === "observation_not_found") {
        return json(result, 404);
      }
      if (result.kind === "not_authorized") return json(result, 403);
      return json(result, 409);
    }

    if (body.action === "record_pr_review_effort") {
      const result = await recordAcceptancePrReviewEffort({
        workspaceId,
        recordId,
        bindingId: body.bindingId,
        minutes: body.minutes,
        recordedBy: `user:${session.user.id}`,
      });
      if (result.kind === "recorded" || result.kind === "replayed") {
        return json(serializeDates(result) as Record<string, unknown>, result.kind === "recorded" ? 201 : 200);
      }
      if (result.kind === "not_found") return json(result, 404);
      if (result.kind === "not_authorized") return json(result, 403);
      return json(result, 409);
    }

    const result = await recordAcceptancePrDecision({
      workspaceId,
      recordId,
      bindingId: body.bindingId,
      decision: body.decision,
      ...(body.rationale === undefined ? {} : { rationale: body.rationale }),
      decidedBy: `user:${session.user.id}`,
    });
    if (result.kind === "recorded" || result.kind === "replayed") {
      return json(serializeFinalDecision(result), result.kind === "recorded" ? 201 : 200);
    }
    if (result.kind === "not_found") return json(result, 404);
    if (result.kind === "not_authorized") return json(result, 403);
    return json(result, 409);
  } catch (error) {
    if (error instanceof AcceptanceDependencyExternalBuilderPackConflictError) {
      return json({ error: "Dependency observation approval conflicts with existing Pack custody" }, 409);
    }
    if (error instanceof AcceptancePrReviewEffortConflictError) {
      return json({ error: "Review effort conflicts with the existing exact-head receipt" }, 409);
    }
    if (error instanceof AcceptancePrDecisionConflictError) {
      return json({ error: "Final decision conflicts with the existing exact-head decision" }, 409);
    }
    console.error("[change-records] failed to record human review evidence:", error);
    return json({ error: "Change Record action unavailable" }, 503);
  }
}
