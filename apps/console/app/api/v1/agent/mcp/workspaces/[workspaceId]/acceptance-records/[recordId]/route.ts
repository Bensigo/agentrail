import { NextRequest, NextResponse } from "next/server";
import { readAcceptanceContracts, readChangeRecordTimeline } from "@agentrail/db-postgres";
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
