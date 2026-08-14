import { createHash } from "node:crypto";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function mcpContinuationToken(credentialId, taskContextKey) {
  const identity = `mcp:${text(credentialId)}:${text(taskContextKey)}`;
  return `mcp:${createHash("sha256").update(identity).digest("hex")}`;
}

export function resolveMcpSessionIdentity(input) {
  const workspaceId = text(input?.target?.workspaceId);
  const taskContextKey = text(input?.target?.taskContextKey);
  const mcpCredentialId = text(input?.auth?.attributes?.mcpCredentialId);
  const mcpInboundSourceKey = text(input?.auth?.attributes?.mcpInboundSourceKey);
  if (!workspaceId) return { ok: false, reason: "missing_workspace_binding" };
  if (!taskContextKey) return { ok: false, reason: "missing_task_context_key" };
  if (!mcpCredentialId) return { ok: false, reason: "missing_mcp_credential" };
  if (!mcpInboundSourceKey) return { ok: false, reason: "missing_mcp_inbound_source" };
  return {
    ok: true,
    continuationToken: mcpContinuationToken(mcpCredentialId, taskContextKey),
    state: { workspaceId, taskContextKey, mcpCredentialId, mcpInboundSourceKey },
  };
}
