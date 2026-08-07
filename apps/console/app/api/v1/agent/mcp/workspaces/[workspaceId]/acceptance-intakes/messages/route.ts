import { NextRequest, NextResponse } from "next/server";
import { acceptanceIntakeId, readAcceptanceIntake } from "@agentrail/db-postgres";
import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";
import {
  boundedText,
  dispatchMcpAcceptanceTurn,
  MCP_MESSAGE_KEY_LIMIT,
  MCP_TASK_CONTEXT_KEY_LIMIT,
  MCP_USER_MESSAGE_LIMIT,
  mcpConversationKey,
  mcpInboundSourceKey,
} from "@/lib/agent-mcp-intake";

/**
 * Forward one explicit user task-context response into the canonical Jace
 * conversation. It cannot draft/confirm a contract directly.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const authorization = await requireAgentMcpWorkspace(request, workspaceId, "acceptance:intake:write");
  if (authorization instanceof NextResponse) return authorization;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const taskContextKey = boundedText(body.taskContextKey, MCP_TASK_CONTEXT_KEY_LIMIT);
  const text = boundedText(body.userMessage, MCP_USER_MESSAGE_LIMIT);
  const messageKey = boundedText(body.messageKey, MCP_MESSAGE_KEY_LIMIT);
  if (!taskContextKey || !text || !messageKey) {
    return NextResponse.json({ error: "taskContextKey, userMessage, and messageKey are required within their size limits" }, { status: 400 });
  }
  const conversationKey = mcpConversationKey(authorization.apiKeyId, taskContextKey);
  const intakeId = acceptanceIntakeId({ workspaceId, originChannel: "mcp", conversationKey });
  const sourceKey = mcpInboundSourceKey(authorization.apiKeyId, taskContextKey, `reply:${messageKey}`);
  const existing = await readAcceptanceIntake({ workspaceId, intakeId });
  const existingMessage = existing?.messages.find((message) => message.sourceKey === sourceKey);
  if (existingMessage) {
    if (existingMessage.direction === "inbound" && existingMessage.text === text) {
      return NextResponse.json({ intake: { id: intakeId }, sourceKey, duplicate: true, note: "The task-context message was already recorded; Jace was not invoked again." });
    }
    return NextResponse.json({ error: "messageKey is already bound to a different Intake message" }, { status: 409 });
  }
  const turn = await dispatchMcpAcceptanceTurn({ workspaceId, apiKeyId: authorization.apiKeyId, taskContextKey, text, sourceKey });
  if (!turn.ok) return NextResponse.json({ error: "Jace did not accept the MCP task-context reply", detail: turn.reason }, { status: 502 });
  return NextResponse.json({
    intake: { id: intakeId }, sourceKey, session: { id: turn.sessionId, continuationToken: turn.continuationToken },
    note: "Recorded as an MCP task-context user message. It is not independently authenticated human confirmation.",
  }, { status: 202 });
}
