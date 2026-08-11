import { NextRequest, NextResponse } from "next/server";
import { reserveAcceptanceGatedGithubIssueApprovalRequest } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../lib/jace-console-auth";

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

function exactReserveBody(value: unknown): value is { eveSessionId: string; approvalId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  return keys.length === 2 && keys[0] === "approvalId" && keys[1] === "eveSessionId"
    && typeof body["eveSessionId"] === "string" && body["eveSessionId"].length > 0
    && Buffer.byteLength(body["eveSessionId"], "utf8") <= 512
    && typeof body["approvalId"] === "string" && UUID_RE.test(body["approvalId"]);
}

/** Reserve the one external write after the exact create_issue approval is approved. */
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
  if (!exactReserveBody(body) || !UUID_RE.test(requestId)) {
    return NextResponse.json(
      { error: "eveSessionId and approvalId must be the only request fields" },
      { status: 400 },
    );
  }
  try {
    const result = await reserveAcceptanceGatedGithubIssueApprovalRequest({ ...body, requestId });
    switch (result.kind) {
      case "reserved":
        return NextResponse.json(result, { status: 201 });
      case "already_reserved":
      case "published":
      case "manual_reconciliation":
      case "not_current":
      case "not_approved":
      case "conflict":
        return NextResponse.json(result, { status: 409 });
      case "not_found":
        return NextResponse.json(result, { status: 404 });
      case "not_authorized":
        return NextResponse.json(result, { status: 403 });
      case "not_ready":
        return NextResponse.json(result, { status: 409 });
    }
  } catch {
    return NextResponse.json({ error: "Gated issue reservation unavailable" }, { status: 503 });
  }
}
