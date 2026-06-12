import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  getReviewGatesForRun,
  getRunEvidenceFields,
  createReviewGate,
  getRun,
} from "@agentrail/db-postgres";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; runId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, runId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const gates = await getReviewGatesForRun(workspaceId, runId);
    return NextResponse.json({ gates });
  } catch (err) {
    console.error("[review-gates] failed to load gates for run:", err);
    return NextResponse.json({ error: "Failed to load review gates" }, { status: 500 });
  }
}

interface ContextEvidenceResult {
  status: "passed" | "failed";
  blockingReasons: string[];
  conditions: Record<string, unknown>[];
}

function evaluateContextEvidence(
  evidence: {
    contextPackFile?: string | null;
    selectedSources?: unknown[] | null;
    retrievalBudget?: unknown | null;
    citations?: unknown[] | null;
  },
  enforce: boolean
): ContextEvidenceResult {
  const blockingReasons: string[] = [];

  if (!evidence.contextPackFile) {
    blockingReasons.push("missing contextPackFile");
  }
  if (!evidence.selectedSources || (evidence.selectedSources as unknown[]).length === 0) {
    blockingReasons.push("missing selectedSources");
  }
  if (!evidence.retrievalBudget) {
    blockingReasons.push("missing retrievalBudget");
  }
  if (!evidence.citations || (evidence.citations as unknown[]).length === 0) {
    blockingReasons.push("missing citations");
  }

  const status = blockingReasons.length === 0 ? "passed" : "failed";
  const conditions: Record<string, unknown>[] = [{ enforce, gateName: "context-evidence" }];

  return { status, blockingReasons, conditions };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; runId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, runId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const run = await getRun(workspaceId, runId);
  if (!run) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let enforce = false;
  try {
    const body = await request.json();
    if (typeof body?.enforce === "boolean") {
      enforce = body.enforce;
    }
  } catch {
    // no body or invalid JSON — default enforce=false
  }

  const evidence = await getRunEvidenceFields(workspaceId, runId);
  const result = evaluateContextEvidence(evidence ?? {}, enforce);

  const gate = await createReviewGate({
    workspaceId,
    runId,
    gateName: "context-evidence",
    status: result.status,
    blockingReasons: result.blockingReasons,
    conditions: result.conditions,
    evaluatedAt: new Date(),
  });

  if (result.status === "failed" && enforce) {
    return NextResponse.json(
      { gate, error: "Context evidence gate failed", blockingReasons: result.blockingReasons },
      { status: 422 }
    );
  }

  return NextResponse.json({ gate }, { status: 200 });
}
