import test from "node:test";
import assert from "node:assert/strict";

import {
  REQUIRED_BROWSER_TOOLS,
  createReviewUiExecutor,
} from "../agent/lib/review_ui_executor.core.mjs";

const context = {
  executionId: "execution-1",
  jobId: "job-1",
  criterionId: "criterion-1",
  expected: "The saved name is visible.",
  previewBootId: "boot-1",
  previewUrl: "https://preview.example.test",
  uiSteps: [
    { action: "open", path: "/settings" },
    { action: "click", selector: "[data-testid=save]" },
    { action: "fill", selector: "#name", value: "Jace" },
    { action: "press", key: "Enter" },
    { action: "expect_text", text: "Saved" },
    { action: "screenshot", label: "saved-state" },
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

function clientFor({ tools = REQUIRED_BROWSER_TOOLS, currentUrl = "https://preview.example.test/settings", currentUrls = [], image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }, screenshotText = null, errors = {}, throwFor = null, hangFor = null, close = async () => {} } = {}) {
  const calls = [];
  return {
    calls,
    async connect() { calls.push("connect"); },
    async listTools() { calls.push("listTools"); return { tools: tools.map((name) => ({ name })) }; },
    async callTool(input) {
      calls.push(input);
      if (throwFor === input.name) throw new Error("transport failure");
      if (hangFor === input.name) return new Promise(() => {});
      if (errors[input.name]) return { isError: true, content: [] };
      if (input.name === "agent_browser_get_url") return { content: [{ type: "text", text: currentUrls.shift() ?? currentUrl }] };
      if (input.name === "agent_browser_screenshot") return {
        content: [
          ...(screenshotText ? [{ type: "text", text: screenshotText }] : []),
          ...(image ? [image] : []),
        ],
      };
      return { content: [{ type: "text", text: "ok" }] };
    },
    async close() { calls.push("transport-close"); return close(); },
  };
}

test("replays only persisted actions in order and returns the attested server receipt", async () => {
  const client = clientFor();
  const completions = [];
  const execute = createReviewUiExecutor({
    createClient: async ({ session }) => { assert.equal(session, "review-1"); return client; },
    makeSessionId: () => "review-1",
    completeExecution: async (input) => { completions.push(input); return receipt; },
  });

  assert.equal(await execute(context), receipt);
  assert.deepEqual(client.calls, [
    "connect",
    "listTools",
    { name: "agent_browser_open", arguments: { url: "https://preview.example.test/settings", session: "review-1" } },
    { name: "agent_browser_get_url", arguments: { session: "review-1" } },
    { name: "agent_browser_click", arguments: { selector: "[data-testid=save]", session: "review-1" } },
    { name: "agent_browser_get_url", arguments: { session: "review-1" } },
    { name: "agent_browser_fill", arguments: { selector: "#name", text: "Jace", session: "review-1" } },
    { name: "agent_browser_get_url", arguments: { session: "review-1" } },
    { name: "agent_browser_press", arguments: { key: "Enter", session: "review-1" } },
    { name: "agent_browser_get_url", arguments: { session: "review-1" } },
    { name: "agent_browser_wait_for_text", arguments: { text: "Saved", session: "review-1" } },
    { name: "agent_browser_get_url", arguments: { session: "review-1" } },
    { name: "agent_browser_screenshot", arguments: { format: "png", session: "review-1" } },
    { name: "agent_browser_close", arguments: { session: "review-1" } },
    "transport-close",
  ]);
  assert.deepEqual(completions, [{
    executionId: "execution-1", jobId: "job-1", criterionId: "criterion-1", previewBootId: "boot-1",
    assertionPassed: true, observedUrl: "https://preview.example.test/settings", imageBase64: "aW1hZ2U=", contentType: "image/png",
  }]);
});

test("an assertion tool error still captures decisive evidence and accepts only a failed receipt", async () => {
  const client = clientFor({ errors: { agent_browser_wait_for_text: true } });
  const completions = [];
  const failed = { ...receipt, state: "failed", observed: "Saved text was absent" };
  const execute = createReviewUiExecutor({ createClient: async () => client, completeExecution: async (input) => { completions.push(input); return failed; } });

  assert.equal(await execute(context), failed);
  assert.equal(completions[0].assertionPassed, false);
  assert.deepEqual(
    client.calls.filter((call) => typeof call === "object").slice(-3).map((call) => call.name),
    ["agent_browser_get_url", "agent_browser_screenshot", "agent_browser_close"],
  );
});

test("foreign preview and current origins cannot produce a receipt", async () => {
  let completions = 0;
  const foreignPreview = createReviewUiExecutor({ createClient: async () => clientFor(), completeExecution: async () => { completions += 1; return receipt; } });
  assert.equal((await foreignPreview({ ...context, previewUrl: "https://user:secret@preview.example.test" })).state, "not_testable");

  const foreignCurrent = createReviewUiExecutor({ createClient: async () => clientFor({ currentUrl: "https://evil.example.test/" }), completeExecution: async () => { completions += 1; return receipt; } });
  assert.equal((await foreignCurrent(context)).state, "not_proven");
  assert.equal(completions, 0);
});

test("a redirected open or click is detected before any later browser action", async () => {
  const redirectedOpen = clientFor({ currentUrls: ["https://evil.example.test/"] });
  const executeOpen = createReviewUiExecutor({
    createClient: async () => redirectedOpen,
    completeExecution: async () => receipt,
  });
  assert.equal((await executeOpen(context)).state, "not_proven");
  assert.deepEqual(
    redirectedOpen.calls.filter((call) => typeof call === "object").map((call) => call.name),
    ["agent_browser_open", "agent_browser_get_url", "agent_browser_close"],
  );

  const redirectedClick = clientFor({
    currentUrls: [
      "https://preview.example.test/settings",
      "http://169.254.169.254/latest/meta-data/",
    ],
  });
  const executeClick = createReviewUiExecutor({
    createClient: async () => redirectedClick,
    completeExecution: async () => receipt,
  });
  assert.equal((await executeClick(context)).state, "not_proven");
  assert.deepEqual(
    redirectedClick.calls.filter((call) => typeof call === "object").map((call) => call.name),
    [
      "agent_browser_open",
      "agent_browser_get_url",
      "agent_browser_click",
      "agent_browser_get_url",
      "agent_browser_close",
    ],
  );
});

test("unsafe or non-closed steps never open a browser or complete", async () => {
  let created = 0;
  let completed = 0;
  const execute = createReviewUiExecutor({
    createClient: async () => { created += 1; return clientFor(); },
    completeExecution: async () => { completed += 1; return receipt; },
  });
  assert.equal((await execute({ ...context, uiSteps: [{ action: "open", path: "//evil.example.test" }, { action: "expect_text", text: "Saved" }, { action: "screenshot", label: "x" }] })).state, "not_testable");
  assert.equal((await execute({ ...context, uiSteps: [{ action: "open", path: "/settings" }, { action: "expect_text", text: "Saved", extra: "no" }, { action: "screenshot", label: "x" }] })).state, "not_testable");
  assert.equal((await execute({ ...context, extra: "no" })).state, "not_testable");
  assert.equal(created, 0);
  assert.equal(completed, 0);
});

test("replays the plan DSL's empty fill allowance and bounded press keys", async () => {
  const client = clientFor();
  const execute = createReviewUiExecutor({ createClient: async () => client, completeExecution: async () => receipt });
  assert.equal(await execute({
    ...context,
    uiSteps: [
      { action: "open", path: "/settings" },
      { action: "fill", selector: "#name", value: "" },
      { action: "press", key: "Escape" },
      { action: "expect_text", text: "Saved" },
      { action: "screenshot", label: "saved-state" },
    ],
  }), receipt);
  assert.equal((await execute({
    ...context,
    uiSteps: [
      { action: "open", path: "/settings" },
      { action: "press", key: "a" },
      { action: "expect_text", text: "Saved" },
      { action: "screenshot", label: "saved-state" },
    ],
  })).state, "not_testable");
});

test("missing sidecar tools or an unavailable sidecar are not_testable", async () => {
  const missing = createReviewUiExecutor({ createClient: async () => clientFor({ tools: REQUIRED_BROWSER_TOOLS.slice(1) }), completeExecution: async () => receipt });
  assert.equal((await missing(context)).state, "not_testable");
  const unavailable = createReviewUiExecutor({ createClient: async () => { throw new Error("offline"); }, completeExecution: async () => receipt });
  assert.equal((await unavailable(context)).state, "not_testable");
});

test("a failed non-assertion action or transport failure never completes", async () => {
  let completed = 0;
  const failedAction = createReviewUiExecutor({ createClient: async () => clientFor({ errors: { agent_browser_click: true } }), completeExecution: async () => { completed += 1; return receipt; } });
  assert.equal((await failedAction(context)).state, "not_proven");
  const thrownAction = createReviewUiExecutor({ createClient: async () => clientFor({ throwFor: "agent_browser_click" }), completeExecution: async () => { completed += 1; return receipt; } });
  assert.equal((await thrownAction(context)).state, "not_proven");
  assert.equal(completed, 0);
});

test("malformed screenshot evidence never completes", async () => {
  let completed = 0;
  const execute = createReviewUiExecutor({
    createClient: async () => clientFor({ image: { type: "image", data: "not base64", mimeType: "image/png" } }),
    completeExecution: async () => { completed += 1; return receipt; },
  });
  assert.equal((await execute(context)).state, "not_proven");
  assert.equal(completed, 0);
});

test("accepts agent-browser's real screenshot shape: one text path plus one image", async () => {
  const client = clientFor({ screenshotText: "/tmp/screenshots/exact.png" });
  const execute = createReviewUiExecutor({
    createClient: async () => client,
    completeExecution: async () => receipt,
  });
  assert.equal(await execute(context), receipt);
});

test("failed or malformed completion receipts degrade without returning invented proof", async () => {
  const rejected = createReviewUiExecutor({ createClient: async () => clientFor(), completeExecution: async () => { throw new Error("reject"); } });
  assert.equal((await rejected(context)).state, "not_proven");
  const malformed = createReviewUiExecutor({ createClient: async () => clientFor(), completeExecution: async () => ({ ok: true, state: "not_proven" }) });
  assert.equal((await malformed(context)).state, "not_proven");
  const forged = createReviewUiExecutor({
    createClient: async () => clientFor(),
    completeExecution: async () => ({ ...receipt, expected: "A different criterion" }),
  });
  assert.equal((await forged(context)).state, "not_proven");
});

test("a hung browser-session close is bounded and transport close still runs", async () => {
  const client = clientFor({ hangFor: "agent_browser_close" });
  const execute = createReviewUiExecutor({
    createClient: async () => client,
    completeExecution: async () => receipt,
    closeTimeoutMs: 5,
  });
  assert.equal(await execute(context), receipt);
  assert.equal(client.calls.at(-1), "transport-close");
});
