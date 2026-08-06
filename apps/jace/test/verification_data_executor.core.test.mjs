import test from "node:test";
import assert from "node:assert/strict";
import { createVerificationDataExecutor } from "../agent/lib/verification_data_executor.core.mjs";

const item = { workspaceId: "workspace", previewUrl: "https://preview.test/pr/1", execution: { id: "execution", verificationPlanId: "plan" }, plan: { modality: "data", recordId: "record", prRevisionId: "revision", criterionId: "flag", expectedBehavior: "Flag is enabled", dataRequest: { method: "GET", path: "/api/flags", expectedStatus: 200, expectedJson: [{ pointer: "/enabled", equals: true }] } } };

test("proves only a planned same-origin data readback with declared JSON equality", async () => {
  let upload;
  const execute = createVerificationDataExecutor({ fetchImpl: async () => ({ status: 200, redirected: false, json: async () => ({ enabled: true, ignored: "secret" }) }), uploadArtifact: async (input) => { upload = input; return { artifactId: "artifact" }; } });
  const result = await execute(item);
  assert.equal(result.status, "proven");
  assert.deepEqual(result.artifactIds, ["artifact"]);
  assert.deepEqual(upload.evidence.assertions, ["JSON /enabled equals declared scalar"]);
});

test("fails closed for a bad assertion or unsafe path", async () => {
  const execute = createVerificationDataExecutor({ fetchImpl: async () => ({ status: 200, redirected: false, json: async () => ({ enabled: false }) }), uploadArtifact: async () => ({ artifactId: "never" }) });
  assert.equal((await execute(item)).status, "not_proven");
  assert.equal((await execute({ ...item, plan: { ...item.plan, dataRequest: { ...item.plan.dataRequest, path: "//outside.test" } } })).status, "not_testable");
});
