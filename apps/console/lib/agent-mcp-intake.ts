const DEFAULT_EVE_HOST = "http://127.0.0.1:2000";

export const MCP_TASK_CONTEXT_KEY_LIMIT = 256;
export const MCP_USER_MESSAGE_LIMIT = 8_000;
export const MCP_MESSAGE_KEY_LIMIT = 256;

export function boundedText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

export function mcpConversationKey(apiKeyId: string, taskContextKey: string) {
  return `mcp:${apiKeyId}:${taskContextKey}`;
}

export function mcpInboundSourceKey(apiKeyId: string, taskContextKey: string, messageKey: string) {
  return `mcp-inbound:${apiKeyId}:${taskContextKey}:${messageKey}`;
}

export function mcpHostedInboundUrl(env: Record<string, string | undefined> = process.env) {
  return (env.JACE_HOSTED_INBOUND_URL || `${env.EVE_HOST || DEFAULT_EVE_HOST}/eve/v1/hosted-inbound`).replace(/\/+$/, "");
}

type DispatchMcpAcceptanceTurnInput = {
  workspaceId: string;
  apiKeyId: string;
  taskContextKey: string;
  text: string;
  sourceKey: string;
  env?: Record<string, string | undefined>;
  transport?: typeof fetch;
};

/**
 * Submit one provenance-bound MCP task turn to Jace's hosted channel door.
 * The caller never supplies workspace/channel/source identity to this wire.
 */
export async function dispatchMcpAcceptanceTurn({
  workspaceId, apiKeyId, taskContextKey, text, sourceKey, env, transport = fetch,
}: DispatchMcpAcceptanceTurnInput): Promise<{ ok: true; sessionId: string; continuationToken: string } | { ok: false; reason: string }> {
  let response: Response;
  try {
    response = await transport(mcpHostedInboundUrl(env), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "mcp",
        message: text,
        sourceKey,
        target: { workspaceId, taskContextKey },
        auth: {
          authenticator: "agentrail",
          principalType: "agent_mcp",
          principalId: `agent-mcp:${apiKeyId}`,
          attributes: {
            workspaceId,
            channel: "mcp",
            conversationKey: mcpConversationKey(apiKeyId, taskContextKey),
            mcpCredentialId: apiKeyId,
          },
        },
      }),
    });
  } catch (error) {
    return { ok: false, reason: `hosted-inbound unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response.ok) return { ok: false, reason: `hosted-inbound returned ${response.status}` };
  const body = await response.json().catch(() => null) as { sessionId?: unknown; continuationToken?: unknown } | null;
  if (!body || typeof body.sessionId !== "string" || !body.sessionId.trim()) {
    return { ok: false, reason: "hosted-inbound response missing sessionId" };
  }
  return {
    ok: true,
    sessionId: body.sessionId,
    continuationToken: typeof body.continuationToken === "string" ? body.continuationToken : "",
  };
}
