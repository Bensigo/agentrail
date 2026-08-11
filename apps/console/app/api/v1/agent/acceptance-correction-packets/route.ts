import { NextRequest, NextResponse } from "next/server";
import { readCurrentAcceptanceCorrectionPackets } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 4 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function readBoundedJson(request: Request): Promise<unknown | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null
    && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) return null;
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BODY_BYTES) {
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

function recordIdFromBody(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || typeof body.recordId !== "string") return null;
  return UUID.test(body.recordId) ? body.recordId.toLowerCase() : null;
}

function json(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Read the immutable correction packet set for a Record's server-derived
 * current authoritative head. The bearer supplies workspace authority;
 * recordId is only a locator and no delivery/acknowledgement state is changed.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) return auth;
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    !== "application/json") return json(400, { error: "Invalid request" });

  const recordId = recordIdFromBody(await readBoundedJson(request));
  if (!recordId) return json(400, { error: "Invalid request" });

  try {
    const correctionPackets = await readCurrentAcceptanceCorrectionPackets({
      workspaceId: auth.workspaceId,
      recordId,
    });
    return json(200, { schemaVersion: 1, correctionPackets });
  } catch {
    return json(503, { error: "Correction packets unavailable" });
  }
}
