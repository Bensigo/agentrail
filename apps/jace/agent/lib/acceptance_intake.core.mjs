import { mcpConversationKey } from "./mcp.core.mjs";

export const ACCEPTANCE_INTAKE_PATH = "/api/v1/runner/acceptance-intakes";

export async function recordHostedAcceptanceIntake({ inbound, env = {}, transport }) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  const workspaceId = String(inbound?.auth?.attributes?.workspaceId ?? inbound?.target?.workspaceId ?? "").trim();
  if (!workspaceId) return { ok: true, skipped: "unbound_workspace" };
  if (!baseUrl || !token) return { ok: false, reason: "console_not_configured" };
  if (!inbound?.sourceKey) return { ok: false, reason: "missing_source_key" };
  const isMcp = inbound?.channel === "mcp";
  const mcpCredentialId = String(inbound?.auth?.attributes?.mcpCredentialId ?? "").trim();
  const taskContextKey = String(inbound?.target?.taskContextKey ?? "").trim();
  const conversationKey = String(
    isMcp
      ? mcpConversationKey(mcpCredentialId, taskContextKey)
      : inbound?.auth?.attributes?.conversationKey ?? inbound?.target?.conversationId ?? inbound?.target?.conversationKey ?? "",
  ).trim();
  if (isMcp) {
    if (!mcpCredentialId) return { ok: false, reason: "missing_mcp_credential" };
    if (!taskContextKey) return { ok: false, reason: "missing_task_context_key" };
  }
  if (!conversationKey) return { ok: false, reason: "missing_conversation_key" };
  const sourceReference = isMcp
    ? {
        kind: "agent_mcp_task",
        channel: inbound.channel,
        conversationKey,
        sourceKey: inbound.sourceKey,
        mcpCredentialId,
        taskContextKey,
      }
    : {
        kind: "hosted_channel_message",
        channel: inbound.channel,
        conversationKey,
        sourceKey: inbound.sourceKey,
      };
  const metadata = isMcp
    ? { target: inbound.target, mcpCredentialId, taskContextKey }
    : { target: inbound.target };
  const response = await transport(`${baseUrl}${ACCEPTANCE_INTAKE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      workspaceId,
      originChannel: inbound.channel,
      conversationKey,
      sourceKey: inbound.sourceKey,
      text: inbound.message,
      sourceReferences: [sourceReference],
      metadata,
    }),
  });
  if (response.status < 200 || response.status >= 300) return { ok: false, reason: `console_${response.status}` };
  const payload = typeof response.json === "function" ? await response.json().catch(() => null) : null;
  const intakeId = String(payload?.intake?.id ?? "").trim();
  return intakeId ? { ok: true, intakeId } : { ok: false, reason: "console_missing_intake_id" };
}
