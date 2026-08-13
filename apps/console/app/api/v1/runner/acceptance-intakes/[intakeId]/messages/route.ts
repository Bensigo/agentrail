import { NextRequest, NextResponse } from "next/server";
import { appendAcceptanceOutboundReply } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../lib/jace-console-auth";

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ intakeId: string }> },
) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;
  const { intakeId } = await params;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  const sourceKey = typeof body?.sourceKey === "string" ? body.sourceKey.trim() : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const metadata = object(body?.metadata) ? body.metadata : {};
  if (!workspaceId || !intakeId.trim() || !sourceKey || sourceKey.length > 512
    || !text || text.length > 20_000) {
    return NextResponse.json({ error: "Invalid Acceptance Intake reply" }, { status: 400 });
  }
  try {
    const result = await appendAcceptanceOutboundReply({
      workspaceId,
      intakeId: intakeId.trim(),
      sourceKey,
      text,
      metadata,
    });
    if (!result) return NextResponse.json({ error: "Acceptance Intake not found" }, { status: 404 });
    return NextResponse.json({
      message: {
        id: result.message.id,
        sourceKey: result.message.sourceKey,
        direction: result.message.direction,
      },
      inserted: result.inserted,
    }, { status: result.inserted ? 201 : 200 });
  } catch {
    return NextResponse.json({ error: "Failed to record Jace reply" }, { status: 502 });
  }
}
