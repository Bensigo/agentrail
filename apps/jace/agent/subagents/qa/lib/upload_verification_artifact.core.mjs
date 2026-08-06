import { classifyStatus, failure, resolveConsoleConfig } from "./upload_evidence_image.core.mjs";

export const VERIFICATION_ARTIFACT_PATH = "/api/v1/runner/evidence-verification-artifacts";

/** Upload a browser capture only through the Acceptance Record plan-bound artifact seam. */
export async function runUploadVerificationArtifact({ env = {}, workspaceId, recordId, prRevisionId, verificationPlanId, collectedBy, index, imageBase64, contentType, transport }) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return failure("config_missing");
  const values = [workspaceId, recordId, prRevisionId, verificationPlanId, collectedBy, imageBase64, contentType].map((value) => String(value ?? "").trim());
  const [workspace, record, revision, plan, collector, image, type] = values;
  const imageIndex = Number(index);
  if (!workspace || !record || !revision || !plan || !collector || !image || !type || !Number.isInteger(imageIndex) || imageIndex < 1) return failure("bad_request");
  let response;
  try {
    response = await transport(`${cfg.baseUrl}${VERIFICATION_ARTIFACT_PATH}`, { method: "POST", headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ workspaceId: workspace, recordId: record, prRevisionId: revision, verificationPlanId: plan, collectedBy: collector, index: imageIndex, imageBase64: image, contentType: type }) });
  } catch { return failure("unreachable"); }
  const status = classifyStatus(Number(response?.status));
  let body;
  try { body = await response.json(); } catch { return failure(status.ok ? "bad_body" : status.reason); }
  if (!status.ok) return failure(status.reason, body && typeof body === "object" && typeof body.error === "string" ? body.error : undefined);
  if (!body || typeof body !== "object" || typeof body.url !== "string" || !body.url || !body.artifact || typeof body.artifact !== "object" || typeof body.artifact.id !== "string" || !body.artifact.id) return failure("bad_body");
  return { artifactId: body.artifact.id, key: body.artifact.key, url: body.url };
}
