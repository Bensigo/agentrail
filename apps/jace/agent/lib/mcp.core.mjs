import { createHash } from "node:crypto";

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function mcpConversationKey(mcpCredentialId, taskContextKey) {
  const credential = readString(mcpCredentialId);
  const contextKey = readString(taskContextKey);
  return `mcp:${credential}:${contextKey}`;
}

export function mcpContinuationToken(mcpCredentialId, taskContextKey) {
  return `mcp:${createHash("sha256").update(mcpConversationKey(mcpCredentialId, taskContextKey)).digest("hex")}`;
}

export function resolveMcpSessionIdentity(input) {
  const workspaceId = readString(input?.target?.workspaceId);
  const taskContextKey = readString(input?.target?.taskContextKey);
  const mcpCredentialId = readString(input?.auth?.attributes?.mcpCredentialId);

  if (!workspaceId) return { ok: false, reason: "missing_workspace_binding" };
  if (!taskContextKey) return { ok: false, reason: "missing_task_context_key" };
  if (!mcpCredentialId) return { ok: false, reason: "missing_mcp_credential" };

  return {
    ok: true,
    workspaceId,
    taskContextKey,
    mcpCredentialId,
    continuationToken: mcpContinuationToken(mcpCredentialId, taskContextKey),
    state: { workspaceId, taskContextKey, mcpCredentialId },
  };
}
