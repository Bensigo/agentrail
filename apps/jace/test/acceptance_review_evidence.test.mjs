import test from "node:test";
import assert from "node:assert/strict";

import { fetchAcceptanceReviewEvidence } from "../agent/lib/acceptance_review_evidence.mjs";

const head = "a".repeat(40);
const item = { githubToken: "ghs-token", request: { headSha: head }, pr: { repositoryFullName: "ada/widgets", prNumber: 42 } };
const pull = { head: { sha: head }, base: { sha: "b".repeat(40) } };
const files = [{ filename: "src/save.ts", status: "modified", patch: "@@ -1 +1 @@\n+export const saved = true;" }];

test("reads only the claimed PR metadata and bounded file patches with the installation token", async () => {
  const calls = [];
  const result = await fetchAcceptanceReviewEvidence({
    item,
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { ok: true, status: 200, json: async () => calls.length === 1 ? pull : files };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.github.com/repos/ada/widgets/pulls/42");
  assert.match(calls[1].url, /files\?per_page=61$/);
  assert.equal(calls[0].headers.Authorization, "Bearer ghs-token");
});

test("fails closed when token, GitHub response, or exact PR head is unsafe", async () => {
  assert.match((await fetchAcceptanceReviewEvidence({ item: { ...item, githubToken: "" } })).reason, /No GitHub installation token/);
  const failed = await fetchAcceptanceReviewEvidence({ item, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: "forbidden" }) }) });
  assert.match(failed.reason, /GitHub 403/);
  let calls = 0;
  const foreign = await fetchAcceptanceReviewEvidence({ item, fetchImpl: async (_url, _init) => ({ ok: true, status: 200, json: async () => calls++ === 0 ? { ...pull, head: { sha: "c".repeat(40) } } : files }) });
  assert.match(foreign.reason, /does not match/);
});
