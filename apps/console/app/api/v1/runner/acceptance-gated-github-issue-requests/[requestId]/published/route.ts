import { NextRequest, NextResponse } from "next/server";
import { reportAcceptanceGatedGithubIssueApprovalPublication } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../lib/jace-console-auth";

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const GITHUB_REQUEST_ID_RE = /^[A-Za-z0-9:-]{1,128}$/u;

function exactReceipt(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return Object.keys(receipt).sort().join(",") === [
    "githubApiUrl", "githubIssueId", "githubIssueNumber", "githubIssueUrl",
    "githubRequestId", "httpStatus", "kind", "responseBodySha256",
    "responseTitleSha256", "state",
  ].join(",")
    && receipt["kind"] === "github_201" && receipt["httpStatus"] === 201
    && receipt["state"] === "open" && typeof receipt["githubIssueId"] === "string"
    && /^[1-9][0-9]{0,39}$/u.test(receipt["githubIssueId"])
    && Number.isSafeInteger(receipt["githubIssueNumber"])
    && (receipt["githubIssueNumber"] as number) > 0
    && typeof receipt["githubApiUrl"] === "string" && receipt["githubApiUrl"].length > 0
    && typeof receipt["githubIssueUrl"] === "string" && receipt["githubIssueUrl"].length > 0
    && typeof receipt["githubRequestId"] === "string"
    && GITHUB_REQUEST_ID_RE.test(receipt["githubRequestId"])
    && typeof receipt["responseTitleSha256"] === "string"
    && SHA256_RE.test(receipt["responseTitleSha256"])
    && typeof receipt["responseBodySha256"] === "string"
    && SHA256_RE.test(receipt["responseBodySha256"]);
}

function exactPublishedBody(value: unknown): value is {
  eveSessionId: string;
  approvalId: string;
  receipt: Parameters<typeof reportAcceptanceGatedGithubIssueApprovalPublication>[0]["receipt"];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  return keys.length === 3 && keys[0] === "approvalId" && keys[1] === "eveSessionId"
    && keys[2] === "receipt" && typeof body["eveSessionId"] === "string"
    && body["eveSessionId"].length > 0 && Buffer.byteLength(body["eveSessionId"], "utf8") <= 512
    && typeof body["approvalId"] === "string" && UUID_RE.test(body["approvalId"])
    && exactReceipt(body["receipt"]);
}

/** Attest the canonical GitHub 201 receipt to its exact request and approval. */
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
  if (!exactPublishedBody(body) || !UUID_RE.test(requestId)) {
    return NextResponse.json(
      { error: "eveSessionId, approvalId, and receipt must be the only request fields" },
      { status: 400 },
    );
  }
  try {
    const result = await reportAcceptanceGatedGithubIssueApprovalPublication({ ...body, requestId });
    switch (result.kind) {
      case "published":
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
    return NextResponse.json({ error: "Gated issue receipt unavailable" }, { status: 503 });
  }
}
