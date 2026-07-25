import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { NextRequest } from "next/server";

// The route resolves the delivering repo's workspace + github connector to find
// the per-workspace webhook secret (#1233), so we mock the three DB helpers but
// keep the rest of the barrel real (same pattern as the jace inbound tests).
vi.mock("@agentrail/db-postgres", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@agentrail/db-postgres")
  >();
  return {
    ...actual,
    findWorkspaceByRepo: vi.fn(),
    getConnector: vi.fn(),
    enqueueGithubIssue: vi.fn(),
    // push-recompile: the tests below keep AGENTRAIL_WIKI_RECOMPILE_ON_PUSH
    // unset (default OFF), so `handlePush` short-circuits on the flag check
    // before ever calling these — mocked purely so `importOriginal`'s real
    // implementations (which touch a real DB) are never wired in, matching
    // the pattern already used for the three helpers above.
    getRepositoryByName: vi.fn(),
    enqueueOnboard: vi.fn(),
    findOnboardEntryStatus: vi.fn(),
  };
});

// The merged route (post-#1274) posts an alignment brief when an admit parks for
// alignment, and sweeps for stale briefs via reconcileAlignmentBriefs() on every
// successful enqueue. Both are orthogonal to signature verification (all this
// file tests) and — because the db-postgres mock above keeps the rest of the
// barrel real — would otherwise reach a real DB. Stub the reconciler module so
// these signature tests stay isolated from the #1274 machinery (which has its
// own coverage in route.test.ts).
vi.mock("../../../../../../lib/alignment-reconciler", () => ({
  postAlignmentBrief: vi.fn().mockResolvedValue("posted"),
  reconcileAlignmentBriefs: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "./route";
import {
  findWorkspaceByRepo,
  getConnector,
  enqueueGithubIssue,
} from "@agentrail/db-postgres";

const mockFindWorkspaceByRepo = vi.mocked(findWorkspaceByRepo);
const mockGetConnector = vi.mocked(getConnector);
const mockEnqueue = vi.mocked(enqueueGithubIssue);

const WS = "ws-1";
const REPO = "acme/widgets";
const WS_SECRET = "per-workspace-secret";
const GLOBAL_SECRET = "global-env-secret";

/** GitHub's `x-hub-signature-256` value for `raw` under `secret`. */
function sign(raw: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
}

function req(raw: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/v1/connectors/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issues",
      ...headers,
    },
    body: raw,
  });
}

/** A labeled `issues` delivery carrying the trigger label for REPO. */
function issuesBody(): string {
  return JSON.stringify({
    action: "labeled",
    issue: {
      number: 7,
      title: "Fix the flux capacitor",
      body: "details",
      labels: [{ name: "ready-for-agent" }],
    },
    repository: { full_name: REPO },
  });
}

/** A default-branch `push` delivery for REPO. */
function pushBody(): string {
  return JSON.stringify({
    ref: "refs/heads/main",
    deleted: false,
    commits: [{ id: "abc123" }],
    repository: { full_name: REPO },
  });
}

function githubConnector(config: Record<string, unknown> = {}) {
  return {
    provider: "github",
    enabled: true,
    config: {
      repos: [REPO],
      triggerLabel: "ready-for-agent",
      pollIntervalSeconds: 60,
      ...config,
    },
    hasSecret: false,
    updatedAt: null,
  } as unknown as Awaited<ReturnType<typeof getConnector>>;
}

const ORIGINAL_GLOBAL = process.env["GITHUB_WEBHOOK_SECRET"];
const ORIGINAL_PUSH_FLAG = process.env["AGENTRAIL_WIKI_RECOMPILE_ON_PUSH"];

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["GITHUB_WEBHOOK_SECRET"];
  // Push tests below stay on the default-OFF flag: signature verification
  // runs BEFORE the flag check (same "parse+verify before any business
  // logic" ordering `issues`/`ping` already get), so `handlePush`'s own
  // flag-off short-circuit is what keeps those tests from needing
  // getRepositoryByName/enqueueOnboard/findOnboardEntryStatus return values
  // — this file stays scoped to signature verification alone (push
  // ADMISSION semantics have their own coverage in
  // route.push-recompile.test.ts).
  delete process.env["AGENTRAIL_WIKI_RECOMPILE_ON_PUSH"];
  mockFindWorkspaceByRepo.mockResolvedValue(WS);
  mockGetConnector.mockResolvedValue(
    githubConnector({ webhookSecret: WS_SECRET })
  );
  mockEnqueue.mockResolvedValue({ enqueued: true, id: "q-1" } as Awaited<
    ReturnType<typeof enqueueGithubIssue>
  >);
});

afterEach(() => {
  if (ORIGINAL_GLOBAL === undefined) {
    delete process.env["GITHUB_WEBHOOK_SECRET"];
  } else {
    process.env["GITHUB_WEBHOOK_SECRET"] = ORIGINAL_GLOBAL;
  }
  if (ORIGINAL_PUSH_FLAG === undefined) {
    delete process.env["AGENTRAIL_WIKI_RECOMPILE_ON_PUSH"];
  } else {
    process.env["AGENTRAIL_WIKI_RECOMPILE_ON_PUSH"] = ORIGINAL_PUSH_FLAG;
  }
});

describe("github webhook — per-workspace secret (#1233)", () => {
  it("accepts a delivery signed with the workspace connector's webhookSecret", async () => {
    const raw = issuesBody();
    const res = await POST(
      req(raw, { "x-hub-signature-256": sign(raw, WS_SECRET) })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      matched: true,
      enqueued: 1,
      id: "q-1",
    });
    expect(mockGetConnector).toHaveBeenCalledWith(WS, "github");
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it("prefers the per-workspace secret over a DIFFERENT global env secret", async () => {
    // The #1233 bug: env var set → legit per-workspace deliveries got 401'd
    // against the wrong secret.
    process.env["GITHUB_WEBHOOK_SECRET"] = GLOBAL_SECRET;
    const raw = issuesBody();

    const res = await POST(
      req(raw, { "x-hub-signature-256": sign(raw, WS_SECRET) })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matched: true, enqueued: 1 });
  });

  it("rejects an INVALID signature once a per-workspace secret exists", async () => {
    // The other half of the bug: env var unset → per-workspace deliveries were
    // effectively unverified (skip branch).
    const raw = issuesBody();

    const res = await POST(
      req(raw, { "x-hub-signature-256": sign(raw, "wrong-secret") })
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid signature" });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("rejects a MISSING signature once a per-workspace secret exists", async () => {
    const raw = issuesBody();

    const res = await POST(req(raw));

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid signature" });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("verifies non-issues events (ping) against the per-workspace secret too", async () => {
    // GitHub sends `ping` on webhook creation; it carries `repository`, so the
    // workspace secret must apply there as well or setup always shows a failure.
    process.env["GITHUB_WEBHOOK_SECRET"] = GLOBAL_SECRET;
    const raw = JSON.stringify({
      zen: "Keep it logically awesome.",
      repository: { full_name: REPO },
    });

    const res = await POST(
      req(raw, {
        "x-github-event": "ping",
        "x-hub-signature-256": sign(raw, WS_SECRET),
      })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "ping" });
  });
});

describe("github webhook — global-secret fallback (backward compat)", () => {
  it("verifies against the global secret when no workspace owns the repo", async () => {
    mockFindWorkspaceByRepo.mockResolvedValue(null);
    process.env["GITHUB_WEBHOOK_SECRET"] = GLOBAL_SECRET;
    const raw = issuesBody();

    const res = await POST(
      req(raw, { "x-hub-signature-256": sign(raw, GLOBAL_SECRET) })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      matched: false,
      reason: "no workspace owns this repo",
    });
  });

  it("rejects an invalid global-secret signature when no workspace owns the repo", async () => {
    mockFindWorkspaceByRepo.mockResolvedValue(null);
    process.env["GITHUB_WEBHOOK_SECRET"] = GLOBAL_SECRET;
    const raw = issuesBody();

    const res = await POST(
      req(raw, { "x-hub-signature-256": sign(raw, "wrong-secret") })
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid signature" });
  });

  it("falls back to the global secret when the connector has NO webhookSecret", async () => {
    // Legacy workspaces created before #1233 have no per-workspace secret.
    mockGetConnector.mockResolvedValue(githubConnector());
    process.env["GITHUB_WEBHOOK_SECRET"] = GLOBAL_SECRET;
    const raw = issuesBody();

    const res = await POST(
      req(raw, { "x-hub-signature-256": sign(raw, GLOBAL_SECRET) })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matched: true, enqueued: 1 });
  });
});

describe("github webhook — no secret configured (backward compat)", () => {
  it("skips verification when neither a connector secret nor the env var exists", async () => {
    mockGetConnector.mockResolvedValue(githubConnector());
    const raw = issuesBody();

    const res = await POST(req(raw)); // unsigned

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matched: true, enqueued: 1 });
  });

  it("still returns 400 invalid json for unparseable issues deliveries", async () => {
    process.env["GITHUB_WEBHOOK_SECRET"] = GLOBAL_SECRET;
    const raw = "not-json{{";

    const res = await POST(
      req(raw, { "x-hub-signature-256": sign(raw, GLOBAL_SECRET) })
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid json" });
  });
});

describe("github webhook — push events verified against the SAME per-workspace secret (reuses verifySignature unchanged)", () => {
  // AGENTRAIL_WIKI_RECOMPILE_ON_PUSH stays unset (this file's own beforeEach)
  // for every case here — signature verification runs BEFORE the push
  // handler's flag check, so a correctly-signed push always clears
  // signature verification and falls through to `handlePush`'s flag-off
  // 202, while a badly-signed one is rejected before `handlePush` is ever
  // reached at all. Push ADMISSION semantics (the flag on, branch/deleted/
  // zero-commit rules, enqueue outcomes) are covered separately in
  // route.push-recompile.test.ts — this only proves push goes through the
  // identical `verifySignature` gate `issues`/`ping` already do.
  it("accepts a push delivery signed with the workspace connector's webhookSecret", async () => {
    const raw = pushBody();

    const res = await POST(
      req(raw, { "x-github-event": "push", "x-hub-signature-256": sign(raw, WS_SECRET) })
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ event: "push", status: "ignored:flag_off" });
  });

  it("prefers the per-workspace secret over a DIFFERENT global env secret for push too", async () => {
    process.env["GITHUB_WEBHOOK_SECRET"] = GLOBAL_SECRET;
    const raw = pushBody();

    const res = await POST(
      req(raw, { "x-github-event": "push", "x-hub-signature-256": sign(raw, WS_SECRET) })
    );

    expect(res.status).toBe(202);
  });

  it("rejects an INVALID signature on a push delivery once a per-workspace secret exists", async () => {
    const raw = pushBody();

    const res = await POST(
      req(raw, { "x-github-event": "push", "x-hub-signature-256": sign(raw, "wrong-secret") })
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid signature" });
  });

  it("rejects a MISSING signature on a push delivery once a per-workspace secret exists", async () => {
    const raw = pushBody();

    const res = await POST(req(raw, { "x-github-event": "push" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid signature" });
  });
});
