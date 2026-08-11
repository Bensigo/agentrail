import { NextRequest, NextResponse } from "next/server";
import {
  reportAcceptanceGatedGithubIssueManualReconciliation,
  type AcceptanceGatedGithubIssueManualReconciliationReason,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../lib/jace-console-auth";

const REASONS = new Set<AcceptanceGatedGithubIssueManualReconciliationReason>([
  "external_write_indeterminate",
  "publication_receipt_failed",
  "external_issue_wrong_repo",
]);
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const GITHUB_ISSUE_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/issues\/[1-9][0-9]*$/u;

function exactReconciliationBody(value: unknown): value is {
  eveSessionId: string;
  approvalId: string;
  reason: AcceptanceGatedGithubIssueManualReconciliationReason;
  observedIssueUrl?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  const exactKeys = keys.join(",") === "approvalId,eveSessionId,reason"
    || keys.join(",") === "approvalId,eveSessionId,observedIssueUrl,reason";
  return exactKeys && typeof body["eveSessionId"] === "string" && body["eveSessionId"].length > 0
    && Buffer.byteLength(body["eveSessionId"], "utf8") <= 512
    && typeof body["approvalId"] === "string" && UUID_RE.test(body["approvalId"])
    && typeof body["reason"] === "string"
    && REASONS.has(body["reason"] as AcceptanceGatedGithubIssueManualReconciliationReason)
    && (body["observedIssueUrl"] === undefined
      || (typeof body["observedIssueUrl"] === "string"
        && GITHUB_ISSUE_URL_RE.test(body["observedIssueUrl"])));
}

/** Close a reserved write into durable manual reconciliation; it is never retryable. */
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
  if (!exactReconciliationBody(body) || !UUID_RE.test(requestId)) {
    return NextResponse.json({ error: "Invalid reconciliation body" }, { status: 400 });
  }
  try {
    const result = await reportAcceptanceGatedGithubIssueManualReconciliation({
      ...body,
      requestId,
    });
    switch (result.kind) {
      case "recorded":
        return NextResponse.json(result, { status: 201 });
      case "replayed":
        return NextResponse.json(result, { status: 200 });
      case "not_found":
        return NextResponse.json(result, { status: 404 });
      case "not_authorized":
        return NextResponse.json(result, { status: 403 });
      case "conflict":
        return NextResponse.json(result, { status: 409 });
    }
  } catch {
    return NextResponse.json({ error: "Gated issue reconciliation unavailable" }, { status: 503 });
  }
}
