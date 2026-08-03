import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  appendJudgmentEvent,
  getRepository,
  getReviewGate,
  getRun,
  getWorkspaceMembership,
} from "@agentrail/db-postgres";
import type { ReviewGateFinding } from "@/(dashboard)/dashboard/[workspaceId]/review-gates/finding-issue";

const DISPOSITIONS = ["accepted", "edited", "dismissed"] as const;
type Disposition = (typeof DISPOSITIONS)[number];

function isDisposition(value: unknown): value is Disposition {
  return typeof value === "string" && (DISPOSITIONS as readonly string[]).includes(value);
}

function eventSuffix(input: {
  disposition: Disposition;
  editedDescription?: string;
  editedSuggestedFix?: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 24);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; gateId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, gateId } = await params;
  if (!(await getWorkspaceMembership(session.user.id, workspaceId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    findingIndex?: unknown;
    disposition?: unknown;
    editedDescription?: unknown;
    editedSuggestedFix?: unknown;
  };
  const findingIndex = body.findingIndex;
  if (
    typeof findingIndex !== "number" ||
    !Number.isInteger(findingIndex) ||
    findingIndex < 0
  ) {
    return NextResponse.json({ error: "findingIndex must be a non-negative integer" }, { status: 400 });
  }
  if (!isDisposition(body.disposition)) {
    return NextResponse.json({ error: "disposition must be accepted, edited, or dismissed" }, { status: 400 });
  }
  const disposition = body.disposition;
  const editedDescription = typeof body.editedDescription === "string" ? body.editedDescription.trim() : undefined;
  const editedSuggestedFix = typeof body.editedSuggestedFix === "string" ? body.editedSuggestedFix.trim() : undefined;
  if (disposition === "edited" && !editedDescription && !editedSuggestedFix) {
    return NextResponse.json({ error: "edited disposition requires editedDescription or editedSuggestedFix" }, { status: 400 });
  }
  if (editedDescription && editedDescription.length > 4000 || editedSuggestedFix && editedSuggestedFix.length > 4000) {
    return NextResponse.json({ error: "edited finding text is too long" }, { status: 413 });
  }

  const gate = await getReviewGate(workspaceId, gateId);
  if (!gate) return NextResponse.json({ error: "Review gate not found" }, { status: 404 });
  const finding = (gate.findings ?? [])[findingIndex] as ReviewGateFinding | undefined;
  if (!finding) return NextResponse.json({ error: "Finding not found at that index" }, { status: 404 });

  const run = await getRun(workspaceId, gate.runId).catch(() => null);
  const repository = run?.repositoryId
    ? await getRepository(workspaceId, run.repositoryId).catch(() => null)
    : null;
  if (!repository?.name) {
    return NextResponse.json({ error: "Review gate has no associated repository" }, { status: 422 });
  }

  const result = await appendJudgmentEvent({
    workspaceId,
    repo: repository.name,
    eventKey: `review:finding:${gateId}:${findingIndex}:${disposition}:${eventSuffix({ disposition, editedDescription, editedSuggestedFix })}`,
    type: "review_outcome",
    refs: { findingId: `${gateId}:${findingIndex}`, runId: gate.runId },
    payload: {
      disposition,
      findingClass: finding.category,
      originalDescription: finding.description,
      originalSuggestedFix: finding.suggested_fix,
      ...(editedDescription ? { editedDescription } : {}),
      ...(editedSuggestedFix ? { editedSuggestedFix } : {}),
    },
    actorRef: { kind: "workspace_member", id: session.user.id },
    sourceRef: { kind: "console_review_gate", id: gateId },
  });

  return NextResponse.json({ ok: true, inserted: result.inserted, event: result.event }, { status: result.inserted ? 201 : 200 });
}
