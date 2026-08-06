import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  recordEvidenceVerificationArtifact,
  resolveEvidenceVerificationPlanForArtifact,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";
import { artifactKey, putArtifact, storageConfigured } from "../../../../../lib/artifacts/store";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_INDEX = 10;
const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg" };
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const object = (value: unknown): value is Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value);

/** Store UI evidence only after deriving its criterion and exact PR head from a persisted plan. */
export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;
  if (process.env.REVIEW_EVIDENCE_ENABLED !== "1" || !storageConfigured(process.env)) {
    return NextResponse.json({ error: "evidence storage not enabled" }, { status: 503 });
  }
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const required = ["workspaceId", "recordId", "prRevisionId", "verificationPlanId", "collectedBy", "imageBase64", "contentType"];
  if (!object(body) || required.some((key) => !text(body[key])) || !Number.isInteger(body.index)) {
    return NextResponse.json({ error: "invalid verification artifact payload" }, { status: 400 });
  }
  const extension = extensions[body.contentType as string];
  if (!extension) return NextResponse.json({ error: "contentType must be image/png or image/jpeg" }, { status: 415 });
  if (body.index < 1 || body.index > MAX_ARTIFACT_INDEX) {
    return NextResponse.json({ error: `index must be an integer between 1 and ${MAX_ARTIFACT_INDEX}` }, { status: 422 });
  }
  const bytes = Buffer.from(body.imageBase64 as string, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: "image must be non-empty and no more than 2MB" }, { status: 413 });
  }
  const resolved = await resolveEvidenceVerificationPlanForArtifact({
    workspaceId: body.workspaceId as string,
    recordId: body.recordId as string,
    prRevisionId: body.prRevisionId as string,
    verificationPlanId: body.verificationPlanId as string,
  });
  if (!resolved) {
    return NextResponse.json({ error: "current planned UI criterion not found for this record and PR revision" }, { status: 409 });
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
      index: body.index,
      ext: extension,
    });
  } catch {
    return NextResponse.json({ error: "stored PR coordinates are not safe for artifact storage" }, { status: 409 });
  }
  try {
    await putArtifact(key, bytes, body.contentType as "image/png" | "image/jpeg");
    const artifact = await recordEvidenceVerificationArtifact({
      verificationPlanId: resolved.plan.id,
      artifactKey: key,
      contentType: body.contentType as "image/png" | "image/jpeg",
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
      },
    }, { status: 201 });
  } catch (error) {
    console.error("[evidence-verification-artifacts] store or record failed:", error);
    return NextResponse.json({ error: "failed to store verification artifact" }, { status: 500 });
  }
}
