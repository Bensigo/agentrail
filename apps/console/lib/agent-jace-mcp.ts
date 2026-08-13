import { acceptanceIntakeId } from "@agentrail/db-postgres";

const DEFAULT_EVE_HOST = "http://127.0.0.1:2000";
const HOSTED_INBOUND_TIMEOUT_MS = 60_000;
export const MCP_TASK_CONTEXT_KEY_LIMIT = 256;
export const MCP_MESSAGE_KEY_LIMIT = 256;
export const MCP_MESSAGE_LIMIT = 8_000;

export function mcpConversationKey(credentialId: string, taskContextKey: string): string {
  return `mcp:${credentialId}:${taskContextKey}`;
}

export function mcpIntakeId(input: {
  workspaceId: string;
  credentialId: string;
  taskContextKey: string;
}): string {
  return acceptanceIntakeId({
    workspaceId: input.workspaceId,
    originChannel: "mcp",
    conversationKey: mcpConversationKey(input.credentialId, input.taskContextKey),
  });
}

export function mcpMessageSourceKey(
  credentialId: string,
  taskContextKey: string,
  messageKey: string,
): string {
  return `mcp-inbound:${credentialId}:${taskContextKey}:${messageKey}`;
}

export type DispatchMcpJaceTurnResult =
  | { ok: true; sessionId: string; continuationToken: string }
  | { ok: false; reason: string };

export async function dispatchMcpJaceTurn(input: {
  workspaceId: string;
  credentialId: string;
  taskContextKey: string;
  sourceKey: string;
  message: string;
  env?: Record<string, string | undefined>;
  transport?: typeof fetch;
}): Promise<DispatchMcpJaceTurnResult> {
  const env = input.env ?? process.env;
  const transport = input.transport ?? fetch;
  const url = (env.JACE_HOSTED_INBOUND_URL
    ?? `${env.EVE_HOST || DEFAULT_EVE_HOST}/eve/v1/hosted-inbound`).replace(/\/+$/, "");
  try {
    const response = await transport(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "mcp",
        message: input.message,
        sourceKey: input.sourceKey,
        target: {
          workspaceId: input.workspaceId,
          taskContextKey: input.taskContextKey,
        },
        auth: {
          authenticator: "agentrail",
          principalType: "agent_mcp",
          principalId: `agent-mcp:${input.credentialId}`,
          attributes: {
            workspaceId: input.workspaceId,
            channel: "mcp",
            conversationKey: mcpConversationKey(input.credentialId, input.taskContextKey),
            mcpCredentialId: input.credentialId,
          },
        },
      }),
      signal: AbortSignal.timeout(HOSTED_INBOUND_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: `hosted_inbound_${response.status}` };
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!payload || typeof payload.sessionId !== "string" || !payload.sessionId.trim()) {
      return { ok: false, reason: "hosted_inbound_invalid_response" };
    }
    return {
      ok: true,
      sessionId: payload.sessionId,
      continuationToken:
        typeof payload.continuationToken === "string" ? payload.continuationToken : "",
    };
  } catch {
    return { ok: false, reason: "hosted_inbound_unreachable" };
  }
}
