import { NextRequest, NextResponse } from "next/server";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  getRepositoryByName,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";
import {
  artifactKey,
  putArtifact,
  signedGetUrl,
  storageConfigured,
} from "../../../../../lib/artifacts/store";

/**
 * POST/GET /api/v1/runner/review-evidence
 *
 * B2a §1 (design doc docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md;
 * owner ruling #1564). QA's upload seam for per-AC evidence screenshots
 * (`upload_evidence_image`, jace-side, not this PR's concern) and the
 * re-signer the posted review's links fall back to once the upload's own
 * 30-day-requested/7-day-actual signed URL has expired — see
 * `lib/artifacts/store.ts`'s own doc-comment on `signedGetUrl`'s SigV4 clamp
 * for why a re-sign path is the durable one, not a nicety.
 *
 * NAMING: `lib/artifacts/store` (imported above) is unrelated to
 * `apps/console/lib/evidence.ts` / `runner/evidence/route.ts` — that is a
 * pre-existing debugging-capability system (investigation evidence, text
 * persisted to Postgres). This route's "evidence" is per-AC visual proof
 * (image bytes in S3-compatible storage). See `lib/artifacts/store.ts`'s own
 * module doc-comment for the fuller disambiguation.
 *
 * AUTH: `requireJaceConsoleSecret` — the same central `JACE_CONSOLE_TOKEN`
 * guard every Jace-coordinator route uses. Checked FIRST, before the flag or
 * anything else: an unauthenticated caller never learns whether evidence
 * storage is even enabled.
 *
 * FLAG (checked immediately after auth): `REVIEW_EVIDENCE_ENABLED !== "1"`
 * 503s with `{error:"evidence storage not enabled"}`. This gate ALSO folds
 * in `storageConfigured(process.env)` — `lib/artifacts/store.ts`'s own
 * doc-comment names that function as "the route's pre-flight
 * 503-when-disabled gate", and its test file's comment makes the same
 * claim ("storageConfigured is its own 503-before-trying gate") — both
 * written against this exact route. Missing S3_* config is, from a caller's
 * perspective, indistinguishable from the feature being off: either way,
 * evidence cannot be stored right now, and the SAME message covers both
 * honestly without revealing which. `putArtifact`/`signedGetUrl` still get
 * their OWN try/catch below mapping to 500 — that path is for a failure
 * this pre-flight cannot see (env changing between the two calls, or any
 * other real storage-layer failure once config genuinely looks complete),
 * not a substitute for it.
 *
 * SESSION CHAIN: mirrors `pr-review/route.ts`'s `resolveWorkspaceRepoToken`
 * (post-#1569 identity-less semantics — a workspace-anchored session with no
 * bound chat identity resolves fine off its own `workspaceId` alone) MINUS
 * the GitHub installation-token lookup: this route never talks to GitHub, so
 * there is nothing to fetch a token for. `resolveWorkspaceId` below is that
 * shared shape, factored so GET (which only ever needs a workspaceId to
 * check key ownership) doesn't pay for a repo lookup it has no use for.
 *
 * POST validation order (cheapest/safest first, mirroring pr-review's own
 * "cheap validation before DB, DB before the heavier work" posture): body
 * shape (400) -> session+repo resolution (404/409) -> contentType allowlist
 * (415) -> decoded size cap (413) -> index range (422) -> artifactKey
 * construction (400 on a traversal-hostile caller field) -> putArtifact +
 * signedGetUrl (500 on either throwing). `index` is caller-counted v1 (the
 * route trusts the caller's own 1..4 numbering) — true per-AC dedup/count
 * enforcement server-side is a later concern, not this route's.
 *
 * GET: re-signs a previously-issued key. `key`'s embedded `<workspaceId>`
 * segment (the artifactKey scheme's second path component) must match the
 * CALLING session's own resolved workspaceId — mismatch, or a key that
 * doesn't even look like one of ours, both collapse into the SAME 403 (no
 * oracle distinguishing "wrong workspace" from "malformed key", the same
 * non-leaking posture `jace-console-auth.ts` uses for its own 401s).
 *
 * 500s from either handler are classified: the raw thrown message (which
 * could, in an unlucky case, echo back configuration detail) never reaches
 * the response body — only a fixed, generic message, with the real error
 * logged server-side. Mirrors `pr-review/route.ts`'s `classifyGithubError`
 * posture of never passing an upstream/internal error through raw.
 */

const REVIEW_EVIDENCE_ENABLED_VAR = "REVIEW_EVIDENCE_ENABLED";
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB
const MIN_INDEX = 1;
const MAX_INDEX = 4;
const ARTIFACT_KEY_PREFIX = "review-evidence";

const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
};

function evidenceStorageDisabled(): boolean {
  return process.env[REVIEW_EVIDENCE_ENABLED_VAR] !== "1" || !storageConfigured(process.env);
}

function storageDisabledResponse(): NextResponse {
  return NextResponse.json({ error: "evidence storage not enabled" }, { status: 503 });
}

// ---------------------------------------------------------------------------
// Shared session -> workspace resolution (GET + POST)
// ---------------------------------------------------------------------------

type WorkspaceResolution =
  | { ok: true; workspaceId: string }
  | { ok: false; response: NextResponse };

async function resolveWorkspaceId(eveSessionId: string): Promise<WorkspaceResolution> {
  const session = await getJaceSessionByEveSessionId(eveSessionId);
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Session not found" }, { status: 404 }),
    };
  }

  // Identity-less (Arc B review-job worker) sessions carry workspaceId
  // directly with no chatIdentityId — getChatIdentityById is only ever
  // called when there is an id to look up, exactly like
  // pr-review.ts's resolveWorkspaceRepoToken.
  const chatIdentityId = session.chatIdentityId ?? null;
  const identity = chatIdentityId ? await getChatIdentityById(chatIdentityId) : null;
  const workspaceId = session.workspaceId ?? identity?.workspaceId ?? null;

  if (!workspaceId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "this conversation has no workspace yet — create one first" },
        { status: 409 }
      ),
    };
  }

  return { ok: true, workspaceId };
}

// ---------------------------------------------------------------------------
// POST — upload an evidence image
// ---------------------------------------------------------------------------

interface ReviewEvidenceBody {
  eveSessionId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  acId: string;
  index: number;
  imageBase64: string;
  contentType: string;
}

const REQUIRED_FIELDS_MESSAGE =
  "eveSessionId, repo, prNumber, headSha, acId, index, imageBase64, and contentType are required";

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parseReviewEvidenceBody(raw: unknown): ReviewEvidenceBody | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  if (!isNonEmptyString(o.eveSessionId)) return null;
  if (!isNonEmptyString(o.repo)) return null;
  if (typeof o.prNumber !== "number" || !Number.isInteger(o.prNumber) || o.prNumber <= 0) return null;
  if (!isNonEmptyString(o.headSha)) return null;
  if (!isNonEmptyString(o.acId)) return null;
  // Presence/type only — whether it's an in-range INTEGER is the separate
  // 422 check below, not a 400.
  if (typeof o.index !== "number" || !Number.isFinite(o.index)) return null;
  if (!isNonEmptyString(o.imageBase64)) return null;
  if (!isNonEmptyString(o.contentType)) return null;

  return {
    eveSessionId: o.eveSessionId,
    repo: o.repo,
    prNumber: o.prNumber,
    headSha: o.headSha,
    acId: o.acId,
    index: o.index,
    imageBase64: o.imageBase64,
    contentType: o.contentType,
  };
}

export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  if (evidenceStorageDisabled()) {
    return storageDisabledResponse();
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const body = parseReviewEvidenceBody(raw);
  if (!body) {
    return NextResponse.json({ error: REQUIRED_FIELDS_MESSAGE }, { status: 400 });
  }

  const resolved = await resolveWorkspaceId(body.eveSessionId);
  if (!resolved.ok) return resolved.response;
  const { workspaceId } = resolved;

  const connectedRepo = await getRepositoryByName(workspaceId, body.repo);
  if (!connectedRepo) {
    return NextResponse.json({ error: "repo not connected to this workspace" }, { status: 404 });
  }

  const ext = CONTENT_TYPE_EXT[body.contentType];
  if (!ext) {
    return NextResponse.json(
      { error: "contentType must be image/png or image/jpeg" },
      { status: 415 }
    );
  }

  // Decode once; the same Buffer backs both the size check and the eventual
  // putArtifact call.
  const bytes = Buffer.from(body.imageBase64, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: "image exceeds the 2MB size cap" }, { status: 413 });
  }

  if (!Number.isInteger(body.index) || body.index < MIN_INDEX || body.index > MAX_INDEX) {
    return NextResponse.json(
      { error: `index must be an integer between ${MIN_INDEX} and ${MAX_INDEX}` },
      { status: 422 }
    );
  }

  let key: string;
  try {
    key = artifactKey({
      workspaceId,
      repo: body.repo,
      prNumber: body.prNumber,
      headSha: body.headSha,
      acId: body.acId,
      index: body.index,
      ext,
    });
  } catch (err) {
    // artifactKey throws on traversal-hostile caller-controlled segments
    // (repo/headSha/acId) — a bad-request condition, not a store failure.
    console.error("[review-evidence] artifactKey rejected the request:", err);
    return NextResponse.json({ error: "invalid evidence coordinates" }, { status: 400 });
  }

  try {
    await putArtifact(key, bytes, body.contentType);
    const url = await signedGetUrl(key);
    return NextResponse.json({ key, url }, { status: 200 });
  } catch (err) {
    console.error("[review-evidence] store operation failed:", err);
    return NextResponse.json({ error: "failed to store evidence" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// GET — re-sign a previously-issued key
// ---------------------------------------------------------------------------

/**
 * Pulls the workspaceId segment out of an artifactKey-shaped string (scheme:
 * `review-evidence/<workspaceId>/...`, `lib/artifacts/store.ts`'s
 * `artifactKey`). Returns null for anything that doesn't look like one of
 * our own keys (wrong/missing prefix, too few segments, a blank segment) —
 * the caller treats null exactly like a mismatch, never a distinct status:
 * which of those is true is not information this route hands back.
 */
function extractKeyWorkspaceId(key: string): string | null {
  const segments = key.split("/");
  if (segments.length < 2 || segments[0] !== ARTIFACT_KEY_PREFIX) return null;
  return segments[1] || null;
}

export async function GET(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;

  if (evidenceStorageDisabled()) {
    return storageDisabledResponse();
  }

  const params = request.nextUrl.searchParams;
  const eveSessionId = params.get("eveSessionId")?.trim() ?? "";
  const key = params.get("key")?.trim() ?? "";

  if (!eveSessionId) {
    return NextResponse.json({ error: "eveSessionId is required" }, { status: 400 });
  }
  if (!key) {
    return NextResponse.json({ error: "key is required" }, { status: 400 });
  }

  const resolved = await resolveWorkspaceId(eveSessionId);
  if (!resolved.ok) return resolved.response;
  const { workspaceId } = resolved;

  if (extractKeyWorkspaceId(key) !== workspaceId) {
    return NextResponse.json({ error: "key does not belong to this workspace" }, { status: 403 });
  }

  try {
    const url = await signedGetUrl(key);
    return NextResponse.json({ url }, { status: 200 });
  } catch (err) {
    console.error("[review-evidence] re-sign failed:", err);
    return NextResponse.json({ error: "failed to sign evidence url" }, { status: 500 });
  }
}
