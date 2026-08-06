import test from "node:test";
import assert from "node:assert/strict";

import { REQUIRED_BROWSER_TOOLS, createVerificationBrowserExecutor } from "../agent/lib/verification_browser_executor.core.mjs";

const item = {
  workspaceId: "workspace",
  previewUrl: "https://preview.example.test",
  execution: { id: "execution:1", verificationPlanId: "plan" },
  plan: {
    modality: "ui",
    recordId: "record",
    prRevisionId: "revision",
    expectedBehavior: "Saved confirmation appears",
    uiSteps: [
      { action: "open", path: "/settings" },
      { action: "click", selector: "[data-testid=save]" },
      { action: "fill", selector: "#name", value: "Jace" },
      { action: "press", key: "Enter" },
      { action: "expect_text", text: "Saved" },
      { action: "screenshot", label: "saved-state" },
    ],
  },
};

function clientFor({ tools = REQUIRED_BROWSER_TOOLS, currentUrl = "https://preview.example.test/settings", image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }, failures = {} } = {}) {
  const calls = [];
  return {
    calls,
    async connect() { if (failures.connect) throw new Error("offline"); },
    async listTools() { if (failures.list) throw new Error("bad list"); return { tools: tools.map((name) => ({ name })) }; },
    async callTool(input) {
      calls.push(input);
      if (failures[input.name]) return { isError: true, content: [] };
      if (input.name === "agent_browser_get_url") return { content: [{ type: "text", text: currentUrl }] };
      if (input.name === "agent_browser_screenshot") return { content: image ? [image] : [] };
      return { content: [{ type: "text", text: "ok" }] };
    },
    async close() { calls.push({ name: "close" }); },
  };
}

test("executes exactly persisted actions and uploads only the actual same-origin screenshot", async () => {
  const client = clientFor();
  const uploads = [];
  const execute = createVerificationBrowserExecutor({ createClient: async () => client, uploadArtifact: async (input) => { uploads.push(input); return { artifactId: "artifact-1" }; } });

  const result = await execute(item);
  assert.equal(result.status, "proven");
  assert.deepEqual(result.artifactIds, ["artifact-1"]);
  assert.deepEqual(client.calls.filter((call) => call.name !== "close"), [
    { name: "agent_browser_open", arguments: { url: "https://preview.example.test/settings", session: "jace-verification-execution-1" } },
    { name: "agent_browser_click", arguments: { selector: "[data-testid=save]", session: "jace-verification-execution-1" } },
    { name: "agent_browser_fill", arguments: { selector: "#name", text: "Jace", session: "jace-verification-execution-1" } },
    { name: "agent_browser_press", arguments: { key: "Enter", session: "jace-verification-execution-1" } },
    { name: "agent_browser_wait_for_text", arguments: { text: "Saved", session: "jace-verification-execution-1" } },
    { name: "agent_browser_get_url", arguments: { session: "jace-verification-execution-1" } },
    { name: "agent_browser_screenshot", arguments: { format: "png", session: "jace-verification-execution-1" } },
  ]);
  assert.deepEqual(uploads[0], {
    workspaceId: "workspace", recordId: "record", prRevisionId: "revision", verificationPlanId: "plan", collectedBy: "verification-executor:execution:1", index: 1,
    imageBase64: "aW1hZ2U=", contentType: "image/png", observedUrl: "https://preview.example.test/settings",
  });
});

test("unavailable or incomplete sidecar contracts are explicitly not_testable", async () => {
  const offline = createVerificationBrowserExecutor({ createClient: async () => clientFor({ failures: { connect: true } }), uploadArtifact: async () => ({ artifactId: "never" }) });
  assert.equal((await offline(item)).status, "not_testable");
  const missingTool = createVerificationBrowserExecutor({ createClient: async () => clientFor({ tools: REQUIRED_BROWSER_TOOLS.slice(1) }), uploadArtifact: async () => ({ artifactId: "never" }) });
  assert.equal((await missingTool(item)).status, "not_testable");
});

test("malformed steps, screenshot-only plans, and conflicting claim identities are not_testable", async () => {
  let created = 0;
  const execute = createVerificationBrowserExecutor({ createClient: async () => { created += 1; return clientFor(); }, uploadArtifact: async () => ({ artifactId: "never" }) });
  assert.equal((await execute({ ...item, plan: { ...item.plan, uiSteps: [{ action: "click", selector: "" }, { action: "expect_text", text: "Saved" }, { action: "screenshot", label: "saved" }] } })).status, "not_testable");
  assert.equal((await execute({ ...item, plan: { ...item.plan, uiSteps: [{ action: "open", path: "/settings" }, { action: "screenshot", label: "saved" }] } })).status, "not_testable");
  assert.equal((await execute({ ...item, recordId: "other-record" })).status, "not_testable");
  assert.equal(created, 0);
});

test("foreign opens and foreign current URLs cannot produce an artifact or a pass", async () => {
  let uploads = 0;
  const executeForeignOpen = createVerificationBrowserExecutor({ createClient: async () => clientFor(), uploadArtifact: async () => { uploads += 1; return { artifactId: "never" }; } });
  const foreignOpen = await executeForeignOpen({ ...item, plan: { ...item.plan, uiSteps: [{ action: "open", path: "//evil.example" }, { action: "expect_text", text: "Saved" }, { action: "screenshot", label: "x" }] } });
  assert.equal(foreignOpen.status, "not_proven");
  assert.equal(uploads, 0);

  const executeForeignCurrent = createVerificationBrowserExecutor({ createClient: async () => clientFor({ currentUrl: "https://evil.example/" }), uploadArtifact: async () => { uploads += 1; return { artifactId: "never" }; } });
  const foreignCurrent = await executeForeignCurrent(item);
  assert.equal(foreignCurrent.status, "not_proven");
  assert.equal(uploads, 0);
});

test("missing screenshot bytes, failed browser actions, and failed uploads cannot prove a UI criterion", async () => {
  const noImage = createVerificationBrowserExecutor({ createClient: async () => clientFor({ image: null }), uploadArtifact: async () => ({ artifactId: "never" }) });
  assert.equal((await noImage(item)).status, "not_proven");
  const failedAction = createVerificationBrowserExecutor({ createClient: async () => clientFor({ failures: { agent_browser_click: true } }), uploadArtifact: async () => ({ artifactId: "never" }) });
  assert.equal((await failedAction(item)).status, "not_proven");
  const uploadFailure = createVerificationBrowserExecutor({ createClient: async () => clientFor(), uploadArtifact: async () => ({ error: "unreachable" }) });
  assert.equal((await uploadFailure(item)).status, "not_proven");
});

test("a hung sidecar close cannot strand an otherwise proven criterion", async () => {
  const client = clientFor();
  client.close = async () => new Promise(() => {});
  const execute = createVerificationBrowserExecutor({
    createClient: async () => client,
    uploadArtifact: async () => ({ artifactId: "artifact-1" }),
    closeTimeoutMs: 5,
  });
  assert.equal((await execute(item)).status, "proven");
});
