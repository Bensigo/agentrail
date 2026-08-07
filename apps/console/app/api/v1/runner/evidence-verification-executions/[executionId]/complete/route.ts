import { NextRequest, NextResponse } from "next/server";
import { reportEvidenceVerificationExecution } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../lib/jace-console-auth";

const terminal = new Set(["proven", "not_proven", "not_testable", "failed"]);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export async function POST(request: NextRequest, { params }: { params: Promise<{ executionId: string }> }) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;
  const { executionId } = await params;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (!text(executionId) || !text(body.workerId) || typeof body.status !== "string" || !terminal.has(body.status) || (body.observedBehavior !== undefined && typeof body.observedBehavior !== "string") || (body.resultReason !== undefined && typeof body.resultReason !== "string") || (body.artifactIds !== undefined && (!Array.isArray(body.artifactIds) || body.artifactIds.some((id) => !text(id))))) {
    return NextResponse.json({ error: "invalid verification execution result" }, { status: 400 });
  }
  if (body.status === "proven" && (!text(body.observedBehavior) || !Array.isArray(body.artifactIds) || body.artifactIds.length === 0)) {
    return NextResponse.json({ error: "proven requires observedBehavior and artifactIds" }, { status: 400 });
  }
  try {
    const execution = await reportEvidenceVerificationExecution({ executionId, workerId: body.workerId, status: body.status as "proven" | "not_proven" | "not_testable" | "failed", observedBehavior: text(body.observedBehavior) ? body.observedBehavior : null, artifactIds: body.artifactIds as string[] | undefined, resultReason: text(body.resultReason) ? body.resultReason : null });
    if (!execution) return NextResponse.json({ error: "execution not found, not claimed by worker, or already terminal" }, { status: 409 });
    return NextResponse.json({ execution: { id: execution.id, status: execution.status, artifactIds: execution.artifactIds } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to record verification result" }, { status: 409 });
  }
}
