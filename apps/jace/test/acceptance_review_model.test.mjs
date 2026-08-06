import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceReviewModelGenerate } from "../agent/lib/acceptance_review_model.mjs";
test("sends only bounded evaluator input to structured generation", async () => {
  const calls = [];
  const generate = createAcceptanceReviewModelGenerate({ model: "test-model", generateObjectFn: async (input) => { calls.push(input); return { object: { overallStatus: "not_proven", criteria: [], findings: [] } }; } });
  const result = await generate({ instruction: "blocking only", contract: { goal: "save" }, pr: { headSha: "a" }, diff: "diff -- x" });
  assert.equal(result.overallStatus, "not_proven"); assert.equal(calls[0].model, "test-model"); assert.equal(calls[0].temperature, 0); assert.match(calls[0].prompt, /Bounded exact-head diff/);
});
