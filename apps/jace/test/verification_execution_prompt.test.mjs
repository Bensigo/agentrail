import test from "node:test";
import assert from "node:assert/strict";
import { verificationExecutionPrompt, VERIFICATION_EXECUTION_RESULT_SCHEMA } from "../agent/lib/verification_execution_prompt.mjs";
const item = { executionId: "e", workspaceId: "ws", recordId: "r", prRevisionId: "rev", verificationPlanId: "p", criterionId: "saved", modality: "ui", flow: "save a draft", uiSteps: [{ action: "open", path: "/drafts/new" }, { action: "click", selector: "[data-testid=save]" }, { action: "screenshot", label: "saved" }], expectedBehavior: "Saved", previewUrl: "https://safe" };
test("execution prompt binds QA to the exact persisted actions and forbids review actions", () => { const prompt = verificationExecutionPrompt(item); for (const value of ["https://safe", "verificationPlanId=p", "upload_verification_artifact", "Do not edit code", "ONLY this exact persisted uiSteps", "[data-testid=save]", "Do no blast-radius checks"]) assert.ok(prompt.includes(value)); assert.deepEqual(VERIFICATION_EXECUTION_RESULT_SCHEMA.properties.status.enum, ["proven", "not_proven", "not_testable"]); });
test("missing safe preview can only become not_testable", () => assert.ok(verificationExecutionPrompt({ ...item, previewUrl: null }).includes("status=not_testable")));
test("missing persisted actions can only become not_testable", () => assert.ok(verificationExecutionPrompt({ ...item, uiSteps: [] }).includes("status=not_testable")));
test("API prompt binds a read-only descriptor to the exact preview origin", () => {
  const prompt = verificationExecutionPrompt({ ...item, modality: "api", apiRequest: { method: "GET", path: "/api/audit", expectedStatus: 200 } });
  for (const value of ["GET /api/audit", "status 200", "upload_verification_api_artifact", "never send credentials", "https://safe"]) assert.ok(prompt.includes(value));
});
