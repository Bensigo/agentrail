import { NextRequest, NextResponse } from "next/server";
import { acceptanceIntakeId, readAcceptanceIntake, readAcceptanceIntakeReadback } from "@agentrail/db-postgres";
import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";
import {
  boundedText,
  dispatchMcpAcceptanceTurn,
  MCP_TASK_CONTEXT_KEY_LIMIT,
  MCP_USER_MESSAGE_LIMIT,
  mcpConversationKey,
  mcpInboundSourceKey,
} from "@/lib/agent-mcp-intake";

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
  const taskContextKey = boundedText(body.taskContextKey, MCP_TASK_CONTEXT_KEY_LIMIT);
  const text = boundedText(body.userTask, MCP_USER_MESSAGE_LIMIT);
  if (!taskContextKey || !text) {
    return NextResponse.json({ error: "taskContextKey and userTask are required within their size limits" }, { status: 400 });
  }

  const conversationKey = mcpConversationKey(authorization.apiKeyId, taskContextKey);
  const intakeId = acceptanceIntakeId({ workspaceId, originChannel: "mcp", conversationKey });
  const sourceKey = mcpInboundSourceKey(authorization.apiKeyId, taskContextKey, "initial");
  const existing = await readAcceptanceIntake({ workspaceId, intakeId });
  const existingMessage = existing?.messages.find((message) => message.sourceKey === sourceKey);
  if (existingMessage) {
    if (existingMessage.direction === "inbound" && existingMessage.text === text) {
      return NextResponse.json({ intake: { id: intakeId }, sourceKey, duplicate: true, note: "The initial task-context message was already recorded; Jace was not invoked again." });
    }
    return NextResponse.json({ error: "Initial MCP task identity is already bound to a different Intake message" }, { status: 409 });
  }
  const turn = await dispatchMcpAcceptanceTurn({
    workspaceId, apiKeyId: authorization.apiKeyId, taskContextKey, text,
    sourceKey,
  });
  if (!turn.ok) return NextResponse.json({ error: "Jace did not accept the MCP task turn", detail: turn.reason }, { status: 502 });
  return NextResponse.json({
    intake: { id: intakeId },
    session: { id: turn.sessionId, continuationToken: turn.continuationToken },
    nextStep: "Jace may ask only unresolved questions. Read its bounded task-context messages; a user task-context reply is not independently authenticated human confirmation.",
  }, { status: 202 });
}

/** Read only bounded canonical Intake evidence for this credential's task context. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const authorization = await requireAgentMcpWorkspace(request, workspaceId, "acceptance:read");
  if (authorization instanceof NextResponse) return authorization;
  const taskContextKey = boundedText(request.nextUrl.searchParams.get("taskContextKey"), MCP_TASK_CONTEXT_KEY_LIMIT);
  if (!taskContextKey) return NextResponse.json({ error: "taskContextKey is required within its size limit" }, { status: 400 });
  const intakeId = acceptanceIntakeId({
    workspaceId, originChannel: "mcp", conversationKey: mcpConversationKey(authorization.apiKeyId, taskContextKey),
  });
  const intake = await readAcceptanceIntakeReadback({ workspaceId, intakeId });
  if (!intake) return NextResponse.json({ error: "MCP Acceptance Intake not found" }, { status: 404 });
  return NextResponse.json({ intake, note: "This is bounded task-context evidence, not a raw transcript or independent proof of human identity." });
}
