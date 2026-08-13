import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const code = readFileSync(
  fileURLToPath(new URL("../agent/channels/mcp.ts", import.meta.url)),
  "utf8",
);

test("MCP channel has one virtual receive fingerprint and no public inbound route", () => {
  assert.equal((code.match(/POST\(\s*["']\/eve\/v1\/mcp-handoff["']/g) ?? []).length, 1);
  assert.match(code, /new Response\(null, \{ status: 404 \}\)/);
});

test("MCP channel derives session identity and makes reply custody blocking", () => {
  assert.match(code, /resolveMcpSessionIdentity\(input\)/);
  assert.match(code, /await recordMcpAcceptanceReply/);
  assert.match(code, /throw new Error\(`MCP reply custody failed/);
  assert.doesNotMatch(code, /create_issue|create_repo|merge|deploy|execFile|child_process/);
});
