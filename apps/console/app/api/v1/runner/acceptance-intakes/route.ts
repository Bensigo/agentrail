import { NextRequest, NextResponse } from "next/server";
import { recordAcceptanceInboundIntake } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

function plain(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** Jace-only durable intake seam. It records provenance; it never confirms or executes work. */
export async function POST(request: NextRequest) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  const originChannel = typeof body?.originChannel === "string" ? body.originChannel.trim() : "";
  const conversationKey = typeof body?.conversationKey === "string" ? body.conversationKey.trim() : "";
  const sourceKey = typeof body?.sourceKey === "string" ? body.sourceKey.trim() : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const sourceReferences = body?.sourceReferences;
  if (!workspaceId || !originChannel || !conversationKey || !sourceKey || !text ||
      (sourceReferences !== undefined && (!Array.isArray(sourceReferences) || sourceReferences.length > 32 || !sourceReferences.every(plain)))) {
    return NextResponse.json({ error: "workspaceId, originChannel, conversationKey, sourceKey, text, and at most 32 object sourceReferences are required" }, { status: 400 });
  }
  try {
    const result = await recordAcceptanceInboundIntake({
      workspaceId, originChannel, conversationKey, sourceKey, text,
      sourceReferences: sourceReferences as Record<string, unknown>[] | undefined,
      metadata: plain(body?.metadata) ? body.metadata : {},
    });
    return NextResponse.json({ intake: { id: result.intake.id, status: result.intake.status }, message: { id: result.message.id, sourceKey: result.message.sourceKey }, inserted: result.inserted }, { status: result.inserted ? 201 : 200 });
  } catch (error) {
    console.error("[runner/acceptance-intakes] failed:", error);
    return NextResponse.json({ error: "Failed to record Acceptance Intake" }, { status: 502 });
  }
}
