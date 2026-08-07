import { NextRequest, NextResponse } from "next/server";
import { appendAcceptanceOutboundReply } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../lib/jace-console-auth";

function plain(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** Jace-only append seam for a reply that was already delivered to a channel. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ intakeId: string }> },
) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;

  const { intakeId } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  const sourceKey = typeof body?.sourceKey === "string" ? body.sourceKey.trim() : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const metadata = body?.metadata;
  if (!workspaceId || !intakeId.trim() || !sourceKey || sourceKey.length > 512 || !text || text.length > 20000 ||
      (metadata !== undefined && !plain(metadata))) {
    return NextResponse.json(
      { error: "workspaceId, intakeId, sourceKey, and non-empty text are required; sourceKey/text must be bounded" },
      { status: 400 },
    );
  }

  try {
    const result = await appendAcceptanceOutboundReply({
      workspaceId,
      intakeId: intakeId.trim(),
      sourceKey,
      text,
      metadata: plain(metadata) ? metadata : {},
    });
    if (!result) return NextResponse.json({ error: "Acceptance Intake not found" }, { status: 404 });
    if (!result.inserted && (result.message.direction !== "outbound" || result.message.text !== text)) {
      return NextResponse.json({ error: "sourceKey is already used by a different Intake message" }, { status: 409 });
    }
    return NextResponse.json({
      intake: { id: intakeId.trim() },
      message: { id: result.message.id, sourceKey: result.message.sourceKey, direction: result.message.direction },
      inserted: result.inserted,
    }, { status: result.inserted ? 201 : 200 });
  } catch (error) {
    console.error("[runner/acceptance-intake-messages] failed:", error);
    return NextResponse.json({ error: "Failed to record Acceptance Intake reply" }, { status: 502 });
  }
}
