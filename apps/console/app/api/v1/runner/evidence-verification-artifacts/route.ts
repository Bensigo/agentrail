import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  recordEvidenceVerificationArtifact,
  resolveEvidenceVerificationPlanForArtifact,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";
import { artifactKey, putArtifact, signedGetUrl, storageConfigured } from "../../../../../lib/artifacts/store";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_INDEX = 10;
const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg" };
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const object = (value: unknown): value is Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isInteger(value);

function matchesPreviewOrigin(observedUrl: unknown, previewUrl: string | undefined): boolean {
  if (!text(observedUrl) || !previewUrl) return false;
  try { return new URL(observedUrl).origin === new URL(previewUrl).origin; } catch { return false; }
}

/** Store UI evidence only after deriving its criterion and exact PR head from a persisted plan. */
export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;
  if (process.env.REVIEW_EVIDENCE_ENABLED !== "1" || !storageConfigured(process.env)) {
    return NextResponse.json({ error: "evidence storage not enabled" }, { status: 503 });
  }
  const parsed = await request.json().catch(() => null);
  const required = ["workspaceId", "recordId", "prRevisionId", "verificationPlanId", "collectedBy", "imageBase64", "contentType", "observedUrl"];
  if (!object(parsed) || required.some((key) => !text(parsed[key])) || !integer(parsed.index)) {
    return NextResponse.json({ error: "invalid verification artifact payload" }, { status: 400 });
  }
  const body = parsed;
  const workspaceId = body.workspaceId;
  const recordId = body.recordId;
  const prRevisionId = body.prRevisionId;
  const verificationPlanId = body.verificationPlanId;
  const collectedBy = body.collectedBy;
  const imageBase64 = body.imageBase64;
  const contentType = body.contentType;
  const observedUrl = body.observedUrl;
  const index = body.index;
  if (!text(workspaceId) || !text(recordId) || !text(prRevisionId) || !text(verificationPlanId) || !text(collectedBy) || !text(imageBase64) || !text(contentType) || !text(observedUrl) || !integer(index)) {
    return NextResponse.json({ error: "invalid verification artifact payload" }, { status: 400 });
  }
  if (contentType !== "image/png" && contentType !== "image/jpeg") {
    return NextResponse.json({ error: "contentType must be image/png or image/jpeg" }, { status: 415 });
  }
  const extension = extensions[contentType];
  if (index < 1 || index > MAX_ARTIFACT_INDEX) {
    return NextResponse.json({ error: `index must be an integer between 1 and ${MAX_ARTIFACT_INDEX}` }, { status: 422 });
  }
  const bytes = Buffer.from(imageBase64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: "image must be non-empty and no more than 2MB" }, { status: 413 });
  }
  const resolved = await resolveEvidenceVerificationPlanForArtifact({
    workspaceId,
    recordId,
    prRevisionId,
    verificationPlanId,
    modality: "ui",
    requireReadyPreview: true,
  });
  if (!resolved) {
    return NextResponse.json({ error: "current planned UI criterion not found for this record and PR revision" }, { status: 409 });
  }
  if (!matchesPreviewOrigin(observedUrl, resolved.previewUrl)) {
    return NextResponse.json({ error: "UI evidence does not match the current exact-preview origin" }, { status: 409 });
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
      ext: extension,
    });
  } catch {
    return NextResponse.json({ error: "stored PR coordinates are not safe for artifact storage" }, { status: 409 });
  }
  try {
    await putArtifact(key, bytes, contentType);
    const artifact = await recordEvidenceVerificationArtifact({
      verificationPlanId: resolved.plan.id,
      artifactKey: key,
      contentType,
      contentSha256: digest,
      collectedBy,
    });
    const url = await signedGetUrl(key);
    return NextResponse.json({
      artifact: {
        id: artifact.id,
        key: artifact.artifactKey,
        verificationPlanId: artifact.verificationPlanId,
        criterionId: resolved.plan.criterionId,
        environmentId: resolved.plan.environmentId,
        headSha: resolved.headSha,
      },
      url,
    }, { status: 201 });
  } catch (error) {
    console.error("[evidence-verification-artifacts] store or record failed:", error);
    return NextResponse.json({ error: "failed to store verification artifact" }, { status: 500 });
  }
}
