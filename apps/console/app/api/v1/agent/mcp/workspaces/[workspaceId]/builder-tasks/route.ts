import { NextRequest, NextResponse } from "next/server";
import { readAcceptanceBuilderTask } from "@agentrail/db-postgres";
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
  const task = await readAcceptanceBuilderTask({ workspaceId, builder, taskContextKey });
  if (!task) return NextResponse.json({ error: "Recorded builder task not found" }, { status: 404 });
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
    note: "This is the bounded, versioned handoff selected for this builder task. It is not proof of implementation or verification.",
  });
}
