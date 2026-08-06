/** Build the single bounded root-Jace task for one claimed Acceptance Record criterion. */
export function verificationExecutionPrompt(item) {
  const plan = item.plan ?? item;
  const executionId = item.execution?.id ?? item.executionId;
  const verificationPlanId = item.execution?.verificationPlanId ?? item.verificationPlanId;
  const { workspaceId } = item;
  const { recordId, prRevisionId, criterionId, flow, expectedBehavior, previewUrl = item.previewUrl, modality = "ui", apiRequest, uiSteps } = plan;
  if (!previewUrl) {
    return `Verification execution ${executionId} cannot run: no safe preview matched the exact PR head. Return ONLY status=not_testable with a concrete reason. Do not browse, edit code, post a review, or merge.`;
  }
  if (modality === "ui" && (!Array.isArray(uiSteps) || uiSteps.length === 0)) {
    return `Verification execution ${executionId} cannot run: the planned UI criterion has no persisted safe uiSteps action list. Return ONLY status=not_testable with a concrete reason. Do not browse, edit code, post a review, or merge.`;
  }
  const action = modality === "api"
    ? `Dispatch qa to fetch only GET ${apiRequest?.path} at this preview origin. It must confirm status ${apiRequest?.expectedStatus}, upload a redacted request/response/assertion card with upload_verification_api_artifact using workspaceId=${workspaceId}, recordId=${recordId}, prRevisionId=${prRevisionId}, verificationPlanId=${verificationPlanId}, and never send credentials or mutate data.`
    : `Dispatch qa to drive the browser using ONLY this exact persisted uiSteps action list: ${JSON.stringify(uiSteps)}. Do not infer, add, reorder, or substitute actions from the human-readable flow. Do no blast-radius checks, exploratory testing, or advisory review. Use upload_verification_artifact with workspaceId=${workspaceId}, recordId=${recordId}, prRevisionId=${prRevisionId}, verificationPlanId=${verificationPlanId}, and the browser's decisive observedUrl for the decisive screenshot.`;
  return [
    `Execute one Jace Acceptance Record verification, not a PR review: ${executionId}.`,
    `Open only this safe exact-head preview: ${previewUrl}.`,
    `Criterion ${criterionId}: expected ${expectedBehavior}. Human-readable flow (context only; not an executable instruction): ${flow}.`,
    action,
    `Return ONLY {status, observedBehavior, artifactIds, reason}. status is proven only when the stated flow was observed and artifactIds contains the uploaded artifact ID. Otherwise return not_proven or not_testable with a concrete reason. Do not edit code, post GitHub reviews, create issues, notify builders, or merge.`,
  ].join("\n");
}

export const VERIFICATION_EXECUTION_RESULT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["status", "observedBehavior", "artifactIds", "reason"],
  properties: {
    status: { type: "string", enum: ["proven", "not_proven", "not_testable"] },
    observedBehavior: { type: ["string", "null"] },
    artifactIds: { type: "array", items: { type: "string" } },
    reason: { type: ["string", "null"] },
  },
};
