import { NextRequest, NextResponse } from "next/server";
import { enqueueEvidenceVerificationExecution } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Admit one criterion-specific exact-head execution; this endpoint never returns a proof verdict. */
export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const fields = ["workspaceId", "recordId", "prRevisionId", "verificationPlanId"];
  if (fields.some((field) => !text(body[field]))) return NextResponse.json({ error: "invalid verification execution payload" }, { status: 400 });
  try {
    const result = await enqueueEvidenceVerificationExecution({
      workspaceId: body.workspaceId as string, recordId: body.recordId as string,
      prRevisionId: body.prRevisionId as string, verificationPlanId: body.verificationPlanId as string,
    });
    return NextResponse.json({ execution: { id: result.execution.id, verificationPlanId: result.execution.verificationPlanId, status: result.execution.status }, inserted: result.inserted }, { status: result.inserted ? 201 : 200 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to queue verification execution" }, { status: 409 });
  }
}
