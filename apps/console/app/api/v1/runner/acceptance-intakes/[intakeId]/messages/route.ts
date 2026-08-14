import { NextRequest, NextResponse } from "next/server";
import { appendAcceptanceOutboundReply } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../lib/jace-console-auth";

const MAX_REPLY_BODY_BYTES = 32 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function mcpReplySourceKey(metadata: unknown): string | null {
  if (!object(metadata)) return null;
  const keys = Object.keys(metadata).sort();
  if (keys.length !== 3 || keys[0] !== "channel" || keys[1] !== "kind"
    || keys[2] !== "replyToSourceKey" || metadata.kind !== "jace_mcp_reply"
    || metadata.channel !== "mcp" || typeof metadata.replyToSourceKey !== "string") {
    return null;
  }
  const sourceKey = metadata.replyToSourceKey.trim();
  return sourceKey && sourceKey === metadata.replyToSourceKey && sourceKey.length <= 1024
    && !/[\u0000-\u001f\u007f]/u.test(sourceKey) ? sourceKey : null;
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown> | null> {
  const declared = request.headers.get("content-length");
  if ((declared !== null
      && (!/^\d+$/u.test(declared) || Number(declared) > MAX_REPLY_BODY_BYTES))
    || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_REPLY_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* already closed */ }
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
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return object(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ intakeId: string }> },
) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;
  const { intakeId } = await params;
  const body = await readBoundedJson(request);
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  const sourceKey = typeof body?.sourceKey === "string" ? body.sourceKey.trim() : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const replyToSourceKey = mcpReplySourceKey(body?.metadata);
  if (!workspaceId || !intakeId.trim() || !sourceKey || sourceKey.length > 512
    || !text || text.length > 20_000 || !replyToSourceKey) {
    return NextResponse.json({ error: "Invalid Acceptance Intake reply" }, { status: 400 });
  }
  try {
    const result = await appendAcceptanceOutboundReply({
      workspaceId,
      intakeId: intakeId.trim(),
      sourceKey,
      text,
      replyToSourceKey,
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
