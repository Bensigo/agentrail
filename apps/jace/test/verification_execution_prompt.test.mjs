import test from "node:test";
import assert from "node:assert/strict";
import { verificationExecutionPrompt, VERIFICATION_EXECUTION_RESULT_SCHEMA } from "../agent/lib/verification_execution_prompt.mjs";
const item = { executionId: "e", workspaceId: "ws", recordId: "r", prRevisionId: "rev", verificationPlanId: "p", criterionId: "saved", flow: "save a draft", expectedBehavior: "Saved", previewUrl: "https://safe" };
test("execution prompt binds QA to the exact plan and forbids review actions", () => { const prompt = verificationExecutionPrompt(item); for (const value of ["https://safe", "verificationPlanId=p", "upload_verification_artifact", "Do not edit code"]) assert.ok(prompt.includes(value)); assert.deepEqual(VERIFICATION_EXECUTION_RESULT_SCHEMA.properties.status.enum, ["proven", "not_proven", "not_testable"]); });
test("missing safe preview can only become not_testable", () => assert.ok(verificationExecutionPrompt({ ...item, previewUrl: null }).includes("status=not_testable")));
