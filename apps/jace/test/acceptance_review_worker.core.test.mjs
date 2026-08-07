import test from "node:test";
import assert from "node:assert/strict";

import { createAcceptanceReviewWorker } from "../agent/lib/acceptance_review_worker.core.mjs";

const item = {
  workerId: "review-worker-1",
  request: {
    id: "request-1", workspaceId: "workspace-1", recordId: "record-1", prRevisionId: "revision-1",
    acceptanceContractId: "contract-1", acceptanceContractVersion: 2, headSha: "a".repeat(40),
  },
};

test("forwards only the exact claimed identity to completion", async () => {
  const completed = [];
  const worker = createAcceptanceReviewWorker({
    claim: async () => item,
    review: async (claimed) => {
      assert.equal(claimed, item);
      return { overallStatus: "not_proven", verifierName: "bounded-reviewer", criteria: [] };
    },
    complete: async (input) => completed.push(input),
  });
  assert.equal(await worker.tick(), "not_proven");
  assert.deepEqual(completed[0], {
    overallStatus: "not_proven", verifierName: "bounded-reviewer", criteria: [],
    reviewRequestId: "request-1", workerId: "review-worker-1", workspaceId: "workspace-1", recordId: "record-1",
    prRevisionId: "revision-1", headSha: "a".repeat(40), contractId: "contract-1", contractVersion: 2,
  });
});

test("an evaluator failure does not fabricate a completion", async () => {
  const completed = [];
  const worker = createAcceptanceReviewWorker({
    claim: async () => item,
    review: async () => { throw new Error("GitHub evidence unavailable"); },
    complete: async (input) => completed.push(input),
  });
  assert.equal(await worker.tick(), "failed");
  assert.equal(completed.length, 0);
});

test("an empty claim is idle and an invalid claim cannot complete", async () => {
  let reviewed = false;
  let completed = false;
  const idle = createAcceptanceReviewWorker({ claim: async () => null, review: async () => { reviewed = true; }, complete: async () => { completed = true; } });
  assert.equal(await idle.tick(), "idle");
  assert.equal(reviewed, false);
  const invalid = createAcceptanceReviewWorker({ claim: async () => ({ request: { id: "request-1" } }), review: async () => { reviewed = true; }, complete: async () => { completed = true; } });
  assert.equal(await invalid.tick(), "failed");
  assert.equal(reviewed, false);
  assert.equal(completed, false);
});
