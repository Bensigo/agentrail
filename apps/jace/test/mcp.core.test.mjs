import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mcpContinuationToken,
  resolveMcpSessionIdentity,
} from "../agent/lib/mcp.core.mjs";

test("MCP session identity is stable per credential and task and fails closed without either", () => {
  const resolved = resolveMcpSessionIdentity({
    target: { workspaceId: "workspace-1", taskContextKey: "codex-task-1" },
    auth: { attributes: { mcpCredentialId: "credential-1" } },
  });
  assert.deepEqual(resolved, {
    ok: true,
    continuationToken: mcpContinuationToken("credential-1", "codex-task-1"),
    state: {
      workspaceId: "workspace-1",
      taskContextKey: "codex-task-1",
      mcpCredentialId: "credential-1",
    },
  });
  assert.deepEqual(resolveMcpSessionIdentity({
    target: { workspaceId: "workspace-1", taskContextKey: "codex-task-1" },
    auth: { attributes: {} },
  }), { ok: false, reason: "missing_mcp_credential" });
});
