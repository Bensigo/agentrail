import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { after, test } from "node:test";

type Request = { method?: string; url?: string; body: string };

const apiRequests: Request[] = [];
const api = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    apiRequests.push({ method: request.method, url: request.url, body });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
});

await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
after(async () => {
  await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
});

function waitForRequests(count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out waiting for ${count} Jace API request(s).`));
    }, 5_000);
    const interval = setInterval(() => {
      if (apiRequests.length >= count) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve();
      }
    }, 10);
  });
}

test("MCP intake, builder handoff, and correction delivery tools use bounded task identity", async () => {
  apiRequests.length = 0;
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  const child = spawn("node", [new URL("./index.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      JACE_API_URL: `http://127.0.0.1:${address.port}`,
      JACE_MCP_TOKEN: "test-token",
      JACE_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111",
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`);

  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcp-test", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "acceptance_intake_start", arguments: { taskContextKey: "task / a&b", userTask: "Add a save button" } } });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "acceptance_builder_task_get", arguments: { builder: "codex", taskContextKey: "task / a&b" } } });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "correction_deliveries_get", arguments: { builder: "codex", taskContextKey: "task / a&b" } } });
    send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "correction_delivery_acknowledge", arguments: { deliveryId: "22222222-2222-4222-8222-222222222222", detail: "Packet read" } } });
    await waitForRequests(4);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  }

  const requests = apiRequests.map(({ method, url }) => ({ method, url })).sort((a, b) => `${a.method}:${a.url}`.localeCompare(`${b.method}:${b.url}`));
  assert.deepEqual(requests, [
    { method: "POST", url: "/api/v1/agent/mcp/workspaces/11111111-1111-4111-8111-111111111111/acceptance-intakes" },
    { method: "GET", url: "/api/v1/agent/mcp/workspaces/11111111-1111-4111-8111-111111111111/builder-tasks?builder=codex&taskContextKey=task+%2F+a%26b" },
    { method: "GET", url: "/api/v1/agent/mcp/workspaces/11111111-1111-4111-8111-111111111111/correction-deliveries?builder=codex&taskContextKey=task+%2F+a%26b" },
    { method: "POST", url: "/api/v1/agent/mcp/workspaces/11111111-1111-4111-8111-111111111111/correction-deliveries/22222222-2222-4222-8222-222222222222/ack" },
  ].sort((a, b) => `${a.method}:${a.url}`.localeCompare(`${b.method}:${b.url}`)));
  assert.equal(apiRequests.find((request) => request.url?.endsWith("/acceptance-intakes"))?.body, JSON.stringify({ taskContextKey: "task / a&b", userTask: "Add a save button" }));
  assert.equal(apiRequests.find((request) => request.url?.endsWith("/ack"))?.body, JSON.stringify({ detail: "Packet read" }));
});
