import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { runGithubDependencyBuilderDelivery } from "../../../../../../../../lib/github-dependency-builder-delivery";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 2_048;

function json(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function body(request: NextRequest): Promise<{ externalBuilderPackEventId: string } | null> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    void request.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  }
  if (size === 0) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === 1 && typeof record.externalBuilderPackEventId === "string"
      && UUID.test(record.externalBuilderPackEventId)
      ? { externalBuilderPackEventId: record.externalBuilderPackEventId.toLowerCase() } : null;
  } catch {
    return null;
  }
}

/** Owner/admin execution of one already-approved immutable Pack delivery. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; recordId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id || !UUID.test(session.user.id)) {
    void request.body?.cancel().catch(() => undefined);
    return json({ error: "Unauthorized" }, 401);
  }
  const { workspaceId, recordId } = await params;
  if (!UUID.test(workspaceId) || !UUID.test(recordId)) {
    void request.body?.cancel().catch(() => undefined);
    return json({ error: "Invalid dependency Builder delivery" }, 400);
  }
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    void request.body?.cancel().catch(() => undefined);
    return json({ error: "Forbidden" }, 403);
  }
  const parsed = await body(request);
  if (!parsed) return json({ error: "Invalid dependency Builder delivery" }, 400);
  const result = await runGithubDependencyBuilderDelivery({
    workspaceId,
    recordId,
    externalBuilderPackEventId: parsed.externalBuilderPackEventId,
    requestedBy: `user:${session.user.id}`,
  });
  if (result.kind === "carrier_accepted") return json(result, 201);
  if (result.kind === "terminal") return json(result, 200);
  if (result.kind === "not_found") return json(result, 404);
  if (result.kind === "not_authorized") return json(result, 403);
  if (result.kind === "invalid_input") return json(result, 400);
  if (result.kind === "not_current" || result.kind === "not_ready" || result.kind === "bounded_failed") return json(result, 409);
  return json(result, 503);
}
