import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  recordEvidenceVerificationArtifact,
  resolveEvidenceVerificationPlanForArtifact,
} from "@agentrail/db-postgres";
import { redactApiEvidence, ApiEvidenceError } from "../../../../../lib/artifacts/api-evidence";
import { artifactKey, putArtifact, signedGetUrl, storageConfigured } from "../../../../../lib/artifacts/store";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

const MAX_EVIDENCE_BYTES = 256 * 1024;
const MAX_ARTIFACT_INDEX = 10;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const object = (value: unknown): value is Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isInteger(value);

function validApiEvidence(value: unknown): value is Record<string, unknown> {
  if (!object(value)) return false;
  const request = value.request;
  const response = value.response;
  const assertions = value.assertions;
  if (!object(request) || !object(response)) return false;
  if (!text(request.method) || !text(request.url)) return false;
  if (!integer(response.status) || response.status < 100 || response.status > 599) return false;
  return Array.isArray(assertions) && assertions.length > 0 && assertions.length <= 20
    && assertions.every((assertion) => text(assertion) && assertion.length <= 2_000);
}

function matchesApiDescriptor(evidence: Record<string, unknown>, descriptor: unknown, previewUrl: string | undefined): boolean {
  if (!object(descriptor) || descriptor.method !== "GET") return false;
  const descriptorPath = descriptor.path;
  const expectedStatus = descriptor.expectedStatus;
  if (!text(descriptorPath) || !integer(expectedStatus)) return false;
  const request = evidence.request;
  const response = evidence.response;
  if (!object(request) || !object(response)) return false;
  const requestMethod = request.method;
  const requestUrl = request.url;
  if (!text(requestMethod) || !text(requestUrl) || !integer(response.status)) return false;
  if (requestMethod !== descriptor.method || response.status !== expectedStatus) return false;
  const previewOrigin = previewUrl ? new URL(previewUrl).origin : null;
  if (!previewOrigin) return false;
  try {
    const url = new URL(requestUrl);
    return url.origin === previewOrigin && url.pathname === descriptorPath && url.search === "" && url.hash === "";
  } catch { return false; }
}

/** Store one redacted request/response/assertion card for a planned exact-head API criterion. */
export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;
  if (process.env.REVIEW_EVIDENCE_ENABLED !== "1" || !storageConfigured(process.env)) {
    return NextResponse.json({ error: "evidence storage not enabled" }, { status: 503 });
  }
  const parsed = await request.json().catch(() => null);
  if (!object(parsed)) {
    return NextResponse.json({ error: "API evidence requires exact plan coordinates plus request, response status, and assertions" }, { status: 400 });
  }
  const body = parsed;
  const workspaceId = body.workspaceId;
  const recordId = body.recordId;
  const prRevisionId = body.prRevisionId;
  const verificationPlanId = body.verificationPlanId;
  const collectedBy = body.collectedBy;
  const index = body.index;
  const evidenceInput = body.evidence;
  if (!text(workspaceId) || !text(recordId) || !text(prRevisionId) || !text(verificationPlanId) || !text(collectedBy) || !integer(index) || !validApiEvidence(evidenceInput)) {
    return NextResponse.json({ error: "API evidence requires exact plan coordinates plus request, response status, and assertions" }, { status: 400 });
  }
  if (index < 1 || index > MAX_ARTIFACT_INDEX) {
    return NextResponse.json({ error: `index must be an integer between 1 and ${MAX_ARTIFACT_INDEX}` }, { status: 422 });
  }
  let bytes: Buffer;
  try {
    const redactedEvidence = redactApiEvidence(evidenceInput);
    bytes = Buffer.from(JSON.stringify(redactedEvidence));
  } catch (error) {
    const message = error instanceof ApiEvidenceError ? error.message : "API evidence could not be serialized";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  if (bytes.length === 0 || bytes.length > MAX_EVIDENCE_BYTES) {
    return NextResponse.json({ error: "redacted API evidence must be non-empty and no more than 256KB" }, { status: 413 });
  }
  const resolved = await resolveEvidenceVerificationPlanForArtifact({
    workspaceId,
    recordId,
    prRevisionId,
    verificationPlanId,
    modality: "api",
  });
  if (!resolved) {
    return NextResponse.json({ error: "current planned API criterion not found for this record and PR revision" }, { status: 409 });
  }
  if (!matchesApiDescriptor(evidenceInput, resolved.plan.apiRequest, resolved.previewUrl)) {
    return NextResponse.json({ error: "API evidence does not match the planned exact-preview GET request and expected status" }, { status: 409 });
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  let key: string;
  try {
    key = artifactKey({
      workspaceId,
      repo: resolved.repositoryFullName,
      prNumber: resolved.prNumber,
      headSha: resolved.headSha,
      acId: `${resolved.plan.criterionId}-${digest.slice(0, 16)}`,
      index,
      ext: "json",
    });
  } catch {
    return NextResponse.json({ error: "stored PR coordinates are not safe for artifact storage" }, { status: 409 });
  }
  try {
    await putArtifact(key, bytes, "application/json");
    const artifact = await recordEvidenceVerificationArtifact({
      verificationPlanId: resolved.plan.id,
      artifactKey: key,
      contentType: "application/json",
      contentSha256: digest,
      collectedBy,
    });
    return NextResponse.json({
      artifact: {
        id: artifact.id,
        key: artifact.artifactKey,
        verificationPlanId: artifact.verificationPlanId,
        criterionId: resolved.plan.criterionId,
        environmentId: resolved.plan.environmentId,
        headSha: resolved.headSha,
        redacted: true,
      },
      url: await signedGetUrl(key),
    }, { status: 201 });
  } catch (error) {
    console.error("[evidence-verification-api-artifacts] store or record failed:", error);
    return NextResponse.json({ error: "failed to store API evidence artifact" }, { status: 500 });
  }
}
