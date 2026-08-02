import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * The console's S3-compatible artifact store (B2a §1,
 * docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md). This
 * is the repo's FIRST reader of `S3_ENDPOINT`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`/
 * `S3_BUCKET` — until this task, zero code in `apps/console` or `packages/*`
 * read any of the four (`deploy/.env.production.example`'s own comment said
 * so verbatim; that sentence is now stale, not this module's concern to fix).
 * `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner` are correspondingly
 * NEW dependencies — nothing else in the repo provided an S3 client before.
 *
 * NAMING — deliberately NOT under `lib/evidence/`: that directory (and the
 * unrelated, same-word sibling FILE `lib/evidence.ts`) is a pre-existing,
 * unconnected observability-adapter system (Datadog/Sentry/Railway/etc.
 * readers that answer investigation questions from Postgres-backed prose).
 * This module's "evidence" is a different noun entirely — per-AC visual
 * proof (a screenshot today, a recording later) captured during behavioral
 * QA and stored as bytes in an S3-compatible bucket. `lib/artifacts/` is a
 * new, disambiguated top-level concern; see that directory's own naming note
 * for the file-vs-directory resolution precedent this mirrors.
 *
 * Backs a later runner route (`POST /api/v1/runner/review-evidence`, not
 * this task) that uploads QA's captured screenshots and a posted-review
 * renderer that links them back as signed GET URLs.
 *
 * ENV CONTRACT: four required vars, checked together by
 * {@link storageConfigured} (the route's pre-flight 503-when-disabled gate)
 * and re-validated by {@link putArtifact}/{@link signedGetUrl} themselves
 * (whose own throw is the route's 500 path for a caller that skips the
 * pre-flight check, or a value that changed between the two calls):
 *   - `S3_ENDPOINT`    — e.g. `http://localhost:9000` (dev minio) or a
 *                        Railway minio / real S3 endpoint in prod.
 *   - `S3_ACCESS_KEY`  / `S3_SECRET_KEY` — static credentials.
 *   - `S3_BUCKET`      — e.g. `agentrail-artifacts` (the dev-compose bucket,
 *                        pre-created by the `minio-init` service).
 *   - `S3_REGION`      — OPTIONAL, defaults to `"us-east-1"`. S3-compatible
 *                        stores like minio have no real region concept, but
 *                        the AWS SDK v3 client requires SOME region string to
 *                        construct a SigV4 signing scope — this is a
 *                        placeholder for those targets, not a validated AWS
 *                        region.
 *
 * FORCE PATH STYLE: always `true`. Minio (dev, and — per the design doc's
 * rollout note — possibly prod too, via a Railway minio service) requires
 * path-style requests (`http://host:port/<bucket>/<key>`); virtual-hosted
 * style (`http://<bucket>.host/<key>`) needs real DNS-level bucket-subdomain
 * support minio doesn't provide. Since `S3_ENDPOINT` is one of the four
 * always-required vars, this client is ALWAYS talking to an explicit,
 * S3-compatible endpoint rather than bare AWS `s3.amazonaws.com` — path
 * style is the safe, uniform choice for that shape of target across every
 * deployment this module currently supports.
 */

const S3_ENDPOINT_VAR = "S3_ENDPOINT";
const S3_ACCESS_KEY_VAR = "S3_ACCESS_KEY";
const S3_SECRET_KEY_VAR = "S3_SECRET_KEY";
const S3_BUCKET_VAR = "S3_BUCKET";
const S3_REGION_VAR = "S3_REGION";
const DEFAULT_REGION = "us-east-1";

/** Presigned GET URL default TTL: 30 days, in seconds — pinned by the task brief. */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 2_592_000;

/**
 * SigV4's hard protocol ceiling for a presigned URL signed with static,
 * IAM-user-style credentials — exactly what this module uses
 * (`S3_ACCESS_KEY`/`S3_SECRET_KEY`). CONFIRMED against AWS's own docs
 * (docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html:
 * "X-Amz-Expires ... Range: 1 - 604800") and independently enforced by the
 * AWS SDK itself — `@aws-sdk/middleware-sdk-s3` throws "Signature version 4
 * presigned URLs must have an expiration date less than one week in the
 * future" for any larger value, discovered empirically while writing this
 * module's own tests. This is not a minio quirk or a soft choice; it is a
 * fixed constraint on SigV4 query-string signing that no client-side config
 * can raise.
 *
 * This DIRECTLY CONTRADICTS the task brief's pinned default TTL, 2,592,000s
 * (30 days): {@link DEFAULT_SIGNED_URL_TTL_SECONDS} keeps that EXACT value
 * (reducing the constant itself would silently misrepresent the interface
 * that was specified), but {@link signedGetUrl} clamps whatever it actually
 * hands to the AWS SDK at this ceiling — the alternative (not clamping)
 * would make the interface's own default parameter throw on every
 * unparameterized call, which cannot be the intended behavior. A clamp logs
 * once via `console.warn` so an operator watching server logs sees the gap
 * between the requested and the actually-issued expiration. Flagged
 * prominently in this task's report — a spec/deploy-level decision (e.g.
 * STS-based short-lived credentials, which cap even lower at 12h/43200s, or
 * a re-signing proxy) is out of scope for this task to resolve further.
 */
const MAX_SIGV4_PRESIGN_TTL_SECONDS = 604_800;

/**
 * Read-only presence check: all four required `S3_*` vars are non-empty on
 * `env`. Takes `env` as a parameter (rather than reading `process.env`
 * directly, unlike every other function here) so the runner route can use it
 * as a pure pre-flight gate — "is storage configured at all" — before
 * attempting any write, answering its 503-when-disabled path without ever
 * touching the S3 client. `S3_REGION` is intentionally excluded: it is
 * optional everywhere in this module (see the module doc-comment).
 *
 * Typed as a plain string-keyed record rather than `NodeJS.ProcessEnv` —
 * this project's Next.js types augment `ProcessEnv` with a REQUIRED
 * `NODE_ENV` field, which would force every caller (including this module's
 * own tests) to fabricate an unrelated field just to satisfy the type. The
 * real call site (`process.env`) is structurally assignable to this looser
 * type regardless, since `ProcessEnv` is itself a string-keyed record.
 */
export function storageConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env[S3_ENDPOINT_VAR] &&
      env[S3_ACCESS_KEY_VAR] &&
      env[S3_SECRET_KEY_VAR] &&
      env[S3_BUCKET_VAR]
  );
}

interface ResolvedS3Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
}

/**
 * Reads + validates the four required `S3_*` vars (plus the optional
 * `S3_REGION`) off `process.env`, throwing a single error naming every
 * missing var (never a secret value) when at least one required var is
 * absent or empty. This is the throw {@link putArtifact}/{@link signedGetUrl}
 * surface directly — the route turns it into its 500 path for a caller that
 * calls either without first checking {@link storageConfigured}.
 */
function resolveS3Config(): ResolvedS3Config {
  const endpoint = process.env[S3_ENDPOINT_VAR];
  const accessKeyId = process.env[S3_ACCESS_KEY_VAR];
  const secretAccessKey = process.env[S3_SECRET_KEY_VAR];
  const bucket = process.env[S3_BUCKET_VAR];

  const missing = [
    !endpoint && S3_ENDPOINT_VAR,
    !accessKeyId && S3_ACCESS_KEY_VAR,
    !secretAccessKey && S3_SECRET_KEY_VAR,
    !bucket && S3_BUCKET_VAR,
  ].filter((v): v is string => Boolean(v));

  if (missing.length > 0) {
    throw new Error(
      `[lib/artifacts/store] artifact store is not configured — missing required env var(s): ${missing.join(", ")}`
    );
  }

  return {
    endpoint: endpoint!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    bucket: bucket!,
    region: process.env[S3_REGION_VAR] || DEFAULT_REGION,
  };
}

/**
 * Builds a fresh {@link S3Client} + resolves the target bucket from
 * `process.env` — called fresh on every {@link putArtifact}/
 * {@link signedGetUrl} invocation rather than cached as a module singleton.
 * Client construction is cheap (no I/O — it only builds an in-memory
 * middleware stack) and this call is never on a hot path (one call per
 * uploaded evidence image, or per posted-review render); avoiding a
 * singleton sidesteps any "env changed but the cached client didn't" staleness
 * entirely, which matters in particular for this module's own tests.
 */
function resolveS3(): { client: S3Client; bucket: string } {
  const config = resolveS3Config();
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    // See the module doc-comment, "FORCE PATH STYLE".
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return { client, bucket: config.bucket };
}

/**
 * Uploads `bytes` to the artifact store under `key` (build one with
 * {@link artifactKey}) via S3 `PutObject`. Throws (rejects) when the S3_*
 * env config is incomplete — see {@link resolveS3Config} — or when the
 * underlying `PutObjectCommand` itself fails (propagated from the AWS SDK
 * uncaught; the route's own try/catch maps either case to its 500 path).
 */
export async function putArtifact(
  key: string,
  bytes: Buffer,
  contentType: string
): Promise<void> {
  const { client, bucket } = resolveS3();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: contentType,
    })
  );
}

/**
 * A presigned S3 `GetObject` URL for `key`, valid for `ttlSeconds` (default
 * {@link DEFAULT_SIGNED_URL_TTL_SECONDS}, 30 days) — the repo's first
 * signed-URL precedent (design doc §1: GitHub's own comment-upload CDN has
 * no public API, so evidence links posted in reviews are console-signed
 * instead). Presigning is a local SigV4 computation — no network call is
 * made, and the key need not already exist for this to succeed (a caller
 * fetching the returned URL for a key nothing was ever `putArtifact`'d to
 * simply gets S3/minio's own 404, not an error from this function). Throws
 * under the same missing-config condition as {@link putArtifact} — see
 * {@link resolveS3Config}.
 *
 * `ttlSeconds` (including the default) is clamped to
 * {@link MAX_SIGV4_PRESIGN_TTL_SECONDS} — see that constant's own
 * doc-comment for why the interface's literal 30-day default cannot reach
 * the AWS SDK unclamped.
 */
export async function signedGetUrl(
  key: string,
  ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS
): Promise<string> {
  const { client, bucket } = resolveS3();
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client, command, { expiresIn: clampPresignTtl(ttlSeconds) });
}

/**
 * Clamps to `[1, MAX_SIGV4_PRESIGN_TTL_SECONDS]` — see that constant's own
 * doc-comment. Logs once (never throws) when the requested value had to be
 * lowered, so a caller asking for more than SigV4 can grant is visible in
 * server logs rather than silently getting a shorter-lived link than it
 * thinks it has.
 */
function clampPresignTtl(ttlSeconds: number): number {
  const clamped = Math.max(1, Math.min(ttlSeconds, MAX_SIGV4_PRESIGN_TTL_SECONDS));
  if (clamped !== ttlSeconds) {
    console.warn(
      `[lib/artifacts/store] requested signed-URL ttlSeconds=${ttlSeconds} exceeds SigV4's ` +
        `${MAX_SIGV4_PRESIGN_TTL_SECONDS}s (7-day) ceiling for static credentials — clamped to ${clamped}s.`
    );
  }
  return clamped;
}

/**
 * The `artifactKey` scheme's structured input — see {@link artifactKey}.
 */
export interface ArtifactKeyInput {
  workspaceId: string;
  /** `owner/name` — the literal `/` is sanitized to `__`, see {@link artifactKey}. */
  repo: string;
  prNumber: number;
  headSha: string;
  acId: string;
  /** The per-AC image counter — 1-based; must be a positive integer ("n" in the scheme below). */
  index: number;
  /** File extension WITHOUT a leading dot (e.g. `"png"`, not `".png"`). */
  ext: string;
}

/**
 * Builds an artifact key under the EXACT scheme pinned by owner ruling #1564
 * (design doc §1):
 *
 *   `review-evidence/<workspaceId>/<owner__name>/<prNumber>/<headSha>/<acId>/<n>.<ext>`
 *
 * `repo`'s `/` (the `owner/name` separator) is sanitized to `__` — the ONLY
 * transformation this function applies; every other segment is used
 * verbatim. Pure and synchronous: no env access, no I/O, safe to call with
 * no `S3_*` config present at all.
 *
 * THROWS (traversal-hostile inputs — unit-tested, `store.test.ts`) on:
 *   - any segment containing `".."` (repo, workspaceId, headSha, acId, ext,
 *     OR the constructed `<n>.<ext>` filename — see below) — checked on
 *     `repo` BEFORE the `/`→`__` substitution: that substitution can never
 *     itself CREATE a new `".."` (it only replaces a `/` with a
 *     2-character, non-dot separator, which can't bring two pre-existing
 *     dots together), so a single pre-sanitize check on `repo` is complete,
 *     not merely a spot-check.
 *   - any of `workspaceId` / `repo` / `headSha` / `acId` / `ext` being empty
 *     or whitespace-only.
 *   - `prNumber` or `index` (the scheme's `n`) not being a positive integer.
 *   - (hardening beyond the three cases above, same "traversal-hostile"
 *     spirit) a stray `/` in `workspaceId` / `headSha` / `acId` / `ext` —
 *     `repo` is the ONLY field this scheme documents as slash-bearing; a
 *     slash anywhere else would silently splice extra path components into
 *     the key rather than raising anything, which is exactly the kind of
 *     silent corruption the traversal checks above exist to rule out.
 *   - the CONSTRUCTED `<n>.<ext>` filename containing `".."` even when
 *     `ext` alone does not — e.g. a caller mistakenly passing a leading dot
 *     (`ext: ".png"` instead of `"png"`) joins with `index` to form
 *     `"1..png"`, which the plain per-field check on `ext` alone would miss
 *     (`".png"` contains no `".."` by itself). Checked on the joined string
 *     so this realistic caller mistake is caught rather than silently
 *     producing a malformed-looking key.
 */
export function artifactKey(input: ArtifactKeyInput): string {
  const { workspaceId, repo, prNumber, headSha, acId, index, ext } = input;

  assertSafeSegment("workspaceId", workspaceId);
  assertSafeSegment("repo", repo, { allowSlash: true });
  assertSafeSegment("headSha", headSha);
  assertSafeSegment("acId", acId);
  assertSafeSegment("ext", ext);
  assertPositiveInteger("prNumber", prNumber);
  assertPositiveInteger("index", index);

  const sanitizedRepo = repo.replace(/\//g, "__");
  const filename = `${index}.${ext}`;
  if (filename.includes("..")) {
    // See the doc-comment above ("the CONSTRUCTED <n>.<ext> filename...").
    throw new Error(`artifactKey: constructed filename must not contain "..": ${filename}`);
  }

  return `review-evidence/${workspaceId}/${sanitizedRepo}/${prNumber}/${headSha}/${acId}/${filename}`;
}

function assertSafeSegment(
  name: string,
  value: string,
  opts: { allowSlash?: boolean } = {}
): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`artifactKey: ${name} must not be empty`);
  }
  if (value.includes("..")) {
    throw new Error(`artifactKey: ${name} must not contain "..": ${value}`);
  }
  if (!opts.allowSlash && value.includes("/")) {
    throw new Error(`artifactKey: ${name} must not contain "/": ${value}`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`artifactKey: ${name} must be a positive integer, got ${value}`);
  }
}
