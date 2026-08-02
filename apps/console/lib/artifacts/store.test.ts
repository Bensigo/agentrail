import {
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  artifactKey,
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  putArtifact,
  signedGetUrl,
  storageConfigured,
} from "./store";

// Captured at module load — BEFORE vitest.setup.ts's per-test `beforeEach`
// can stub `fetch` (setupFiles' hooks are registered when that module loads,
// but the stub itself only takes effect once a `beforeEach` actually RUNS,
// which happens after every test file has finished this top-level pass).
// The minio-integration block below restores this real implementation in
// its own `beforeEach`, mirroring the exact pattern vitest.setup.ts's own
// doc-comment describes for tests that need real fetch behavior.
const realFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// artifactKey — pure, no env/network required. TDD step 1 per the task brief.
// ---------------------------------------------------------------------------

const VALID_INPUT = {
  workspaceId: "ws_123",
  repo: "agentrail/console",
  prNumber: 42,
  headSha: "deadbeefcafe",
  acId: "AC3",
  index: 1,
  ext: "png",
};

describe("artifactKey", () => {
  it("builds the exact key scheme with repo's '/' sanitized to '__'", () => {
    expect(artifactKey(VALID_INPUT)).toBe(
      "review-evidence/ws_123/agentrail__console/42/deadbeefcafe/AC3/1.png"
    );
  });

  it("sanitizes every '/' in repo, not just the first", () => {
    const key = artifactKey({ ...VALID_INPUT, repo: "a/b/c" });
    expect(key).toBe("review-evidence/ws_123/a__b__c/42/deadbeefcafe/AC3/1.png");
  });

  it("is pure — needs no S3_* env vars set to produce a key", () => {
    const saved = { ...process.env };
    for (const k of ["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"]) {
      delete process.env[k];
    }
    try {
      expect(() => artifactKey(VALID_INPUT)).not.toThrow();
    } finally {
      process.env = saved;
    }
  });

  it("renders a different index/ext independently", () => {
    expect(artifactKey({ ...VALID_INPUT, index: 4, ext: "jpg" })).toBe(
      "review-evidence/ws_123/agentrail__console/42/deadbeefcafe/AC3/4.jpg"
    );
  });

  // --- hostile inputs: ".." -------------------------------------------------

  it("throws when repo contains '..' (traversal via owner segment)", () => {
    expect(() => artifactKey({ ...VALID_INPUT, repo: "../etc" })).toThrow();
  });

  it("throws when repo contains '..' (traversal appended after a real repo)", () => {
    expect(() => artifactKey({ ...VALID_INPUT, repo: "agentrail/console/.." })).toThrow();
  });

  it("throws when workspaceId contains '..'", () => {
    expect(() => artifactKey({ ...VALID_INPUT, workspaceId: ".." })).toThrow();
  });

  it("throws when headSha contains '..'", () => {
    expect(() => artifactKey({ ...VALID_INPUT, headSha: "..deadbeef" })).toThrow();
  });

  it("throws when acId contains '..'", () => {
    expect(() => artifactKey({ ...VALID_INPUT, acId: "AC..3" })).toThrow();
  });

  it("throws when ext contains '..' (e.g. a caller mistakenly passing a leading dot)", () => {
    expect(() => artifactKey({ ...VALID_INPUT, ext: ".png" })).toThrow();
  });

  // --- hostile inputs: empty segments ---------------------------------------

  it("throws on empty workspaceId", () => {
    expect(() => artifactKey({ ...VALID_INPUT, workspaceId: "" })).toThrow();
  });

  it("throws on empty repo", () => {
    expect(() => artifactKey({ ...VALID_INPUT, repo: "" })).toThrow();
  });

  it("throws on empty headSha", () => {
    expect(() => artifactKey({ ...VALID_INPUT, headSha: "" })).toThrow();
  });

  it("throws on empty acId", () => {
    expect(() => artifactKey({ ...VALID_INPUT, acId: "" })).toThrow();
  });

  it("throws on empty ext", () => {
    expect(() => artifactKey({ ...VALID_INPUT, ext: "" })).toThrow();
  });

  it("throws on a whitespace-only segment (effectively empty)", () => {
    expect(() => artifactKey({ ...VALID_INPUT, acId: "   " })).toThrow();
  });

  // --- hostile inputs: non-positive n (index) -------------------------------

  it("throws on index = 0", () => {
    expect(() => artifactKey({ ...VALID_INPUT, index: 0 })).toThrow();
  });

  it("throws on negative index", () => {
    expect(() => artifactKey({ ...VALID_INPUT, index: -1 })).toThrow();
  });

  it("throws on a non-integer index", () => {
    expect(() => artifactKey({ ...VALID_INPUT, index: 1.5 })).toThrow();
  });

  // --- prNumber gets the same positive-integer discipline as index ---------

  it("throws on prNumber = 0", () => {
    expect(() => artifactKey({ ...VALID_INPUT, prNumber: 0 })).toThrow();
  });

  it("throws on negative prNumber", () => {
    expect(() => artifactKey({ ...VALID_INPUT, prNumber: -7 })).toThrow();
  });

  it("throws on a non-integer prNumber", () => {
    expect(() => artifactKey({ ...VALID_INPUT, prNumber: 3.14 })).toThrow();
  });

  // --- extra hardening beyond the brief's three named cases: a stray '/' in
  // a non-repo segment would silently splice in extra path components. -----

  it("throws when workspaceId contains a stray '/'", () => {
    expect(() => artifactKey({ ...VALID_INPUT, workspaceId: "ws/123" })).toThrow();
  });

  it("throws when headSha contains a stray '/'", () => {
    expect(() => artifactKey({ ...VALID_INPUT, headSha: "dead/beef" })).toThrow();
  });

  it("throws when acId contains a stray '/'", () => {
    expect(() => artifactKey({ ...VALID_INPUT, acId: "AC3/x" })).toThrow();
  });

  it("throws when ext contains a stray '/'", () => {
    expect(() => artifactKey({ ...VALID_INPUT, ext: "p/ng" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// storageConfigured — pure presence check over an injected env object.
// ---------------------------------------------------------------------------

const FULL_ENV: Record<string, string | undefined> = {
  S3_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "agentrail",
  S3_SECRET_KEY: "agentrail123",
  S3_BUCKET: "agentrail-artifacts",
};

describe("storageConfigured", () => {
  it("is true when all four S3_* vars are present", () => {
    expect(storageConfigured(FULL_ENV)).toBe(true);
  });

  it("is true even without the optional S3_REGION set", () => {
    expect(storageConfigured({ ...FULL_ENV })).toBe(true);
    expect(FULL_ENV.S3_REGION).toBeUndefined();
  });

  for (const missingKey of ["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"] as const) {
    it(`is false when ${missingKey} is missing`, () => {
      const env = { ...FULL_ENV };
      delete env[missingKey];
      expect(storageConfigured(env)).toBe(false);
    });

    it(`is false when ${missingKey} is an empty string`, () => {
      expect(storageConfigured({ ...FULL_ENV, [missingKey]: "" })).toBe(false);
    });
  }

  it("is false against a wholly empty env", () => {
    expect(storageConfigured({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// putArtifact / signedGetUrl — config guard. No network involved: both
// functions must throw/reject BEFORE ever constructing an S3 client when a
// required S3_* var is missing (the future runner route turns this into its
// 500 path; storageConfigured is its own 503-before-trying gate).
// ---------------------------------------------------------------------------

const S3_ENV_KEYS = ["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET", "S3_REGION"] as const;

describe("putArtifact / signedGetUrl — throw when S3_* config is missing", () => {
  let saved: Partial<Record<(typeof S3_ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    saved = {};
    for (const k of S3_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of S3_ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("putArtifact rejects when every S3_* var is unset", async () => {
    await expect(putArtifact("some/key.png", Buffer.from("x"), "image/png")).rejects.toThrow();
  });

  it("signedGetUrl rejects when every S3_* var is unset", async () => {
    await expect(signedGetUrl("some/key.png")).rejects.toThrow();
  });

  it("putArtifact rejects when only S3_BUCKET is missing", async () => {
    process.env.S3_ENDPOINT = "http://localhost:9000";
    process.env.S3_ACCESS_KEY = "agentrail";
    process.env.S3_SECRET_KEY = "agentrail123";
    // S3_BUCKET deliberately left unset.
    await expect(putArtifact("some/key.png", Buffer.from("x"), "image/png")).rejects.toThrow();
  });

  it("the rejection message names the missing var(s), never a secret value", async () => {
    process.env.S3_ENDPOINT = "http://localhost:9000";
    process.env.S3_ACCESS_KEY = "agentrail";
    process.env.S3_SECRET_KEY = "agentrail123";
    await expect(putArtifact("k", Buffer.from("x"), "image/png")).rejects.toThrow(/S3_BUCKET/);
  });
});

// ---------------------------------------------------------------------------
// signedGetUrl — TTL contract. Presigning (SigV4) is a local computation, no
// network call — safe to assert the query string shape without minio up.
// ---------------------------------------------------------------------------

describe("signedGetUrl — TTL contract (no network — presigning is local)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.S3_ENDPOINT = "http://localhost:9000";
    process.env.S3_ACCESS_KEY = "agentrail";
    process.env.S3_SECRET_KEY = "agentrail123";
    process.env.S3_BUCKET = "agentrail-artifacts";
    delete process.env.S3_REGION;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("the exported default constant is the brief's exact pinned value, 2,592,000s (30 days)", () => {
    // This is the INTERFACE contract (the default parameter value) — see the
    // next test for what actually reaches the signed URL, which is lower.
    expect(DEFAULT_SIGNED_URL_TTL_SECONDS).toBe(2_592_000);
  });

  it("clamps the 30-day default down to SigV4's 604,800s (7-day) ceiling for static credentials", async () => {
    // CONFIRMED via AWS docs (ShareObjectPreSignedURL.html: "X-Amz-Expires
    // ... Range: 1 - 604800") and the AWS SDK's own thrown error when this
    // clamp is removed ("Signature version 4 presigned URLs must have an
    // expiration date less than one week in the future") — a real protocol
    // ceiling, not a choice. See the module doc-comment,
    // MAX_SIGV4_PRESIGN_TTL_SECONDS.
    const url = await signedGetUrl("review-evidence/ws/o__r/1/sha/AC1/1.png");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("604800");
  });

  it("honors a caller-supplied ttlSeconds that is within the SigV4 ceiling", async () => {
    const url = await signedGetUrl("review-evidence/ws/o__r/1/sha/AC1/1.png", 60);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("60");
  });

  it("clamps an explicit caller-supplied ttlSeconds that also exceeds the ceiling", async () => {
    const url = await signedGetUrl("review-evidence/ws/o__r/1/sha/AC1/1.png", 999_999);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("604800");
  });

  it("warns (does not throw) when a requested ttlSeconds gets clamped", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await signedGetUrl("review-evidence/ws/o__r/1/sha/AC1/1.png", 999_999);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0].join(" ")).toContain("999999");
    warnSpy.mockRestore();
  });

  it("does NOT warn when the requested ttlSeconds is already within the ceiling", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await signedGetUrl("review-evidence/ws/o__r/1/sha/AC1/1.png", 60);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("signs against the configured bucket/key path (path-style, forcePathStyle)", async () => {
    const url = await signedGetUrl("review-evidence/ws/o__r/1/sha/AC1/1.png");
    const parsed = new URL(url);
    // forcePathStyle: true (dev minio requires it) -> /<bucket>/<key>, not
    // <bucket>.<host>/<key> — see the module doc-comment.
    expect(parsed.pathname).toBe(
      "/agentrail-artifacts/review-evidence/ws/o__r/1/sha/AC1/1.png"
    );
  });
});

// ---------------------------------------------------------------------------
// Real client integration — the dev-compose minio (endpoint :9000, bucket
// agentrail-artifacts, creds from docker-compose.yml's minio service).
// Reachability is probed ONCE at module load so this whole block skips
// cleanly wherever minio isn't running (CI's console job does not currently
// run this file at all — see .github/workflows/ci.yml's "node" job, whose
// console step is scoped to one route — but this must degrade gracefully
// regardless of that, and does).
// ---------------------------------------------------------------------------

const MINIO_ENDPOINT = "http://localhost:9000";
const MINIO_ACCESS_KEY = "agentrail";
const MINIO_SECRET_KEY = "agentrail123";
const MINIO_BUCKET = "agentrail-artifacts";

async function probeMinioReachable(): Promise<boolean> {
  try {
    const res = await realFetch(`${MINIO_ENDPOINT}/minio/health/live`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Top-level await: vitest/Vite transforms test files as ESM, which supports
// this at module scope, and it runs during file collection — strictly before
// any beforeEach hook (global or local) fires for a test in this file.
const minioReachable = await probeMinioReachable();

if (!minioReachable) {
  console.warn(
    "[store.test.ts] minio not reachable at http://localhost:9000 — skipping the real put+presign round-trip integration test. Run `docker compose up minio minio-init` to exercise it."
  );
}

describe.skipIf(!minioReachable)("putArtifact + signedGetUrl — minio integration", () => {
  const TEST_KEY = artifactKey({
    workspaceId: "test-workspace",
    repo: "test-owner/test-repo",
    prNumber: 1,
    headSha: "deadbeefcafe0000000000000000000000000000",
    acId: "AC1",
    index: 1,
    ext: "txt",
  });
  const TEST_BODY = `hello artifact store — ${Date.now()}`;

  beforeEach(() => {
    process.env.S3_ENDPOINT = MINIO_ENDPOINT;
    process.env.S3_ACCESS_KEY = MINIO_ACCESS_KEY;
    process.env.S3_SECRET_KEY = MINIO_SECRET_KEY;
    process.env.S3_BUCKET = MINIO_BUCKET;
    delete process.env.S3_REGION;
    // Undo vitest.setup.ts's global fetch stub for THIS file's tests — this
    // integration suite needs a REAL fetch to hit minio and read back the
    // presigned URL's bytes. Mirrors the exact pattern that file's own
    // doc-comment prescribes ("call vi.stubGlobal('fetch', ...) again in
    // their OWN beforeEach — ... a test file's more specific stub ... wins").
    vi.stubGlobal("fetch", realFetch);
  });

  afterAll(async () => {
    // Test hygiene: delete the object this suite wrote so repeated local
    // runs don't accumulate objects in the dev minio bucket. A raw client,
    // not this module's own putArtifact/signedGetUrl (which have no delete
    // operation in their public contract) — best-effort only.
    const client = new S3Client({
      endpoint: MINIO_ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY },
    });
    await client.send(new DeleteObjectCommand({ Bucket: MINIO_BUCKET, Key: TEST_KEY })).catch(() => {
      // Never fail the suite over best-effort cleanup.
    });
  });

  it("puts an object, then signedGetUrl's presigned link fetches the same bytes back", async () => {
    await putArtifact(TEST_KEY, Buffer.from(TEST_BODY, "utf-8"), "text/plain");

    const url = await signedGetUrl(TEST_KEY, 60);
    const res = await fetch(url);
    expect(res.ok).toBe(true);
    const text = await res.text();
    expect(text).toBe(TEST_BODY);
  });

  it("presigns a never-written key too (signing is local) — fetching it predictably 404s from minio, not from a bug here", async () => {
    const url = await signedGetUrl(`${TEST_KEY}.never-written`, 60);
    const res = await fetch(url);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });
});
