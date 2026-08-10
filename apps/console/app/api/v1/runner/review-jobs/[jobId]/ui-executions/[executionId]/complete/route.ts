import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import {
  appendChangeRecordEvent,
  appendCurrentReviewJobEventsAtomically,
  CurrentReviewJobNotCurrentError,
  getJaceSessionByEveSessionId,
  getPreviewBoot,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../../../lib/jace-console-auth";
import {
  artifactKey,
  putArtifact,
  signedGetUrl,
  storageConfigured,
} from "../../../../../../../../../lib/artifacts/store";
import { resolveCurrentReviewJobPlan } from "../../../../../../../../../lib/review-job-proof-attestation";
import {
  REVIEW_JOB_UI_ACTOR,
  REVIEW_JOB_UI_STAGE,
  buildReviewJobUiAttempt,
  buildReviewJobUiResult,
  buildReviewJobUiScreenshotReservation,
  findReviewJobUiAttemptByExecutionId,
  resolveReviewJobUiResult,
  reviewJobUiResultEventKey,
  reviewJobUiResultResponse,
  reviewJobUiScreenshotReservationEventKey,
  sameHttpOrigin,
} from "../../../../../../../../../lib/review-job-ui-execution";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4;
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;

interface CompleteBody {
  eveSessionId: string;
  assertionPassed: boolean;
  observedUrl: string;
  imageBase64: string;
  contentType: "image/png" | "image/jpeg";
}

function nonBlank(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function parseBody(value: unknown): CompleteBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  const expected = [
    "assertionPassed",
    "contentType",
    "eveSessionId",
    "imageBase64",
    "observedUrl",
  ];
  if (
    keys.length !== expected.length ||
    !keys.every((key, index) => key === expected[index]) ||
    typeof input.assertionPassed !== "boolean"
  ) {
    return null;
  }
  const eveSessionId = nonBlank(input.eveSessionId);
  const observedUrl = nonBlank(input.observedUrl);
  const imageBase64 = nonBlank(input.imageBase64);
  const contentType = input.contentType;
  if (
    !eveSessionId ||
    !observedUrl ||
    !imageBase64 ||
    (contentType !== "image/png" && contentType !== "image/jpeg")
  ) {
    return null;
  }
  return {
    eveSessionId,
    assertionPassed: input.assertionPassed,
    observedUrl,
    imageBase64,
    contentType,
  };
}

function activeFutureExpiry(value: unknown): boolean {
  const timestamp =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function exactBase64Bytes(value: string): Buffer | null {
  if (
    value.length > MAX_BASE64_CHARS ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_IMAGE_BYTES ||
    bytes.toString("base64") !== value
  ) {
    return null;
  }
  return bytes;
}

function imageMatchesType(
  bytes: Buffer,
  contentType: "image/png" | "image/jpeg"
): boolean {
  if (contentType === "image/png") {
    return (
      bytes.length >= 20 &&
      bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ) &&
      // A PNG screenshot ends at its zero-length IEND chunk. Requiring the
      // canonical final chunk rejects trailing polyglot data before decode.
      bytes.subarray(-12).equals(
        Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
      )
    );
  }
  return (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  );
}

async function imageDecodesAsScreenshot(
  bytes: Buffer,
  contentType: "image/png" | "image/jpeg"
): Promise<boolean> {
  if (!imageMatchesType(bytes, contentType)) return false;
  try {
    const options = {
      failOn: "warning" as const,
      limitInputPixels: MAX_IMAGE_PIXELS,
      sequentialRead: true,
    };
    const metadata = await sharp(bytes, options).metadata();
    const expectedFormat = contentType === "image/png" ? "png" : "jpeg";
    if (
      metadata.format !== expectedFormat ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > MAX_IMAGE_PIXELS ||
      (metadata.pages != null && metadata.pages !== 1)
    ) {
      return false;
    }
    const decoded = await sharp(bytes, options)
      .raw()
      .toBuffer({ resolveWithObject: true });
    return (
      decoded.data.length > 0 &&
      decoded.info.width === metadata.width &&
      decoded.info.height === metadata.height
    );
  } catch {
    return false;
  }
}

function evidenceStorageEnabled(): boolean {
  return (
    process.env.REVIEW_EVIDENCE_ENABLED === "1" &&
    storageConfigured(process.env)
  );
}

/** Store one decisive exact-head screenshot and its immutable UI result receipt. */
export async function POST(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ jobId: string; executionId: string }>;
  }
) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;

  if (!evidenceStorageEnabled()) {
    return NextResponse.json(
      { error: "evidence storage not enabled" },
      { status: 503 }
    );
  }

  const body = parseBody(await request.json().catch(() => null));
  const resolvedParams = await params;
  const jobId = nonBlank(resolvedParams.jobId);
  const executionId = nonBlank(resolvedParams.executionId);
  if (!body || !jobId || !executionId) {
    return NextResponse.json(
      {
        error:
          "eveSessionId, assertionPassed, observedUrl, imageBase64, and contentType are required and must be the only fields",
      },
      { status: 400 }
    );
  }

  const session = await getJaceSessionByEveSessionId(body.eveSessionId);
  if (
    !session ||
    session.eveSessionId !== body.eveSessionId ||
    session.channel !== "review-job" ||
    session.conversationKey !== `review-job:${jobId}` ||
    session.status !== "active"
  ) {
    return NextResponse.json(
      { error: "review session is not bound to this job" },
      { status: 409 }
    );
  }

  const proof = await resolveCurrentReviewJobPlan(jobId);
  if (
    !proof ||
    !session.workspaceId ||
    session.workspaceId !== proof.job.workspaceId
  ) {
    return NextResponse.json(
      { error: "review job plan is not current for this session" },
      { status: 409 }
    );
  }
  const execution = findReviewJobUiAttemptByExecutionId({ proof, executionId });
  if (!execution) {
    return NextResponse.json(
      { error: "UI execution was not reserved for this exact review plan" },
      { status: 409 }
    );
  }
  const { plan, attempt } = execution;

  const bytes = exactBase64Bytes(body.imageBase64);
  if (!bytes || !(await imageDecodesAsScreenshot(bytes, body.contentType))) {
    return NextResponse.json(
      { error: "screenshot bytes do not match a bounded PNG or JPEG" },
      { status: 415 }
    );
  }
  if (!sameHttpOrigin(body.observedUrl, attempt.previewUrl)) {
    return NextResponse.json(
      { error: "browser observation left the exact preview origin" },
      { status: 409 }
    );
  }

  const boot = await getPreviewBoot(attempt.previewBootId);
  const currentAttempt =
    boot && activeFutureExpiry(boot.expiresAt)
      ? buildReviewJobUiAttempt({ proof, plan, boot })
      : null;
  if (!currentAttempt || !isDeepStrictEqual(currentAttempt, attempt)) {
    return NextResponse.json(
      { error: "exact-head preview is no longer ready for this UI execution" },
      { status: 409 }
    );
  }

  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  let key: string;
  try {
    key = artifactKey({
      workspaceId: proof.job.workspaceId,
      repo: proof.job.repo,
      prNumber: proof.job.prNumber,
      headSha: proof.job.headSha,
      // Contract criterion ids are human-authored and may legitimately contain
      // path-hostile characters. Keep them in the signed receipt, but derive the
      // storage segment exclusively from the server-owned execution digest.
      acId: `${attempt.executionId}-${contentSha256.slice(0, 16)}`,
      index: 1,
      ext: body.contentType === "image/png" ? "png" : "jpeg",
    });
  } catch {
    return NextResponse.json(
      { error: "stored review coordinates are not safe for artifact custody" },
      { status: 409 }
    );
  }
  const result = buildReviewJobUiResult({
    attempt,
    plan,
    assertionPassed: body.assertionPassed,
    artifactKey: key,
    contentType: body.contentType,
    contentSha256,
    observedUrl: body.observedUrl,
  });
  if (!result) {
    return NextResponse.json(
      { error: "browser result does not match the reserved UI execution" },
      { status: 409 }
    );
  }

  const existingResolution = resolveReviewJobUiResult({ proof, plan });
  if (existingResolution.status === "invalid") {
    return NextResponse.json(
      { error: "stored UI screenshot custody is invalid" },
      { status: 409 }
    );
  }
  const existing = existingResolution.result;
  if (existing) {
    if (!isDeepStrictEqual(existing, result)) {
      return NextResponse.json(
        { error: "UI execution result is immutable" },
        { status: 409 }
      );
    }
    try {
      return NextResponse.json(
        reviewJobUiResultResponse(existing, await signedGetUrl(existing.artifactKey)),
        { status: 200 }
      );
    } catch {
      return NextResponse.json(
        { error: "stored screenshot could not be signed" },
        { status: 500 }
      );
    }
  }

  // Reserve the one immutable content-addressed screenshot before writing
  // bytes. A competing completion loses here, so it cannot leave an orphaned
  // object; an exact retry may safely finish the same reserved upload/result.
  const screenshotReservation = buildReviewJobUiScreenshotReservation(result);
  let reserved: Awaited<
    ReturnType<typeof appendCurrentReviewJobEventsAtomically>
  >["events"][number];
  try {
    const reservation = await appendCurrentReviewJobEventsAtomically({
      workspaceId: proof.job.workspaceId,
      recordId: proof.timeline.record.id,
      jobId: proof.job.id,
      repo: proof.job.repo,
      prNumber: proof.job.prNumber,
      headSha: proof.job.headSha,
      events: [
        {
          eventKey: reviewJobUiScreenshotReservationEventKey({ proof, plan }),
          stage: REVIEW_JOB_UI_STAGE,
          actor: REVIEW_JOB_UI_ACTOR,
          payloadRef: screenshotReservation,
        },
      ],
    });
    reserved = reservation.events[0]!;
  } catch (error) {
    if (error instanceof CurrentReviewJobNotCurrentError) {
      return NextResponse.json(
        { error: "review job is no longer current for this pull request head" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "could not reserve screenshot custody" },
      { status: 503 }
    );
  }
  if (!isDeepStrictEqual(reserved.event.payloadRef, screenshotReservation)) {
    return NextResponse.json(
      { error: "UI screenshot upload is immutable" },
      { status: 409 }
    );
  }

  try {
    await putArtifact(key, bytes, body.contentType);
  } catch {
    return NextResponse.json(
      { error: "failed to store the UI screenshot" },
      { status: 500 }
    );
  }

  let recorded: Awaited<ReturnType<typeof appendChangeRecordEvent>>;
  try {
    recorded = await appendChangeRecordEvent({
      recordId: proof.timeline.record.id,
      eventKey: reviewJobUiResultEventKey({ proof, plan }),
      stage: REVIEW_JOB_UI_STAGE,
      actor: REVIEW_JOB_UI_ACTOR,
      payloadRef: result,
    });
  } catch {
    return NextResponse.json(
      {
        error:
          "screenshot stored under its durable reservation but its execution receipt could not be recorded",
      },
      { status: 503 }
    );
  }
  if (!isDeepStrictEqual(recorded.event.payloadRef, result)) {
    return NextResponse.json(
      { error: "UI execution result is immutable" },
      { status: 409 }
    );
  }

  try {
    return NextResponse.json(
      reviewJobUiResultResponse(result, await signedGetUrl(key)),
      { status: recorded.inserted ? 201 : 200 }
    );
  } catch {
    return NextResponse.json(
      { error: "UI result was stored but its screenshot could not be signed" },
      { status: 500 }
    );
  }
}
