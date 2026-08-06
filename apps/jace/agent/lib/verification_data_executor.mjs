import { runUploadVerificationApiArtifact } from "../subagents/qa/lib/upload_verification_api_artifact.core.mjs";
import { createVerificationDataExecutor } from "./verification_data_executor.core.mjs";

export function createVerificationDataExecuteFn({ env = process.env, fetchImpl = fetch, uploadArtifact } = {}) {
  const upload = uploadArtifact ?? ((input) => runUploadVerificationApiArtifact({
    ...input,
    env,
    transport: async (url, init) => {
      const response = await fetchImpl(url, init);
      return { status: response.status, json: () => response.json() };
    },
  }));
  return createVerificationDataExecutor({ fetchImpl, uploadArtifact: upload });
}
