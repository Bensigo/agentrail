import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  AcceptancePrDecisionConflictError,
  getWorkspaceMembership,
  readCurrentAcceptancePrDecision,
  readCurrentAcceptanceCorrectionPackets,
  readChangeRecordTimeline,
  recordAcceptancePrDecision,
} from "@agentrail/db-postgres";

const MAX_DECISION_BODY_BYTES = 20 * 1024;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_LIKE = /(?:\b(?:bearer|token|authorization)\s+|\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+))/i;

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function readBoundedJson(request: Request): Promise<unknown | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null
    && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_DECISION_BODY_BYTES)) {
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
      if (total > MAX_DECISION_BODY_BYTES) {
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

    const [resolvedCorrectionPackets, resolvedFinalDecision] = await Promise.all([
      readCurrentAcceptanceCorrectionPackets({ workspaceId, recordId }),
      readCurrentAcceptancePrDecision({ workspaceId, recordId }),
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
        payloadRef: event.payloadRef,
        at: event.at.toISOString(),
        createdAt: event.createdAt.toISOString(),
      })),
      correctionPackets,
      finalDecision,
      canRecordFinalDecision:
        membership.role === "owner" || membership.role === "admin",
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
 * Record a human decision for the server-derived current exact-head review.
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
    !== "application/json") return json({ error: "Invalid final decision" }, 400);

  const body = parseDecisionBody(await readBoundedJson(request));
  if (!body) return json({ error: "Invalid final decision" }, 400);

  try {
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
    if (error instanceof AcceptancePrDecisionConflictError) {
      return json({ error: "Final decision conflicts with the existing exact-head decision" }, 409);
    }
    console.error("[change-records] failed to record final decision:", error);
    return json({ error: "Final decision unavailable" }, 503);
  }
}
