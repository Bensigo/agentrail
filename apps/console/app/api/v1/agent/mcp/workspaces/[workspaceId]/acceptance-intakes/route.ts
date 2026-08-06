import { NextRequest, NextResponse } from "next/server";
import { recordAcceptanceInboundIntake } from "@agentrail/db-postgres";
import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";

const MAX_TASK_CONTEXT_KEY_LENGTH = 256;
const MAX_USER_TASK_LENGTH = 8_000;

function requiredText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

/**
 * Agent-MCP starts canonical intake only. It deliberately cannot choose a
 * repository, origin channel, draft contract, or implementation action.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const authorization = await requireAgentMcpWorkspace(request, workspaceId, "acceptance:intake:write");
  if (authorization instanceof NextResponse) return authorization;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const taskContextKey = requiredText(body.taskContextKey, MAX_TASK_CONTEXT_KEY_LENGTH);
  const text = requiredText(body.userTask, MAX_USER_TASK_LENGTH);
  if (!taskContextKey || !text) {
    return NextResponse.json({ error: "taskContextKey and userTask are required within their size limits" }, { status: 400 });
  }

  const provenance = {
    kind: "agent_mcp_task",
    credentialId: authorization.apiKeyId,
    taskContextKey,
  };
  try {
    const result = await recordAcceptanceInboundIntake({
      workspaceId,
      originChannel: "mcp",
      conversationKey: `mcp:${authorization.apiKeyId}:${taskContextKey}`,
      sourceKey: `mcp-initial:${authorization.apiKeyId}:${taskContextKey}`,
      text,
      sourceReferences: [provenance],
      metadata: { ingress: "agent_mcp", credentialId: authorization.apiKeyId, taskContextKey },
    });
    return NextResponse.json({
      intake: { id: result.intake.id, status: result.intake.status },
      message: { id: result.message.id, sourceKey: result.message.sourceKey },
      inserted: result.inserted,
      nextStep: "Jace must collect unresolved information and obtain human confirmation before any Context Pack handoff or implementation.",
    }, { status: result.inserted ? 201 : 200 });
  } catch (error) {
    console.error("[agent/mcp/acceptance-intakes] failed:", error);
    return NextResponse.json({ error: "Failed to record Acceptance Intake" }, { status: 502 });
  }
}
