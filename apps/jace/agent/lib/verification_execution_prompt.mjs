/** Build the single bounded root-Jace task for one claimed Acceptance Record criterion. */
export function verificationExecutionPrompt(item) {
  const { executionId, workspaceId, recordId, prRevisionId, verificationPlanId, criterionId, flow, expectedBehavior, previewUrl } = item;
  if (!previewUrl) {
    return `Verification execution ${executionId} cannot run: no safe preview matched the exact PR head. Return ONLY status=not_testable with a concrete reason. Do not browse, edit code, post a review, or merge.`;
  }
  return [
    `Execute one Jace Acceptance Record verification, not a PR review: ${executionId}.`,
    `Open only this safe exact-head preview: ${previewUrl}.`,
    `Criterion ${criterionId}: expected ${expectedBehavior}. Execute this criterion-specific flow: ${flow}.`,
    `Dispatch qa to drive the browser. It must use upload_verification_artifact with workspaceId=${workspaceId}, recordId=${recordId}, prRevisionId=${prRevisionId}, verificationPlanId=${verificationPlanId} for the decisive screenshot.`,
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
