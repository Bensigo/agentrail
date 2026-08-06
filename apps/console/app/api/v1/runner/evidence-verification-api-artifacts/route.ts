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

function validApiEvidence(value: unknown): value is Record<string, unknown> {
  if (!object(value) || !object(value.request) || !object(value.response)) return false;
  if (!text(value.request.method) || !text(value.request.url)) return false;
  if (!Number.isInteger(value.response.status) || (value.response.status as number) < 100 || (value.response.status as number) > 599) return false;
  return Array.isArray(value.assertions) && value.assertions.length > 0 && value.assertions.length <= 20
    && value.assertions.every((assertion) => text(assertion) && assertion.length <= 2_000);
}

/** Store one redacted request/response/assertion card for a planned exact-head API criterion. */
export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;
  if (process.env.REVIEW_EVIDENCE_ENABLED !== "1" || !storageConfigured(process.env)) {
    return NextResponse.json({ error: "evidence storage not enabled" }, { status: 503 });
  }
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const index = body.index;
  const required = ["workspaceId", "recordId", "prRevisionId", "verificationPlanId", "collectedBy"];
  if (!object(body) || required.some((key) => !text(body[key])) || typeof index !== "number" || !Number.isInteger(index) || !validApiEvidence(body.evidence)) {
    return NextResponse.json({ error: "API evidence requires exact plan coordinates plus request, response status, and assertions" }, { status: 400 });
  }
  if (index < 1 || index > MAX_ARTIFACT_INDEX) {
    return NextResponse.json({ error: `index must be an integer between 1 and ${MAX_ARTIFACT_INDEX}` }, { status: 422 });
  }
  let evidence: unknown;
  let bytes: Buffer;
  try {
    evidence = redactApiEvidence(body.evidence);
    bytes = Buffer.from(JSON.stringify(evidence));
  } catch (error) {
    const message = error instanceof ApiEvidenceError ? error.message : "API evidence could not be serialized";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  if (bytes.length === 0 || bytes.length > MAX_EVIDENCE_BYTES) {
    return NextResponse.json({ error: "redacted API evidence must be non-empty and no more than 256KB" }, { status: 413 });
  }
  const resolved = await resolveEvidenceVerificationPlanForArtifact({
    workspaceId: body.workspaceId as string,
    recordId: body.recordId as string,
    prRevisionId: body.prRevisionId as string,
    verificationPlanId: body.verificationPlanId as string,
    modality: "api",
  });
  if (!resolved) {
    return NextResponse.json({ error: "current planned API criterion not found for this record and PR revision" }, { status: 409 });
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  let key: string;
  try {
    key = artifactKey({
      workspaceId: body.workspaceId as string,
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
      collectedBy: body.collectedBy as string,
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
