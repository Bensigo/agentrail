import test from "node:test";
import assert from "node:assert/strict";
import { runUploadVerificationArtifact, VERIFICATION_ARTIFACT_PATH } from "../agent/subagents/qa/lib/upload_verification_artifact.core.mjs";
const env = { JACE_CONSOLE_BASE_URL: "https://console.example", JACE_CONSOLE_TOKEN: "token" };
const args = { workspaceId: "ws", recordId: "record", prRevisionId: "revision", verificationPlanId: "plan", collectedBy: "qa", index: 1, imageBase64: "aW1hZ2U=", contentType: "image/png" };
test("uploads only plan-bound coordinates", async () => { let seen; const result = await runUploadVerificationArtifact({ env, ...args, transport: async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return { status: 201, json: async () => ({ artifact: { id: "artifact", key: "key" }, url: "https://signed" }) }; } }); assert.equal(seen.url, `${env.JACE_CONSOLE_BASE_URL}${VERIFICATION_ARTIFACT_PATH}`); assert.equal(seen.body.verificationPlanId, "plan"); assert.deepEqual(result, { artifactId: "artifact", key: "key", url: "https://signed" }); });
test("fails closed without a plan identifier", async () => { const result = await runUploadVerificationArtifact({ env, ...args, verificationPlanId: "", transport: async () => { throw new Error("must not call"); } }); assert.ok("error" in result); });
