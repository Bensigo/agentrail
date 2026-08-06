import { NextRequest, NextResponse } from "next/server";
import { readAcceptanceContracts, readAcceptanceContextPacks, recordAcceptanceContextPack } from "@agentrail/db-postgres";
import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";

const phases = new Set(["plan", "execute", "verify", "review"]);
const sha256 = /^sha256:[a-f0-9]{64}$/i;
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return value === null || typeof value === "string" ? value : undefined;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; recordId: string }> }
) {
  const { workspaceId, recordId } = await params;
  const authorization = await requireAgentMcpWorkspace(request, workspaceId, "acceptance:read");
  if (authorization instanceof NextResponse) return authorization;
  const packs = await readAcceptanceContextPacks({ workspaceId, recordId });
  if (packs == null) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ contextPacks: packs });
}

/**
 * Records only compiler metadata and artifact references. Raw repository
 * content stays local to the connected coding agent / context compiler.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; recordId: string }> }
) {
  const { workspaceId, recordId } = await params;
  const authorization = await requireAgentMcpWorkspace(request, workspaceId, "acceptance:context:write");
  if (authorization instanceof NextResponse) return authorization;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const phase = body.phase;
  const contentHash = body.contentHash;
  const compilerVersion = body.compilerVersion;
  const manifest = body.manifest;
  const custody = body.custody;
  const freshness = body.freshness;
  const jsonArtifactRef = optionalString(body.jsonArtifactRef);
  const markdownArtifactRef = optionalString(body.markdownArtifactRef);
  if (
    typeof phase !== "string" || !phases.has(phase) || typeof contentHash !== "string" || !sha256.test(contentHash) ||
    typeof compilerVersion !== "string" || !compilerVersion.trim() || !isPlainObject(manifest) ||
    !isPlainObject(custody) || !isPlainObject(freshness) || jsonArtifactRef === undefined || markdownArtifactRef === undefined
  ) {
    return NextResponse.json({ error: "invalid Context Pack metadata" }, { status: 400 });
  }
  const contracts = await readAcceptanceContracts({ workspaceId, recordId });
  if (contracts == null) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!contracts.some((contract) => contract.status === "confirmed")) {
    return NextResponse.json({ error: "A confirmed Acceptance Contract is required before building context" }, { status: 409 });
  }
  try {
    const result = await recordAcceptanceContextPack({
      workspaceId, recordId, phase: phase as "plan" | "execute" | "verify" | "review", contentHash,
      compilerVersion: compilerVersion.trim(), manifest, custody, freshness, jsonArtifactRef, markdownArtifactRef,
      createdBy: `agent-mcp:${authorization.apiKeyId}`,
    });
    return NextResponse.json({ contextPack: result.pack, inserted: result.inserted }, { status: result.inserted ? 201 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to record Acceptance Context Pack";
    return NextResponse.json({ error: message }, { status: message.includes("source content") ? 422 : 500 });
  }
}
