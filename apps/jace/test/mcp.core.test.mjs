import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpContinuationToken, mcpConversationKey, resolveMcpSessionIdentity } from "../agent/lib/mcp.core.mjs";

test("mcpConversationKey uses the canonical mcp:${credential}:${taskContextKey} shape", () => {
  assert.equal(mcpConversationKey("cred-1", "task-context-1"), "mcp:cred-1:task-context-1");
});

test("mcpContinuationToken is stable for the same credential/task-context pair and changes when either input changes", () => {
  const a = mcpContinuationToken("cred-1", "task-context-1");
  const b = mcpContinuationToken("cred-1", "task-context-1");
  const c = mcpContinuationToken("cred-2", "task-context-1");
  const d = mcpContinuationToken("cred-1", "task-context-2");

  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.match(a, /^mcp:[0-9a-f]{64}$/);
});

test("resolveMcpSessionIdentity binds the session to workspace, credential, and task context", () => {
  const input = {
    target: { workspaceId: "workspace-1", taskContextKey: "task-context-1" },
    auth: { attributes: { mcpCredentialId: "cred-1" } },
  };

  const resolved = resolveMcpSessionIdentity(input);
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.state, {
    workspaceId: "workspace-1",
    taskContextKey: "task-context-1",
    mcpCredentialId: "cred-1",
  });
  assert.equal(resolved.continuationToken, mcpContinuationToken("cred-1", "task-context-1"));
});

test("resolveMcpSessionIdentity fails closed when the trusted credential is missing", () => {
  assert.deepEqual(
    resolveMcpSessionIdentity({
      target: { workspaceId: "workspace-1", taskContextKey: "task-context-1" },
      auth: { attributes: {} },
    }),
    { ok: false, reason: "missing_mcp_credential" },
  );
});
