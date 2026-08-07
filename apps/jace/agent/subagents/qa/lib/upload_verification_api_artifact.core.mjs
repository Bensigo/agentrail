import { classifyStatus, failure, resolveConsoleConfig } from "./upload_evidence_image.core.mjs";

export const VERIFICATION_API_ARTIFACT_PATH = "/api/v1/runner/evidence-verification-api-artifacts";

/** Upload only redacted API proof bound to the execution plan supplied by Jace. */
export async function runUploadVerificationApiArtifact({ env = {}, workspaceId, recordId, prRevisionId, verificationPlanId, collectedBy, index, evidence, transport }) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return failure("config_missing");
  const values = [workspaceId, recordId, prRevisionId, verificationPlanId, collectedBy].map((value) => String(value ?? "").trim());
  if (values.some((value) => !value) || !Number.isInteger(Number(index)) || Number(index) < 1 || !evidence || typeof evidence !== "object") return failure("bad_request");
  let response;
  try { response = await transport(`${cfg.baseUrl}${VERIFICATION_API_ARTIFACT_PATH}`, { method: "POST", headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ workspaceId, recordId, prRevisionId, verificationPlanId, collectedBy, index: Number(index), evidence }) }); } catch { return failure("unreachable"); }
  const status = classifyStatus(Number(response?.status));
  let body;
  try { body = await response.json(); } catch { return failure(status.ok ? "bad_body" : status.reason); }
  if (!status.ok) return failure(status.reason, body && typeof body === "object" && typeof body.error === "string" ? body.error : undefined);
  if (!body || typeof body !== "object" || typeof body.url !== "string" || !body.artifact || typeof body.artifact !== "object" || typeof body.artifact.id !== "string") return failure("bad_body");
  return { artifactId: body.artifact.id, key: body.artifact.key, url: body.url };
}
