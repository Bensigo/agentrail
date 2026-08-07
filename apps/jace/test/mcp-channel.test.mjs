// Structural wiring test for the virtual MCP channel.
//
// The real logic lives in mcp.core.test.mjs; this file only locks the channel
// module's shape so Eve sees one unique receive fingerprint and the channel
// stays reply-only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const channelTsPath = fileURLToPath(new URL("../agent/channels/mcp.ts", import.meta.url));
const code = readFileSync(channelTsPath, "utf8");

test("imports defineChannel/POST, the mcp session helper, and the canonical reply recorder", () => {
  assert.match(code, /import\s*\{\s*defineChannel,\s*POST\s*\}\s*from\s*["']eve\/channels["']/);
  assert.match(code, /import\s*\{\s*resolveMcpSessionIdentity\s*\}\s*from\s*["']\.\.\/lib\/mcp\.core\.mjs["']/);
  assert.match(code, /import\s*\{\s*recordDeliveredChannelReply\s*\}\s*from\s*["']\.\.\/lib\/acceptance_intake_reply\.core\.mjs["']/);
});

test("declares exactly one unique stub route and no bare root route", () => {
  const matches = code.match(/POST\(\s*["']\/eve\/v1\/mcp-handoff["']/g) ?? [];
  assert.equal(matches.length, 1);
  assert.doesNotMatch(code, /POST\(\s*["']\/["']/);
});

test("receive binds target.workspaceId, target.taskContextKey, and auth.attributes.mcpCredentialId into the continuation token", () => {
  assert.match(code, /resolveMcpSessionIdentity\(input\)/);
  assert.match(code, /continuationToken:\s*identity\.continuationToken/);
  assert.match(code, /state:\s*identity\.state/);
});

test("message.completed records the delivered reply only through recordDeliveredChannelReply", () => {
  const messageCompleted = code.slice(code.indexOf('async "message.completed"'));
  assert.match(messageCompleted, /recordDeliveredChannelReply/);
  assert.doesNotMatch(messageCompleted, /postConsoleChatReply|deliverDiscordReply|channel\.(telegram|discord|slack|imessage)\.post/);
  assert.doesNotMatch(messageCompleted, /draftAcceptanceContractFromBoundIntake|confirmAcceptanceContractFromBoundIntake|createIssue|createRepo/);
});
