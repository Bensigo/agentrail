import { NextRequest, NextResponse } from "next/server";
import { parseAcceptanceContract } from "@agentrail/contracts";
import { createDraftAcceptanceRecord, getRepositoryByName } from "@agentrail/db-postgres";
import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseSourceReferences(value: unknown): Record<string, unknown>[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32 || !value.every(isPlainObject)) return null;
  return value;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const authorization = await requireAgentMcpWorkspace(request, workspaceId, "acceptance:draft:write");
  if (authorization instanceof NextResponse) return authorization;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  const originChannel = typeof body.originChannel === "string" ? body.originChannel.trim() : "mcp";
  const workKey = typeof body.workKey === "string" ? body.workKey.trim() : undefined;
  const sourceReferences = parseSourceReferences(body.sourceReferences);
  const contract = parseAcceptanceContract(body.contract);
  if (!repo || sourceReferences == null || !contract.ok) {
    return NextResponse.json({
      error: "repo, a valid Acceptance Contract, and at most 32 object sourceReferences are required",
      ...(contract.ok ? {} : { errors: contract.errors }),
    }, { status: 400 });
  }
  if (!(await getRepositoryByName(workspaceId, repo))) {
    return NextResponse.json({ error: "Repository not found" }, { status: 404 });
  }

  const draft = await createDraftAcceptanceRecord({
    workspaceId, repo, originChannel, workKey, sourceReferences,
    contract: contract.value, createdBy: `agent-mcp:${authorization.apiKeyId}`,
  });
  return NextResponse.json({
    record: { id: draft.record.id, workspaceId: draft.record.workspaceId, repo: draft.record.repo, state: draft.record.state },
    contract: { id: draft.contract.id, version: draft.contract.version, status: draft.contract.status, contract: draft.contract.contract },
  }, { status: 201 });
}
