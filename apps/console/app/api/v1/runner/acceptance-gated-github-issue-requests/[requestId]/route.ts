import { NextRequest, NextResponse } from "next/server";
import { resolveAcceptanceGatedGithubIssueApprovalRequest } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

function exactSessionBody(value: unknown): value is { eveSessionId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1 && typeof body["eveSessionId"] === "string"
    && body["eveSessionId"].length > 0 && Buffer.byteLength(body["eveSessionId"], "utf8") <= 512;
}

/** Resolve an opaque request to its immutable, server-derived approval draft. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const requestId = (await params).requestId?.trim();
  if (!exactSessionBody(body) || !UUID_RE.test(requestId)) {
    return NextResponse.json(
      { error: "eveSessionId must be the only request field" },
      { status: 400 },
    );
  }
  try {
    const result = await resolveAcceptanceGatedGithubIssueApprovalRequest({
      eveSessionId: body.eveSessionId,
      requestId,
    });
    switch (result.kind) {
      case "ready":
        return NextResponse.json(result, { status: 200 });
      case "not_found":
        return NextResponse.json(result, { status: 404 });
      case "not_authorized":
        return NextResponse.json(result, { status: 403 });
      case "not_current":
      case "conflict":
        return NextResponse.json(result, { status: 409 });
      case "not_ready":
        return NextResponse.json(result, { status: 409 });
    }
  } catch {
    return NextResponse.json({ error: "Gated issue request unavailable" }, { status: 503 });
  }
}
