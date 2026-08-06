import test from "node:test";
import assert from "node:assert/strict";

import { MAX_REVIEW_DIFF_BYTES, MAX_REVIEW_FILES, buildAcceptanceReviewEvidence, evidenceRefsFitBoundedDiff } from "../agent/lib/acceptance_review_evidence.core.mjs";

const claim = { request: { headSha: "a".repeat(40) }, pr: { repositoryFullName: "ada/widgets", prNumber: 42 } };
const pull = { head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) } };
const files = [{ filename: "src/save.ts", status: "modified", patch: "@@ -1,2 +1,3 @@\n export function save() {\n+  return true;\n }" }];

test("binds a review evidence bundle to the exact claimed head and changed line ranges", () => {
  const result = buildAcceptanceReviewEvidence({ claim, pull, files });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.diffIdentity.headSha, claim.request.headSha);
  assert.equal(result.evidence.files[0].ranges[0].startLine, 1);
  assert.equal(evidenceRefsFitBoundedDiff([{ path: "src/save.ts", startLine: 2, endLine: 2, detail: "return", headSha: claim.request.headSha }], result.evidence), true);
  assert.equal(evidenceRefsFitBoundedDiff([{ path: "src/save.ts", startLine: 9, endLine: 9, detail: "outside", headSha: claim.request.headSha }], result.evidence), false);
});

test("fails closed for a foreign head, missing patch, too many files, or oversized diff", () => {
  assert.match(buildAcceptanceReviewEvidence({ claim, pull: { ...pull, head: { sha: "c".repeat(40) } }, files }).reason, /does not match/);
  assert.match(buildAcceptanceReviewEvidence({ claim, pull, files: [{ filename: "src/save.ts" }] }).reason, /no inspectable/);
  assert.match(buildAcceptanceReviewEvidence({ claim, pull, files: Array.from({ length: MAX_REVIEW_FILES + 1 }, (_, index) => ({ ...files[0], filename: `src/${index}.ts` })) }).reason, /file review budget/);
  assert.match(buildAcceptanceReviewEvidence({ claim, pull, files: [{ ...files[0], patch: `@@ -1 +1 @@\n+${"x".repeat(MAX_REVIEW_DIFF_BYTES + 1)}` }] }).reason, /diff budget/);
});
