import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getChatIdentityById: vi.fn(),
  getGithubToken: vi.fn(),
  createRepository: vi.fn(),
  getConnector: vi.fn(),
  upsertConnector: vi.fn(),
  enqueueOnboard: vi.fn(),
  workspaceHasExecutionPath: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { POST } from "./route";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  getGithubToken,
  createRepository,
  getConnector,
  upsertConnector,
  enqueueOnboard,
  workspaceHasExecutionPath,
} from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const NOW = new Date("2026-07-18T00:00:00.000Z");
const MOCK_TOKEN = "gho_mock_token_abc123";

function req(body?: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/repos", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: "Bearer ar_test" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// A session already pinned to a workspace — the common case create_repo
// exists for (a conversation that has graduated past create_workspace).
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

function githubCreateResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 201,
    json: async () => ({
      full_name: "ada/widgets",
      html_url: "https://github.com/ada/widgets",
      private: true,
      default_branch: "main",
      ...overrides,
    }),
    text: async () => "",
  };
}

function githubErrorResponse(status: number, bodyText: string) {
  return {
    ok: false,
    status,
    json: async () => JSON.parse(bodyText),
    text: async () => bodyText,
  };
}

function githubHookResponse(ok = true, status = 201) {
  return { ok, status, text: async () => "" };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBearer).mockResolvedValue({
    apiKeyId: "key-1",
    workspaceId: "ws-bearer",
    teamId: null,
  } as never);
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(PINNED_SESSION as never);
  vi.mocked(getChatIdentityById).mockResolvedValue(BOUND_IDENTITY as never);
  vi.mocked(getGithubToken).mockResolvedValue(MOCK_TOKEN);
  vi.mocked(createRepository).mockResolvedValue({
    id: "repo-1",
    workspaceId: "ws-1",
    name: "ada/widgets",
    url: "https://github.com/ada/widgets",
    defaultBranch: "main",
    createdAt: NOW,
    updatedAt: NOW,
  } as never);
  vi.mocked(getConnector).mockResolvedValue(null as never);
  vi.mocked(upsertConnector).mockResolvedValue({} as never);
  vi.mocked(workspaceHasExecutionPath).mockResolvedValue(false);
  vi.mocked(enqueueOnboard).mockResolvedValue({
    enqueued: true,
    id: "queue-1",
    state: "queued",
    blockedBy: [],
  } as never);

  delete process.env.AGENTRAIL_ONBOARD_ON_CONNECT;
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.AGENTRAIL_ONBOARD_ON_CONNECT;
});

/** Wire global.fetch to answer the repo-create call then the webhook call, in order. */
function mockFetchSequence(...responses: unknown[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("POST /api/v1/runner/repos", () => {
  // ---------------------------------------------------------------------
  // auth
  // ---------------------------------------------------------------------

  it("401 when requireBearer rejects, and never touches session/identity/GitHub/db", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireBearer).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );
    const fetchMock = mockFetchSequence();

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }, false));

    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(getChatIdentityById).not.toHaveBeenCalled();
    expect(getGithubToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createRepository).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // body / name validation (400) — cheap checks, before any DB call
  // ---------------------------------------------------------------------

  it("400 on invalid JSON", async () => {
    const request = new NextRequest("http://localhost/api/v1/runner/repos", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer ar_test" },
      body: "{not valid json",
    });

    const res = await POST(request);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON" });
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when eveSessionId is missing", async () => {
    const res = await POST(req({ name: "widgets" }));
    expect(res.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when eveSessionId is empty", async () => {
    const res = await POST(req({ eveSessionId: "", name: "widgets" }));
    expect(res.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when name is missing", async () => {
    const res = await POST(req({ eveSessionId: "eve-session-1" }));
    expect(res.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when name is empty after trimming", async () => {
    const res = await POST(req({ eveSessionId: "eve-session-1", name: "   " }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "name is required" });
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when name exceeds 100 characters", async () => {
    const res = await POST(
      req({ eveSessionId: "eve-session-1", name: "a".repeat(101) })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "name must be at most 100 characters" });
  });

  it("400 when name contains a disallowed character (e.g. a slash)", async () => {
    const res = await POST(
      req({ eveSessionId: "eve-session-1", name: "ada/widgets" })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "name may only contain letters, numbers, '.', '_', and '-'",
    });
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when name contains a space", async () => {
    const res = await POST(req({ eveSessionId: "eve-session-1", name: "my widgets" }));
    expect(res.status).toBe(400);
  });

  it("400 when private is present but not a boolean", async () => {
    const res = await POST(
      req({ eveSessionId: "eve-session-1", name: "widgets", private: "yes" })
    );
    expect(res.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("accepts a name at the 100-character boundary and with allowed punctuation", async () => {
    mockFetchSequence(githubCreateResponse(), githubHookResponse());
    const name = "a".repeat(97) + "._-"; // 100 chars, allowed punctuation only

    const res = await POST(req({ eveSessionId: "eve-session-1", name }));

    expect(res.status).toBe(201);
  });

  // ---------------------------------------------------------------------
  // resolution (404) — same posture as #1264's chain
  // ---------------------------------------------------------------------

  it("404 when no jace_sessions row is bound to this eveSessionId", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);

    const res = await POST(req({ eveSessionId: "unknown-eve-session", name: "widgets" }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Chat identity not found" });
    expect(getChatIdentityById).not.toHaveBeenCalled();
  });

  it("404 when the ledgered session has a null chat_identity_id — byte-identical to the unknown-session 404", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...PINNED_SESSION,
      chatIdentityId: null,
    } as never);

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(getChatIdentityById).not.toHaveBeenCalled();

    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
    const unknownRes = await POST(req({ eveSessionId: "unknown", name: "widgets" }));
    expect(await unknownRes.text()).toBe(text);
  });

  // ---------------------------------------------------------------------
  // workspace resolution (409)
  // ---------------------------------------------------------------------

  it("409 when neither the session nor the identity has a workspace", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...PINNED_SESSION,
      workspaceId: null,
    } as never);
    vi.mocked(getChatIdentityById).mockResolvedValue({
      ...BOUND_IDENTITY,
      workspaceId: null,
    } as never);

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "this conversation has no workspace yet — create one first",
    });
    expect(getGithubToken).not.toHaveBeenCalled();
  });

  it("falls back to the identity's workspace when the session itself has none", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...PINNED_SESSION,
      workspaceId: null,
    } as never);
    vi.mocked(getChatIdentityById).mockResolvedValue({
      ...BOUND_IDENTITY,
      workspaceId: "ws-from-identity",
    } as never);
    mockFetchSequence(githubCreateResponse(), githubHookResponse());

    await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    expect(getGithubToken).toHaveBeenCalledWith("ws-from-identity");
    expect(createRepository).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-from-identity" })
    );
  });

  it("prefers the session's own workspace over the identity's when both are set", async () => {
    vi.mocked(getChatIdentityById).mockResolvedValue({
      ...BOUND_IDENTITY,
      workspaceId: "ws-different-from-session",
    } as never);
    mockFetchSequence(githubCreateResponse(), githubHookResponse());

    await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    expect(getGithubToken).toHaveBeenCalledWith("ws-1"); // PINNED_SESSION.workspaceId
  });

  // ---------------------------------------------------------------------
  // token resolution (409)
  // ---------------------------------------------------------------------

  it("409 when the workspace has no stored GitHub token", async () => {
    vi.mocked(getGithubToken).mockResolvedValue(null);

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "no GitHub account with repo access is connected for this workspace yet",
    });
    expect(createRepository).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // the GitHub create-repo call itself
  // ---------------------------------------------------------------------

  it("calls GitHub with the exact URL, auth header (the mocked token, not a literal), and body", async () => {
    const fetchMock = mockFetchSequence(githubCreateResponse(), githubHookResponse());

    await POST(req({ eveSessionId: "eve-session-1", name: "widgets", private: false }));

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/user/repos",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Bearer ${MOCK_TOKEN}`,
        }),
        body: JSON.stringify({ name: "widgets", private: false, auto_init: true }),
      })
    );
  });

  it("defaults private to true when the caller omits it", async () => {
    const fetchMock = mockFetchSequence(githubCreateResponse(), githubHookResponse());

    await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      name: "widgets",
      private: true,
      auto_init: true,
    });
  });

  it("respects an explicit private: false", async () => {
    const fetchMock = mockFetchSequence(githubCreateResponse(), githubHookResponse());

    await POST(req({ eveSessionId: "eve-session-1", name: "widgets", private: false }));

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string).private).toBe(false);
  });

  it("502 when GitHub cannot be reached (network error)", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    expect(res.status).toBe(502);
    expect(createRepository).not.toHaveBeenCalled();
  });

  it("409 honest 'name already exists' when GitHub 422s with the documented name-taken shape", async () => {
    mockFetchSequence(
      githubErrorResponse(
        422,
        JSON.stringify({
          message: "Repository creation failed.",
          errors: [
            { resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" },
          ],
        })
      )
    );

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "a repo named widgets already exists on your GitHub",
    });
    expect(createRepository).not.toHaveBeenCalled();
  });

  it("never echoes a different repo name than the one requested in the name-exists message", async () => {
    mockFetchSequence(
      githubErrorResponse(
        422,
        JSON.stringify({ errors: [{ field: "name", message: "name already exists on this account" }] })
      )
    );

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "my-cool-app" }));
    const json = await res.json();

    expect(json.error).toContain("my-cool-app");
    expect(json.error).not.toContain("widgets");
  });

  it("502 (not 409) when GitHub 422s for a reason other than name-exists", async () => {
    mockFetchSequence(
      githubErrorResponse(
        422,
        JSON.stringify({
          errors: [{ resource: "Repository", code: "custom", field: "visibility", message: "Visibility can not be private" }],
        })
      )
    );

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    expect(res.status).toBe(502);
  });

  it("502 (not 409) when the 422 has field 'name' but the message isn't GitHub's name-taken wording", async () => {
    mockFetchSequence(
      githubErrorResponse(
        422,
        JSON.stringify({
          errors: [
            { resource: "Repository", code: "invalid", field: "name", message: "name is not a valid repository name" },
          ],
        })
      )
    );

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    expect(res.status).toBe(502);
    expect(createRepository).not.toHaveBeenCalled();
  });

  it("409 'GitHub rejected the stored credentials' on a 401", async () => {
    mockFetchSequence(githubErrorResponse(401, JSON.stringify({ message: "Bad credentials" })));

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "GitHub rejected the stored credentials" });
    expect(createRepository).not.toHaveBeenCalled();
  });

  it("409 'GitHub rejected the stored credentials' on a 403", async () => {
    mockFetchSequence(githubErrorResponse(403, JSON.stringify({ message: "Forbidden" })));

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "GitHub rejected the stored credentials" });
  });

  it("502 honest on an unmapped non-2xx (e.g. 500)", async () => {
    mockFetchSequence(githubErrorResponse(500, JSON.stringify({ message: "Internal error" })));

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    expect(res.status).toBe(502);
    expect(createRepository).not.toHaveBeenCalled();
  });

  it("502 when GitHub's 2xx body is missing the expected fields", async () => {
    mockFetchSequence({ ok: true, status: 201, json: async () => ({}), text: async () => "" });

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    expect(res.status).toBe(502);
    expect(createRepository).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // happy path — full connect chain
  // ---------------------------------------------------------------------

  it("201: repository row created with GitHub's returned full_name/html_url/default_branch", async () => {
    mockFetchSequence(githubCreateResponse(), githubHookResponse());

    await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    expect(createRepository).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      name: "ada/widgets",
      url: "https://github.com/ada/widgets",
      defaultBranch: "main",
    });
  });

  it("falls back to 'main' as defaultBranch when GitHub's response omits default_branch", async () => {
    mockFetchSequence(
      githubCreateResponse({ default_branch: undefined }),
      githubHookResponse()
    );

    await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    expect(createRepository).toHaveBeenCalledWith(
      expect.objectContaining({ defaultBranch: "main" })
    );
  });

  it("self-configures the github connector's repos list to include the new repo (no prior connector)", async () => {
    vi.mocked(getConnector).mockResolvedValue(null as never);
    mockFetchSequence(githubCreateResponse(), githubHookResponse());

    await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    expect(upsertConnector).toHaveBeenCalledWith(
      "ws-1",
      "github",
      expect.objectContaining({
        enabled: true,
        config: expect.objectContaining({ repos: ["ada/widgets"] }),
      })
    );
  });

  it("preserves existing connector repos when self-configuring (adds, doesn't replace)", async () => {
    vi.mocked(getConnector).mockResolvedValue({
      provider: "github",
      enabled: true,
      config: { repos: ["ada/other-repo"], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60 },
      hasSecret: false,
      updatedAt: null,
    } as never);
    mockFetchSequence(githubCreateResponse(), githubHookResponse());

    await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    const call = vi.mocked(upsertConnector).mock.calls[0]!;
    expect(call[2]?.config?.repos).toEqual(
      expect.arrayContaining(["ada/other-repo", "ada/widgets"])
    );
  });

  it("mints and persists a fresh webhook secret when the connector has none yet", async () => {
    vi.mocked(getConnector).mockResolvedValue(null as never);
    const fetchMock = mockFetchSequence(githubCreateResponse(), githubHookResponse());

    await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    const persistedSecret = vi.mocked(upsertConnector).mock.calls[0]![2]?.config
      ?.webhookSecret as string;
    expect(persistedSecret).toMatch(/^[0-9a-f]{48}$/);

    const [, hookInit] = fetchMock.mock.calls[1]!;
    const hookBody = JSON.parse((hookInit as RequestInit).body as string);
    expect(hookBody.config.secret).toBe(persistedSecret);
  });

  it("reuses the connector's existing webhook secret instead of minting a new one", async () => {
    vi.mocked(getConnector).mockResolvedValue({
      provider: "github",
      enabled: true,
      config: {
        repos: ["ada/other-repo"],
        triggerLabel: "ready-for-agent",
        pollIntervalSeconds: 60,
        webhookSecret: "already-stored-secret",
      },
      hasSecret: false,
      updatedAt: null,
    } as never);
    const fetchMock = mockFetchSequence(githubCreateResponse(), githubHookResponse());

    await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    const [, hookInit] = fetchMock.mock.calls[1]!;
    const hookBody = JSON.parse((hookInit as RequestInit).body as string);
    expect(hookBody.config.secret).toBe("already-stored-secret");

    const call = vi.mocked(upsertConnector).mock.calls[0]!;
    expect(call[2]?.config?.webhookSecret).toBe("already-stored-secret");
  });

  it("calls the GitHub webhook API with the exact receiver URL (built from this request's origin) and event type", async () => {
    const fetchMock = mockFetchSequence(githubCreateResponse(), githubHookResponse());

    await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/ada/widgets/hooks",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: `Bearer ${MOCK_TOKEN}` }),
      })
    );
    const [, hookInit] = fetchMock.mock.calls[1]!;
    const hookBody = JSON.parse((hookInit as RequestInit).body as string);
    expect(hookBody).toEqual(
      expect.objectContaining({
        name: "web",
        active: true,
        events: ["issues"],
        config: expect.objectContaining({
          url: "http://localhost/api/v1/connectors/github/webhook",
          content_type: "json",
        }),
      })
    );
  });

  it("201 response shape: repo/connected/webhookCreated/onboardQueued/warnings", async () => {
    mockFetchSequence(githubCreateResponse(), githubHookResponse());

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json).toEqual({
      repo: {
        fullName: "ada/widgets",
        url: "https://github.com/ada/widgets",
        private: true,
      },
      connected: true,
      webhookCreated: true,
      onboardQueued: false, // flag is off by default
      warnings: [],
    });
  });

  // ---------------------------------------------------------------------
  // partial success — webhook failure never fails repo creation
  // ---------------------------------------------------------------------

  it("201 with webhookCreated:false + a warning when GitHub rejects the webhook call", async () => {
    mockFetchSequence(githubCreateResponse(), githubHookResponse(false, 422));

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.connected).toBe(true);
    expect(json.repo.fullName).toBe("ada/widgets");
    expect(json.webhookCreated).toBe(false);
    expect(json.warnings.length).toBeGreaterThan(0);
    expect(json.warnings[0]).toMatch(/webhook/i);
  });

  it("201 with webhookCreated:false + a warning when the webhook fetch throws", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(githubCreateResponse());
    fetchMock.mockRejectedValueOnce(new Error("connection reset"));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.webhookCreated).toBe(false);
    expect(json.warnings[0]).toMatch(/could not reach github/i);
  });

  it("201 (best-effort) even when the connector self-configure step throws — warns honestly and skips the webhook call", async () => {
    vi.mocked(getConnector).mockRejectedValue(new Error("db down"));
    const fetchMock = mockFetchSequence(githubCreateResponse(), githubHookResponse());

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.connected).toBe(true);
    expect(json.webhookCreated).toBe(false);
    expect(json.warnings).toHaveLength(2);
    expect(json.warnings[0]).toMatch(/connector config could not be updated/i);
    expect(json.warnings[0]).toMatch(/may not be tracked/i);
    expect(json.warnings[0]).toMatch(/webhook secret was not saved/i);
    expect(json.warnings[1]).toMatch(/webhook/i);
    // The config write failed, so the secret was never persisted — the
    // webhook call (the sequence's 2nd mocked response) must never fire.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------
  // onboard enqueue — scouted: enqueueOnboard already exists and is reused
  // verbatim, gated by the SAME rollout flag as the manual connect flow. No
  // new queue kind invented. The gate itself is workspaceHasExecutionPath
  // (#1268, swapped in from the former kind-agnostic hasActiveRunner) — this
  // route only ever sees its single boolean result, so these tests exercise
  // "true → enqueues" / "false → stays gated"; the sub-cases behind that
  // boolean (hosted-only with no runner ever vs. an active self-hosted
  // runner vs. neither) are unit-tested directly on the predicate itself in
  // packages/db-postgres/src/__tests__/workspace-has-execution-path.test.ts.
  // ---------------------------------------------------------------------

  it("does not call workspaceHasExecutionPath/enqueueOnboard when the flag is unset (default OFF)", async () => {
    mockFetchSequence(githubCreateResponse(), githubHookResponse());

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));
    const json = await res.json();

    expect(workspaceHasExecutionPath).not.toHaveBeenCalled();
    expect(enqueueOnboard).not.toHaveBeenCalled();
    expect(json.onboardQueued).toBe(false);
  });

  it("#1268: enqueues onboard for a hosted-only workspace (no runner has EVER claimed anything)", async () => {
    process.env.AGENTRAIL_ONBOARD_ON_CONNECT = "1";
    // workspaceHasExecutionPath(true) here stands in for the exact regression
    // this predicate fixes: hostedExecution=true, zero api_keys rows ever
    // touched — the old hasActiveRunner gate would have been false forever.
    vi.mocked(workspaceHasExecutionPath).mockResolvedValue(true);
    mockFetchSequence(githubCreateResponse(), githubHookResponse());

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));
    const json = await res.json();

    expect(workspaceHasExecutionPath).toHaveBeenCalledWith("ws-1");
    expect(enqueueOnboard).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      repoFullName: "ada/widgets",
    });
    expect(json.onboardQueued).toBe(true);
  });

  it("stays gated when workspaceHasExecutionPath is false (hostedExecution=false + no active self-hosted runner)", async () => {
    process.env.AGENTRAIL_ONBOARD_ON_CONNECT = "1";
    vi.mocked(workspaceHasExecutionPath).mockResolvedValue(false);
    mockFetchSequence(githubCreateResponse(), githubHookResponse());

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));
    const json = await res.json();

    expect(enqueueOnboard).not.toHaveBeenCalled();
    expect(json.onboardQueued).toBe(false);
  });

  it("201 (best-effort) with onboardQueued:false + a warning when enqueueOnboard throws", async () => {
    process.env.AGENTRAIL_ONBOARD_ON_CONNECT = "1";
    vi.mocked(workspaceHasExecutionPath).mockResolvedValue(true);
    vi.mocked(enqueueOnboard).mockRejectedValue(new Error("db down"));
    mockFetchSequence(githubCreateResponse(), githubHookResponse());

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.onboardQueued).toBe(false);
    expect(json.warnings.some((w: string) => /onboard/i.test(w))).toBe(true);
  });

  it("onboardQueued reflects enqueueOnboard's own result (false on a deduped call)", async () => {
    process.env.AGENTRAIL_ONBOARD_ON_CONNECT = "1";
    vi.mocked(workspaceHasExecutionPath).mockResolvedValue(true);
    vi.mocked(enqueueOnboard).mockResolvedValue({
      enqueued: false,
      reason: "already onboarded (deduped)",
    } as never);
    mockFetchSequence(githubCreateResponse(), githubHookResponse());

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "widgets" }));
    const json = await res.json();

    expect(json.onboardQueued).toBe(false);
  });
});
