import { NextRequest, NextResponse } from "next/server";
import { recordAcceptanceInboundIntake } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

const MAX_SOURCE_REFERENCES = 32;
const MAX_MESSAGE_LENGTH = 8_000;

function plainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Jace-only durable intake seam. It records bounded provenance before a
 * repository or contract has been selected; it never confirms or executes
 * work.
 */
export async function POST(request: NextRequest) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  const originChannel = typeof body?.originChannel === "string" ? body.originChannel.trim() : "";
  const conversationKey =
    typeof body?.conversationKey === "string" ? body.conversationKey.trim() : "";
  const sourceKey = typeof body?.sourceKey === "string" ? body.sourceKey.trim() : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const sourceReferences = body?.sourceReferences;
  if (
    !workspaceId ||
    !originChannel ||
    !conversationKey ||
    !sourceKey ||
    !text ||
    text.length > MAX_MESSAGE_LENGTH ||
    (sourceReferences !== undefined &&
      (!Array.isArray(sourceReferences) ||
        sourceReferences.length > MAX_SOURCE_REFERENCES ||
        !sourceReferences.every(plainObject)))
  ) {
    return NextResponse.json(
      {
        error:
          "workspaceId, originChannel, conversationKey, sourceKey, and bounded text are required; sourceReferences must contain at most 32 objects",
      },
      { status: 400 }
    );
  }

  try {
    const result = await recordAcceptanceInboundIntake({
      workspaceId,
      originChannel,
      conversationKey,
      sourceKey,
      text,
      sourceReferences: sourceReferences as Record<string, unknown>[] | undefined,
      metadata: plainObject(body?.metadata) ? body.metadata : {},
    });
    return NextResponse.json(
      {
        intake: { id: result.intake.id, status: result.intake.status },
        message: { id: result.message.id, sourceKey: result.message.sourceKey },
        inserted: result.inserted,
      },
      { status: result.inserted ? 201 : 200 }
    );
  } catch (error) {
    console.error("[runner/acceptance-intakes] failed:", error);
    return NextResponse.json({ error: "Failed to record Acceptance Intake" }, { status: 502 });
  }
}
