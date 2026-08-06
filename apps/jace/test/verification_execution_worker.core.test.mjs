import test from "node:test";
import assert from "node:assert/strict";
import { createVerificationExecutionWorker } from "../agent/lib/verification_execution_worker.core.mjs";
const item = { workerId: "worker", execution: { id: "execution", verificationPlanId: "plan" }, workspaceId: "ws", plan: { recordId: "record", prRevisionId: "revision", criterionId: "saved", modality: "ui", flow: "save", uiSteps: [{ action: "open", path: "/drafts/new" }, { action: "screenshot", label: "saved" }], expectedBehavior: "Saved" }, previewUrl: "https://safe" };
test("missing exact preview becomes not_testable without invoking QA", async () => { let executed = false; const completed = []; const worker = createVerificationExecutionWorker({ claim: async () => ({ ...item, previewUrl: null }), execute: async () => { executed = true; }, complete: async (x) => completed.push(x) }); assert.equal(await worker.tick(), "not_testable"); assert.equal(executed, false); assert.equal(completed[0].status, "not_testable"); });
test("a booting preview is not claimed for execution", async () => { let executed = false; let completed = false; const worker = createVerificationExecutionWorker({ claim: async () => null, execute: async () => { executed = true; }, complete: async () => { completed = true; } }); assert.equal(await worker.tick(), "idle"); assert.equal(executed, false); assert.equal(completed, false); });
test("only evidence-bound QA result can become proven", async () => { const completed = []; const worker = createVerificationExecutionWorker({ claim: async () => item, execute: async () => ({ status: "proven", observedBehavior: "Saved", artifactIds: ["artifact"], reason: null }), complete: async (x) => completed.push(x) }); assert.equal(await worker.tick(), "proven"); assert.equal(completed[0].status, "proven"); });
test("a claimed pass without artifact is downgraded", async () => { const completed = []; const worker = createVerificationExecutionWorker({ claim: async () => item, execute: async () => ({ status: "proven", observedBehavior: "Saved", artifactIds: [] }), complete: async (x) => completed.push(x) }); assert.equal(await worker.tick(), "not_proven"); assert.equal(completed[0].status, "not_proven"); });
test("a historical UI plan without persisted actions is terminalized without invoking QA", async () => {
  let executed = false;
  const completed = [];
  const worker = createVerificationExecutionWorker({
    claim: async () => ({ ...item, plan: { ...item.plan, uiSteps: null } }),
    execute: async () => { executed = true; },
    complete: async (input) => completed.push(input),
  });
  assert.equal(await worker.tick(), "not_testable");
  assert.equal(executed, false);
  assert.equal(completed[0].resultReason, "Planned UI criterion has no persisted safe uiSteps action list");
});
