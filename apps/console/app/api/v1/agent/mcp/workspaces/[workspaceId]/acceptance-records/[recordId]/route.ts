import { NextRequest, NextResponse } from "next/server";
import { parseAcceptanceContract } from "@agentrail/contracts";
import { createDraftAcceptanceContract, readAcceptanceContracts, readChangeRecordTimeline } from "@agentrail/db-postgres";
import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; recordId: string }> }
) {
  const { workspaceId, recordId } = await params;
  const authorization = await requireAgentMcpWorkspace(request, workspaceId, "acceptance:read");
  if (authorization instanceof NextResponse) return authorization;
  const [timeline, contracts] = await Promise.all([
    readChangeRecordTimeline({ workspaceId, recordId }),
    readAcceptanceContracts({ workspaceId, recordId }),
  ]);
  if (!timeline || contracts == null) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    record: { id: timeline.record.id, repo: timeline.record.repo, state: timeline.record.state },
    contracts: contracts.map((contract) => ({
      id: contract.id, version: contract.version, status: contract.status,
      contract: contract.contract, confirmedAt: contract.confirmedAt?.toISOString() ?? null,
    })),
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; recordId: string }> }
) {
  const { workspaceId, recordId } = await params;
  const authorization = await requireAgentMcpWorkspace(request, workspaceId, "acceptance:draft:write");
  if (authorization instanceof NextResponse) return authorization;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.action !== "create_draft_version") {
    return NextResponse.json({ error: "action must be create_draft_version; MCP cannot confirm a contract" }, { status: 400 });
  }
  const contract = parseAcceptanceContract(body.contract);
  if (!contract.ok) return NextResponse.json({ errors: contract.errors }, { status: 400 });
  const existing = await readAcceptanceContracts({ workspaceId, recordId });
  if (existing == null) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.some((item) => item.status === "confirmed")) {
    return NextResponse.json({ error: "A confirmed Acceptance Contract is immutable" }, { status: 409 });
  }
  const draft = await createDraftAcceptanceContract({
    recordId, contract: contract.value, createdBy: `agent-mcp:${authorization.apiKeyId}`,
  });
  return NextResponse.json({ contract: {
    id: draft.id, recordId: draft.recordId, version: draft.version, status: draft.status, contract: draft.contract,
  } }, { status: 201 });
}
