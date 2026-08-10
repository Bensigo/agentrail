import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_AGENT_BROWSER_MCP_URL,
  createReviewUiExecuteFn,
  resolveReviewBrowserUrl,
} from "../agent/lib/review_ui_executor.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.test/",
  JACE_CONSOLE_TOKEN: "secret",
  JACE_AGENT_BROWSER_MCP_URL: " https://browser.example.test/mcp ",
};

const input = {
  eveSessionId: "eve-1",
  jobId: "job-1",
  criterionId: "AC-UI",
  previewBootId: "boot-1",
};

const context = {
  ok: true,
  executionId: "execution-1",
  jobId: input.jobId,
  criterionId: input.criterionId,
  expected: "Saved state is visible.",
  previewBootId: input.previewBootId,
  previewUrl: "https://preview.example.test",
  uiSteps: [
    { action: "open", path: "/settings" },
    { action: "expect_text", text: "Saved" },
    { action: "screenshot", label: "saved" },
  ],
};

const receipt = {
  ok: true,
  state: "proven",
  expected: context.expected,
  observed: "Saved",
  evidenceRef: "review-ui-execution:execution-1",
  evidenceKey: "evidence/1.png",
  evidenceUrl: "https://evidence.example.test/1.png",
};

function response(status, body) {
  return { status, json: async () => body };
}

function browserClient(toolCalls = []) {
  return {
    async connect() {},
    async listTools() {
      return { tools: [
        "agent_browser_open", "agent_browser_click", "agent_browser_fill", "agent_browser_press",
        "agent_browser_wait_for_text", "agent_browser_get_url", "agent_browser_screenshot",
        "agent_browser_close",
      ].map((name) => ({ name })) };
    },
    async callTool({ name }) {
      toolCalls.push(name);
      if (name === "agent_browser_get_url") {
        return { content: [{ type: "text", text: "https://preview.example.test/settings" }] };
      }
      if (name === "agent_browser_screenshot") {
        return { content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] };
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
    async close() {},
  };
}

test("resolveReviewBrowserUrl uses a trimmed explicit URL or the fixed local default", () => {
  assert.equal(resolveReviewBrowserUrl(ENV), "https://browser.example.test/mcp");
  assert.equal(resolveReviewBrowserUrl({ JACE_AGENT_BROWSER_MCP_URL: "   " }), DEFAULT_AGENT_BROWSER_MCP_URL);
  assert.equal(resolveReviewBrowserUrl({}), DEFAULT_AGENT_BROWSER_MCP_URL);
});

test("production composition injects the resolved browser client and carries only server-owned UI receipt coordinates", async () => {
  const calls = [];
  const browserUrls = [];
  const browserCalls = [];
  const execute = createReviewUiExecuteFn({
    env: ENV,
    transport: async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1 ? response(201, context) : response(201, receipt);
    },
    createClient: ({ url }) => {
      browserUrls.push(url);
      return browserClient(browserCalls);
    },
  });

  assert.deepEqual(await execute(input), receipt);
  assert.deepEqual(browserUrls, ["https://browser.example.test/mcp"]);
  assert.equal(browserCalls.at(-1), "agent_browser_close");
  assert.ok(browserCalls.indexOf("agent_browser_close") > browserCalls.indexOf("agent_browser_screenshot"));
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    eveSessionId: "eve-1", criterionId: "AC-UI", previewBootId: "boot-1",
  });
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    eveSessionId: "eve-1",
    assertionPassed: true,
    observedUrl: "https://preview.example.test/settings",
    imageBase64: "aW1hZ2U=",
    contentType: "image/png",
  });
});

test("production composition degrades configuration and browser-side failures without inventing proof", async () => {
  let calls = 0;
  const unconfigured = createReviewUiExecuteFn({
    env: {},
    transport: async () => { calls += 1; return response(201, context); },
    createClient: () => browserClient(),
  });
  assert.deepEqual(await unconfigured(input), {
    ok: false,
    degraded: true,
    state: "not_testable",
    reason: "config_missing",
    note: "The Console UI-verification endpoint is not configured for this Jace deployment; no browser execution was attempted.",
  });
  assert.equal(calls, 0);

  const unavailable = createReviewUiExecuteFn({
    env: ENV,
    transport: async () => { calls += 1; return response(201, context); },
    createClient: () => { throw new Error("browser unavailable"); },
  });
  const result = await unavailable(input);
  assert.equal(result.ok, false);
  assert.equal(result.state, "not_testable");
  assert.equal(calls, 1);
});
