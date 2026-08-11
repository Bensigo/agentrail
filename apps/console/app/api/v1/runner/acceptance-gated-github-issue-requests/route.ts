import { NextRequest, NextResponse } from "next/server";
import { mintAcceptanceGatedGithubIssueApprovalRequest } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

function exactMintBody(value: unknown): value is { eveSessionId: string; recordId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  return keys.length === 2 && keys[0] === "eveSessionId" && keys[1] === "recordId"
    && typeof body["eveSessionId"] === "string" && body["eveSessionId"].length > 0
    && Buffer.byteLength(body["eveSessionId"], "utf8") <= 512
    && typeof body["recordId"] === "string" && UUID_RE.test(body["recordId"]);
}

/** Mint one opaque, server-derived correction issue request for this Eve session. */
export async function POST(request: NextRequest) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!exactMintBody(body)) {
    return NextResponse.json(
      { error: "eveSessionId and recordId must be the only request fields" },
      { status: 400 },
    );
  }

  try {
    const result = await mintAcceptanceGatedGithubIssueApprovalRequest(body);
    switch (result.kind) {
      case "ready":
        return NextResponse.json({
          kind: "ready",
          request: { id: result.request.id, status: result.request.status },
        }, { status: result.request.status === "draft" ? 201 : 200 });
      case "not_found":
        return NextResponse.json({ kind: result.kind }, { status: 404 });
      case "not_authorized":
        return NextResponse.json({ kind: result.kind }, { status: 403 });
      case "not_current":
      case "conflict":
        return NextResponse.json({ kind: result.kind }, { status: 409 });
      case "not_ready":
        return NextResponse.json(result, { status: 409 });
    }
  } catch {
    return NextResponse.json({ error: "Gated issue request unavailable" }, { status: 503 });
  }
}
