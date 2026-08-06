import { runUploadVerificationApiArtifact } from "../subagents/qa/lib/upload_verification_api_artifact.core.mjs";
import { createVerificationApiExecutor } from "./verification_api_executor.core.mjs";

/** Build the production exact-plan API executor without a root-Jace/QA turn. */
export function createVerificationApiExecuteFn({ env = process.env, fetchImpl = fetch, uploadArtifact } = {}) {
  const upload = uploadArtifact ?? ((input) => runUploadVerificationApiArtifact({
    ...input,
    env,
    transport: async (url, init) => {
      const response = await fetchImpl(url, init);
      return { status: response.status, json: () => response.json() };
    },
  }));
  return createVerificationApiExecutor({ fetchImpl, uploadArtifact: upload });
}
