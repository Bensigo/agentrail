import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceReviewEvaluator } from "../agent/lib/acceptance_review_evaluator.core.mjs";
const head = "a".repeat(40);
const item = { request: { headSha: head }, pr: { repositoryFullName: "ada/widgets", prNumber: 42 }, contract: { contract: { acceptanceCriteria: [{ id: "saved", text: "Save persists", required: true }] } } };
const evidence = { headSha: head, diffText: "x", diffIdentity: { headSha: head }, files: [{ path: "src/save.ts", ranges: [{ startLine: 2, endLine: 2 }] }] };
const ref = { path: "src/save.ts", startLine: 2, endLine: 2, detail: "return", headSha: head };
test("returns honest not_proven when exact evidence is unavailable", async () => {
  const evaluate = createAcceptanceReviewEvaluator({ fetchEvidence: async () => ({ ok: false, reason: "token missing" }), generate: async () => { throw new Error("must not run"); } });
  const result = await evaluate(item); assert.equal(result.overallStatus, "not_proven"); assert.equal(result.criteria[0].status, "not_proven");
});
test("rejects model citations outside the bounded diff", async () => {
  const evaluate = createAcceptanceReviewEvaluator({ fetchEvidence: async () => ({ ok: true, evidence }), generate: async () => ({ criteria: [{ criterionId: "saved", status: "failed", observedBehavior: "x", expectedBehavior: "y", reason: "x", evidenceRefs: [{ ...ref, startLine: 9, endLine: 9 }] }], findings: [] }) });
  await assert.rejects(() => evaluate(item), /outside/);
});
test("preserves only bounded evidence output for completion", async () => {
  const evaluate = createAcceptanceReviewEvaluator({ fetchEvidence: async () => ({ ok: true, evidence }), generate: async () => ({ overallStatus: "failed", criteria: [{ criterionId: "saved", status: "failed", observedBehavior: "x", expectedBehavior: "y", reason: "x", evidenceRefs: [ref] }], findings: [{ basis: "acceptance_contract", criterionId: "saved", ruleOrBoundary: "AC", concreteImpact: "lost", requiredCorrection: "fix", reverification: "run", evidenceRefs: [ref] }] }) });
  const result = await evaluate(item); assert.equal(result.diffIdentity.headSha, head); assert.equal(result.findings.length, 1);
});
