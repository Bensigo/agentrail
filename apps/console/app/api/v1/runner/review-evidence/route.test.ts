import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getChatIdentityById: vi.fn(),
  getRepositoryByName: vi.fn(),
}));
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  getRepositoryByName,
} from "@agentrail/db-postgres";

// Only the I/O-touching functions are mocked — `artifactKey` and
// `storageConfigured` are both pure (no network/S3 client involved) and stay
// REAL here via `importOriginal`, so every happy-path test below exercises
// the actual key-building contract end to end through the route, not a
// stand-in (per the task brief: "keep at least one test that exercises the
// real artifactKey"). `storageConfigured` stays real too so the flag-gate
// tests below can toggle it via plain env vars, the same way a real deploy
// would.
vi.mock("../../../../../lib/artifacts/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../lib/artifacts/store")>();
  return {
    ...actual,
    putArtifact: vi.fn(),
    signedGetUrl: vi.fn(),
  };
});
import { GET, POST } from "./route";
import { artifactKey } from "../../../../../lib/artifacts/store";
import { putArtifact, signedGetUrl } from "../../../../../lib/artifacts/store";

const NOW = new Date("2026-08-02T00:00:00.000Z");

// Central-secret auth — same idiom as pr-review/route.test.ts.
const AUTH_ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const FLAG_ENV_KEY = "REVIEW_EVIDENCE_ENABLED";

const S3_ENV_KEYS = ["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};

function saveEnv(keys: readonly string[]) {
  for (const k of keys) ORIGINAL_ENV[k] = process.env[k];
}

function restoreEnv(keys: readonly string[]) {
  for (const k of keys) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
}

const ALL_ENV_KEYS = [AUTH_ENV_KEY, FLAG_ENV_KEY, ...S3_ENV_KEYS];

function postReq(body?: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/review-evidence", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function getReq(qs: Record<string, string>, withAuth = true): NextRequest {
  const params = new URLSearchParams(qs);
  return new NextRequest(
    `http://localhost/api/v1/runner/review-evidence?${params.toString()}`,
    { method: "GET", headers: withAuth ? { Authorization: `Bearer ${SECRET}` } : {} }
  );
}

const PINNED_SESSION = {
  id: "session-1",
  workspaceId: "ws-1",
  chatIdentityId: "chat-identity-1",
  channel: "telegram",
  conversationKey: "tg-chat-42",
  eveSessionId: "eve-session-1",
  status: "active",
  lastActivityAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

const BOUND_IDENTITY = {
  id: "chat-identity-1",
  platform: "telegram",
  platformUserId: "tg-123",
  displayName: "Ada",
  userId: "user-1",
  workspaceId: "ws-1",
  linkToken: null,
  linkTokenExpiresAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const CONNECTED_REPO = {
  id: "repo-1",
  workspaceId: "ws-1",
  name: "ada/widgets",
  url: "https://github.com/ada/widgets",
  defaultBranch: "main",
  createdAt: NOW,
  updatedAt: NOW,
};

const VALID_BODY = {
  eveSessionId: "eve-session-1",
  repo: "ada/widgets",
  prNumber: 98,
  headSha: "deadbeefcafe",
  acId: "AC3",
  index: 2,
  imageBase64: Buffer.from("fake-image-bytes").toString("base64"),
  contentType: "image/png",
};

const EXPECTED_HAPPY_KEY = artifactKey({
  workspaceId: "ws-1",
  repo: "ada/widgets",
  prNumber: 98,
  headSha: "deadbeefcafe",
  acId: "AC3",
  index: 2,
  ext: "png",
});

beforeEach(() => {
  vi.clearAllMocks();
  saveEnv(ALL_ENV_KEYS);
  process.env[AUTH_ENV_KEY] = SECRET;
  process.env[FLAG_ENV_KEY] = "1";
  process.env.S3_ENDPOINT = "http://localhost:9000";
  process.env.S3_ACCESS_KEY = "agentrail";
  process.env.S3_SECRET_KEY = "agentrail123";
  process.env.S3_BUCKET = "agentrail-artifacts";

  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(PINNED_SESSION as never);
  vi.mocked(getChatIdentityById).mockResolvedValue(BOUND_IDENTITY as never);
  vi.mocked(getRepositoryByName).mockResolvedValue(CONNECTED_REPO as never);
  vi.mocked(putArtifact).mockResolvedValue(undefined);
  vi.mocked(signedGetUrl).mockResolvedValue("https://signed.example.com/evidence-url");
});

afterEach(() => {
  restoreEnv(ALL_ENV_KEYS);
});

// ---------------------------------------------------------------------------
// POST /api/v1/runner/review-evidence
// ---------------------------------------------------------------------------

describe("POST /api/v1/runner/review-evidence", () => {
  // -------------------------------------------------------------------------
  // auth — checked first, before the flag, before anything else
  // -------------------------------------------------------------------------

  it("401 when no Authorization header is sent, and never touches the flag/session/store", async () => {
    process.env[FLAG_ENV_KEY] = "0"; // flag OFF too — proves auth wins the race
    const res = await POST(postReq(VALID_BODY, false));
    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(putArtifact).not.toHaveBeenCalled();
  });

  it("401 when JACE_CONSOLE_TOKEN is unset (fail closed)", async () => {
    delete process.env[AUTH_ENV_KEY];
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it("401 on a wrong secret", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/v1/runner/review-evidence", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer wrong-secret" },
        body: JSON.stringify(VALID_BODY),
      })
    );
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // flag — checked AFTER auth
  // -------------------------------------------------------------------------

  it('503 {error:"evidence storage not enabled"} when REVIEW_EVIDENCE_ENABLED is unset', async () => {
    delete process.env[FLAG_ENV_KEY];
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "evidence storage not enabled" });
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it('503 when REVIEW_EVIDENCE_ENABLED is set to something other than "1"', async () => {
    process.env[FLAG_ENV_KEY] = "true";
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "evidence storage not enabled" });
  });

  it("503 with the same message when the flag is on but S3_* config is incomplete (storageConfigured's own pre-flight)", async () => {
    delete process.env.S3_BUCKET;
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "evidence storage not enabled" });
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // body validation (400) — before any DB call
  // -------------------------------------------------------------------------

  it("400 on invalid JSON", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/v1/runner/review-evidence", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` },
        body: "{not valid json",
      })
    );
    expect(res.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when any required field is missing", async () => {
    for (const field of [
      "eveSessionId",
      "repo",
      "prNumber",
      "headSha",
      "acId",
      "index",
      "imageBase64",
      "contentType",
    ] as const) {
      const bad = { ...VALID_BODY };
      delete (bad as Record<string, unknown>)[field];
      const res = await POST(postReq(bad));
      expect(res.status, `field ${field} missing should 400`).toBe(400);
    }
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when a string field is empty/blank", async () => {
    for (const field of ["eveSessionId", "repo", "headSha", "acId", "imageBase64", "contentType"] as const) {
      const res = await POST(postReq({ ...VALID_BODY, [field]: "   " }));
      expect(res.status, `blank ${field} should 400`).toBe(400);
    }
  });

  it("400 when prNumber is zero, negative, or non-integer", async () => {
    for (const prNumber of [0, -1, 1.5]) {
      const res = await POST(postReq({ ...VALID_BODY, prNumber }));
      expect(res.status).toBe(400);
    }
  });

  it("400 when index is not a number at all (wrong type)", async () => {
    for (const index of ["2", null, true, {}]) {
      const res = await POST(postReq({ ...VALID_BODY, index }));
      expect(res.status, `index=${JSON.stringify(index)} should 400`).toBe(400);
    }
  });

  // -------------------------------------------------------------------------
  // session chain resolution — SAME chain as pr-review, minus the GitHub token
  // -------------------------------------------------------------------------

  it('404 "Session not found" when no jace_sessions row is bound to this eveSessionId', async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Session not found" });
  });

  it("resolves a workspace-anchored, identity-less session (Arc B review-job worker) and reaches the happy path without calling getChatIdentityById", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...PINNED_SESSION,
      chatIdentityId: null,
    } as never);

    const res = await POST(postReq(VALID_BODY));

    expect(res.status).toBe(200);
    expect(getChatIdentityById).not.toHaveBeenCalled();
    expect(getRepositoryByName).toHaveBeenCalledWith("ws-1", "ada/widgets");
  });

  it("409 when neither the session nor the identity has a workspace", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...PINNED_SESSION,
      workspaceId: null,
    } as never);
    vi.mocked(getChatIdentityById).mockResolvedValue({ ...BOUND_IDENTITY, workspaceId: null } as never);

    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "this conversation has no workspace yet — create one first",
    });
    expect(getRepositoryByName).not.toHaveBeenCalled();
  });

  it('404 "repo not connected to this workspace" when the repo is not connected — never proxies an arbitrary repo', async () => {
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "repo not connected to this workspace" });
    expect(getRepositoryByName).toHaveBeenCalledWith("ws-1", "ada/widgets");
    expect(putArtifact).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // contentType allowlist (415)
  // -------------------------------------------------------------------------

  it("415 when contentType is not image/png or image/jpeg", async () => {
    for (const contentType of ["image/gif", "application/pdf", "text/plain", "image/PNG"]) {
      const res = await POST(postReq({ ...VALID_BODY, contentType }));
      expect(res.status, `contentType=${contentType} should 415`).toBe(415);
    }
    expect(putArtifact).not.toHaveBeenCalled();
  });

  it("accepts image/jpeg (not just image/png)", async () => {
    const res = await POST(
      postReq({ ...VALID_BODY, contentType: "image/jpeg" })
    );
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // decoded size cap (413) — decode once, measure Buffer.length
  // -------------------------------------------------------------------------

  it("413 when the decoded image exceeds the 2MB cap", async () => {
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 1).toString("base64");
    const res = await POST(postReq({ ...VALID_BODY, imageBase64: oversized }));
    expect(res.status).toBe(413);
    expect(putArtifact).not.toHaveBeenCalled();
  });

  it("allows an image at exactly the 2MB boundary", async () => {
    const exact = Buffer.alloc(2 * 1024 * 1024, 1).toString("base64");
    const res = await POST(postReq({ ...VALID_BODY, imageBase64: exact }));
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // index range (422) — caller-counted v1
  // -------------------------------------------------------------------------

  it("422 when index is outside 1..4", async () => {
    for (const index of [0, -1, 5, 100, 2.5]) {
      const res = await POST(postReq({ ...VALID_BODY, index }));
      expect(res.status, `index=${index} should 422`).toBe(422);
    }
    expect(putArtifact).not.toHaveBeenCalled();
  });

  it("accepts every boundary index value (1 and 4)", async () => {
    for (const index of [1, 4]) {
      const res = await POST(postReq({ ...VALID_BODY, index }));
      expect(res.status, `index=${index} should 200`).toBe(200);
    }
  });

  // -------------------------------------------------------------------------
  // happy path — artifactKey (REAL) -> putArtifact -> signedGetUrl -> 200
  // -------------------------------------------------------------------------

  it("200 {key, url}: builds the key via the real artifactKey, calls putArtifact with the decoded bytes, and signs the URL", async () => {
    const res = await POST(postReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ key: EXPECTED_HAPPY_KEY, url: "https://signed.example.com/evidence-url" });

    expect(putArtifact).toHaveBeenCalledTimes(1);
    const [key, bytes, contentType] = vi.mocked(putArtifact).mock.calls[0]!;
    expect(key).toBe(EXPECTED_HAPPY_KEY);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect((bytes as Buffer).equals(Buffer.from(VALID_BODY.imageBase64, "base64"))).toBe(true);
    expect(contentType).toBe("image/png");

    expect(signedGetUrl).toHaveBeenCalledWith(EXPECTED_HAPPY_KEY);
  });

  it("maps contentType image/png to a .png extension and image/jpeg to .jpeg in the real key", async () => {
    await POST(postReq({ ...VALID_BODY, contentType: "image/png" }));
    expect(vi.mocked(putArtifact).mock.calls[0]![0]).toMatch(/\.png$/);

    vi.mocked(putArtifact).mockClear();
    await POST(postReq({ ...VALID_BODY, contentType: "image/jpeg" }));
    expect(vi.mocked(putArtifact).mock.calls[0]![0]).toMatch(/\.jpeg$/);
  });

  // -------------------------------------------------------------------------
  // artifactKey rejects hostile caller input (defensive: never let the
  // synchronous throw inside artifactKey escape as an unhandled 500)
  // -------------------------------------------------------------------------

  it("400 when a caller-controlled field is traversal-hostile and the real artifactKey rejects it", async () => {
    const res = await POST(postReq({ ...VALID_BODY, headSha: "..deadbeef" }));
    expect(res.status).toBe(400);
    expect(putArtifact).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // store failure (500) — never leak the raw thrown message
  // -------------------------------------------------------------------------

  it("500 when putArtifact throws, without leaking the raw error message", async () => {
    vi.mocked(putArtifact).mockRejectedValueOnce(
      new Error(
        "[lib/artifacts/store] artifact store is not configured — missing required env var(s): S3_ENDPOINT"
      )
    );
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("S3_ENDPOINT");
    expect(text).not.toContain("missing required env var");
    const json = JSON.parse(text);
    expect(typeof json.error).toBe("string");
    expect(json.error.length).toBeGreaterThan(0);
  });

  it("500 when signedGetUrl throws after a successful putArtifact, without leaking the raw error message", async () => {
    vi.mocked(signedGetUrl).mockRejectedValueOnce(new Error("some internal SDK detail"));
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("some internal SDK detail");
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/runner/review-evidence?key=&eveSessionId=
// ---------------------------------------------------------------------------

describe("GET /api/v1/runner/review-evidence", () => {
  const VALID_KEY = artifactKey({
    workspaceId: "ws-1",
    repo: "ada/widgets",
    prNumber: 98,
    headSha: "deadbeefcafe",
    acId: "AC3",
    index: 1,
    ext: "png",
  });

  it("401 when no Authorization header is sent, and never touches the flag/session/store", async () => {
    process.env[FLAG_ENV_KEY] = "0";
    const res = await GET(getReq({ eveSessionId: "eve-session-1", key: VALID_KEY }, false));
    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(signedGetUrl).not.toHaveBeenCalled();
  });

  it("401 when JACE_CONSOLE_TOKEN is unset", async () => {
    delete process.env[AUTH_ENV_KEY];
    const res = await GET(getReq({ eveSessionId: "eve-session-1", key: VALID_KEY }));
    expect(res.status).toBe(401);
  });

  it('503 {error:"evidence storage not enabled"} when the flag is off', async () => {
    delete process.env[FLAG_ENV_KEY];
    const res = await GET(getReq({ eveSessionId: "eve-session-1", key: VALID_KEY }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "evidence storage not enabled" });
  });

  it("400 when key is missing", async () => {
    const res = await GET(getReq({ eveSessionId: "eve-session-1" }));
    expect(res.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when eveSessionId is missing", async () => {
    const res = await GET(getReq({ key: VALID_KEY }));
    expect(res.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it('404 "Session not found" when no session is bound to this eveSessionId', async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
    const res = await GET(getReq({ eveSessionId: "unknown", key: VALID_KEY }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Session not found" });
  });

  it("resolves an identity-less session (chatIdentityId null) for the ownership check without calling getChatIdentityById", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...PINNED_SESSION,
      chatIdentityId: null,
    } as never);
    const res = await GET(getReq({ eveSessionId: "eve-session-1", key: VALID_KEY }));
    expect(res.status).toBe(200);
    expect(getChatIdentityById).not.toHaveBeenCalled();
  });

  it("403 when the key's embedded workspaceId does not match the session's resolved workspace", async () => {
    const otherWorkspaceKey = artifactKey({
      workspaceId: "some-other-workspace",
      repo: "ada/widgets",
      prNumber: 98,
      headSha: "deadbeefcafe",
      acId: "AC3",
      index: 1,
      ext: "png",
    });
    const res = await GET(getReq({ eveSessionId: "eve-session-1", key: otherWorkspaceKey }));
    expect(res.status).toBe(403);
    expect(signedGetUrl).not.toHaveBeenCalled();
  });

  it("403 on a malformed key that doesn't even carry the review-evidence prefix (fails closed, no distinct error)", async () => {
    const res = await GET(getReq({ eveSessionId: "eve-session-1", key: "not-an-artifact-key" }));
    expect(res.status).toBe(403);
    expect(signedGetUrl).not.toHaveBeenCalled();
  });

  it("200 {url}: re-signs a key owned by the caller's own workspace", async () => {
    vi.mocked(signedGetUrl).mockResolvedValue("https://signed.example.com/re-signed-url");
    const res = await GET(getReq({ eveSessionId: "eve-session-1", key: VALID_KEY }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://signed.example.com/re-signed-url" });
    expect(signedGetUrl).toHaveBeenCalledWith(VALID_KEY);
  });

  it("500 when signedGetUrl throws, without leaking the raw error message", async () => {
    vi.mocked(signedGetUrl).mockRejectedValueOnce(new Error("minio said no, credentials rotated"));
    const res = await GET(getReq({ eveSessionId: "eve-session-1", key: VALID_KEY }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("credentials rotated");
  });
});
