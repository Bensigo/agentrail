import { NextRequest, NextResponse } from "next/server";
import { readAcceptanceBuilderTask, recordAcceptanceContextPackDelivery } from "@agentrail/db-postgres";
import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const authorization = await requireAgentMcpWorkspace(request, workspaceId, "acceptance:read");
  if (authorization instanceof NextResponse) return authorization;
  const builder = request.nextUrl.searchParams.get("builder")?.trim().toLowerCase() ?? "";
  const taskContextKey = request.nextUrl.searchParams.get("taskContextKey")?.trim() ?? "";
  if (!builder || !taskContextKey) {
    return NextResponse.json({ error: "builder and taskContextKey are required" }, { status: 400 });
  }
  const task = await readAcceptanceBuilderTask({
    workspaceId,
    builder,
    taskContextKey,
    agentMcpCredentialId: authorization.apiKeyId,
  });
  if (!task) return NextResponse.json({ error: "Recorded builder task not found" }, { status: 404 });
  // The response is the supported handoff carrier. Do not expose a Pack when
  // its delivery cannot be durably recorded. This proves only delivery to the
  // authenticated task context, never use of the Pack or implementation.
  let delivery;
  try {
    delivery = await recordAcceptanceContextPackDelivery({
      workspaceId,
      recordId: task.handoff.recordId,
      contextPackId: task.contextPack.id,
      deliveryKey: `mcp:${authorization.apiKeyId}:${task.handoff.id}`,
      method: "mcp",
      recipient: `${task.handoff.builder}:${task.handoff.taskContextKey}`,
      metadata: { handoffId: task.handoff.id, agentMcpCredentialId: authorization.apiKeyId },
      deliveredBy: `agent_mcp:${authorization.apiKeyId}`,
    });
  } catch {
    return NextResponse.json({ error: "Builder Context Pack delivery could not be recorded" }, { status: 503 });
  }
  return NextResponse.json({
    handoff: {
      id: task.handoff.id, recordId: task.handoff.recordId, builder: task.handoff.builder,
      taskContextKey: task.handoff.taskContextKey, branchName: task.handoff.branchName,
      status: task.handoff.status, createdAt: task.handoff.createdAt.toISOString(),
      prAttachedAt: task.handoff.prAttachedAt?.toISOString() ?? null,
    },
    record: task.record,
    confirmedContract: {
      ...task.contract,
      confirmedAt: task.contract.confirmedAt?.toISOString() ?? null,
    },
    contextPack: task.contextPack,
    repositoryRef: task.repositoryRef,
    delivery: {
      id: delivery.delivery.id,
      method: delivery.delivery.method,
      inserted: delivery.inserted,
      deliveredAt: delivery.delivery.deliveredAt.toISOString(),
    },
    note: "This is the bounded, versioned handoff selected for this authenticated builder task. Recorded delivery is not proof of implementation, use, or verification.",
  });
}
