import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  isConnectorProvider: vi.fn(),
  mintConnectorOauthState: vi.fn(),
  // W3-T3 fix round — session-transport pre-mint clearing (last-mint-wins
  // per user across workspaces).
  clearPendingConnectorOauthStatesForUser: vi.fn(),
  // W3-T3 second fix round (review Finding 1) — the per-transport TTL this
  // route selects between. A literal, not an import from the real module
  // (this whole package is mocked) — MUST match connectors.ts's own value;
  // the "pins the asymmetry" test in connectors.test.ts is what actually
  // guards the real constant's value, not this mock.
  SESSION_TRANSPORT_OAUTH_STATE_TTL_MS: 10 * 60 * 1000,
}));
vi.mock("../../../../../../../../lib/oauth/types", () => ({
  oauthAdapterFor: vi.fn(),
  oauthConfigFor: vi.fn(),
  // W3-T2: this route now side-effect-imports `lib/oauth/railway.ts`, which
  // calls `registerOauthAdapter` at module load — see the callback route
  // test's identical comment.
  registerOauthAdapter: vi.fn(),
}));

import { POST } from "./route";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  isConnectorProvider,
  mintConnectorOauthState,
  clearPendingConnectorOauthStatesForUser,
  SESSION_TRANSPORT_OAUTH_STATE_TTL_MS,
} from "@agentrail/db-postgres";
import { oauthAdapterFor, oauthConfigFor } from "../../../../../../../../lib/oauth/types";
import { computeCodeChallengeS256 } from "../../../../../../../../lib/oauth/pkce";

/**
 * POST /api/v1/workspaces/[workspaceId]/connectors/oauth/link (W3-T1, OAuth
 * Connect Wave 3). Mirrors `connectors/github/install-link/route.test.ts`'s
 * own structure (auth/membership gating, happy-path URL assembly) — the
 * generalization here is `provider` traveling in the BODY (not the URL:
 * this route is generic across every OAuth-capable provider) and the closed
 * 409-on-env-unset branch the plan pins.
 */

const WS = "ws-1";
const USER = "user-1";

function req(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/connectors/oauth/link`,
    { method: "POST", body: JSON.stringify(body) }
  );
}
function invalidJsonReq(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/connectors/oauth/link`,
    { method: "POST", body: "not json" }
  );
}
function params() {
  return { params: Promise.resolve({ workspaceId: WS }) };
}

const fakeAdapter = {
  provider: "railway",
  authorizeUrl: ({
    state,
    redirectUri,
    codeChallenge,
  }: {
    state: string;
    redirectUri: string;
    codeChallenge?: string;
  }) =>
    `https://railway.com/oauth/authorize?client_id=cid&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${codeChallenge ?? ""}`,
  exchange: vi.fn(),
  refresh: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "owner" } as never);
  vi.mocked(isConnectorProvider).mockReturnValue(true);
  vi.mocked(oauthAdapterFor).mockReturnValue(fakeAdapter as never);
  vi.mocked(oauthConfigFor).mockReturnValue({ clientId: "cid", clientSecret: "csecret" });
  vi.mocked(mintConnectorOauthState).mockResolvedValue("state-abc");
  process.env["CONSOLE_PUBLIC_URL"] = "https://heyjace.com";
});

describe("POST /api/v1/workspaces/[workspaceId]/connectors/oauth/link", () => {
  it("401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(req({ provider: "railway" }), params());
    expect(res.status).toBe(401);
  });

  it("403 when not a workspace member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await POST(req({ provider: "railway" }), params());
    expect(res.status).toBe(403);
  });

  it("403 when membership role is member (not owner/admin)", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "member" } as never);
    const res = await POST(req({ provider: "railway" }), params());
    expect(res.status).toBe(403);
    expect(mintConnectorOauthState).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON body", async () => {
    const res = await POST(invalidJsonReq(), params());
    expect(res.status).toBe(400);
  });

  it("400 when provider is not a recognized connector provider", async () => {
    vi.mocked(isConnectorProvider).mockReturnValue(false);
    const res = await POST(req({ provider: "not-a-real-provider" }), params());
    expect(res.status).toBe(400);
    expect(mintConnectorOauthState).not.toHaveBeenCalled();
  });

  it("400 when the provider has no registered OAuth adapter (not OAuth-capable, e.g. linear)", async () => {
    vi.mocked(oauthAdapterFor).mockReturnValue(null);
    const res = await POST(req({ provider: "linear" }), params());
    expect(res.status).toBe(400);
    expect(mintConnectorOauthState).not.toHaveBeenCalled();
  });

  it("409 with a clear message when the provider's OAuth env is unset (the plan's pinned status code)", async () => {
    vi.mocked(oauthConfigFor).mockReturnValue(null);
    const res = await POST(req({ provider: "railway" }), params());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/oauth/i);
    expect(body.error).toMatch(/OAuth\/MCP.*not enabled/i);
    expect(mintConnectorOauthState).not.toHaveBeenCalled();
  });

  it("500 when CONSOLE_PUBLIC_URL is unset on this deployment — fails closed, never a half-built redirect_uri", async () => {
    delete process.env["CONSOLE_PUBLIC_URL"];
    const res = await POST(req({ provider: "railway" }), params());
    expect(res.status).toBe(500);
    expect(mintConnectorOauthState).not.toHaveBeenCalled();
  });

  it("200 with the authorize URL on the happy path: mints state, builds redirect_uri from CONSOLE_PUBLIC_URL, delegates URL-building to the adapter", async () => {
    const res = await POST(req({ provider: "railway" }), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toContain("state=state-abc");
    expect(body.url).toContain(
      encodeURIComponent("https://heyjace.com/api/v1/connectors/oauth/callback/railway")
    );
    // CRITICAL-1 (W3-T1 fix round): the state binds the MINTING session's
    // user id — the callback route requires the redeeming session to match.
    // W3-T2 fix round (PKCE upgrade): a 4th arg, the minted code_verifier,
    // is now always present too (asserted precisely in its own describe
    // block below — `expect.any(String)` here since it's random per call).
    // W3-T3 second fix round: a 5th arg (the per-transport TTL override) is
    // now ALWAYS passed too — `undefined` for param-transport (railway),
    // which is functionally identical to omitting it entirely
    // (`mintConnectorOauthState`'s own default parameter applies either
    // way — see its own describe block below for the byte-unchanged
    // behavior proof); asserted here only so this exact-call-shape
    // assertion matches reality.
    expect(mintConnectorOauthState).toHaveBeenCalledWith(WS, "railway", USER, expect.any(String), undefined);
  });

  it("binds the CURRENT session's user id, not some other id — a different admin's own click mints their OWN binding", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "different-admin-user" } } as never);
    await POST(req({ provider: "railway" }), params());
    expect(mintConnectorOauthState).toHaveBeenCalledWith(
      WS,
      "railway",
      "different-admin-user",
      expect.any(String),
      undefined
    );
  });

  // -----------------------------------------------------------------------
  // W3-T2 fix round (PKCE upgrade) — a code_verifier is minted for EVERY
  // connect attempt and its S256 challenge is handed to the adapter.
  // -----------------------------------------------------------------------
  describe("PKCE (W3-T2 fix round)", () => {
    it("mints a code_verifier and passes mintConnectorOauthState's own 4th arg through unchanged", async () => {
      await POST(req({ provider: "railway" }), params());
      const call = vi.mocked(mintConnectorOauthState).mock.calls[0]!;
      const codeVerifier = call[3] as string;
      expect(typeof codeVerifier).toBe("string");
      expect(codeVerifier.length).toBeGreaterThan(0);
    });

    it("passes a codeChallenge to adapter.authorizeUrl that is the S256 hash of the SAME verifier minted alongside state", async () => {
      const res = await POST(req({ provider: "railway" }), params());
      expect(res.status).toBe(200);

      const call = vi.mocked(mintConnectorOauthState).mock.calls[0]!;
      const mintedVerifier = call[3] as string;
      const expectedChallenge = computeCodeChallengeS256(mintedVerifier);

      const body = await res.json();
      expect(body.url).toContain(`code_challenge=${expectedChallenge}`);
    });

    it("mints a DIFFERENT verifier (and therefore a different challenge) on every call — never reused across connect attempts", async () => {
      await POST(req({ provider: "railway" }), params());
      await POST(req({ provider: "railway" }), params());
      const [firstCall, secondCall] = vi.mocked(mintConnectorOauthState).mock.calls;
      expect(firstCall![3]).not.toBe(secondCall![3]);
    });
  });

  // -----------------------------------------------------------------------
  // W3-T3 fix round (coordinator ruling, option B) — envReady() (the third
  // env var beyond the generic oauthConfigFor pair) and session-transport
  // pre-mint clearing.
  // -----------------------------------------------------------------------
  describe("envReady (W3-T3 fix round — the adapter's own extra env gate)", () => {
    it("200 (unaffected) when the adapter declares no envReady at all — defaults to ready, matches every provider before sentry", async () => {
      const res = await POST(req({ provider: "railway" }), params());
      expect(res.status).toBe(200);
    });

    it("200 when the adapter declares envReady() returning true", async () => {
      const fakeAdapterWithEnvReady = { ...fakeAdapter, envReady: vi.fn().mockReturnValue(true) };
      vi.mocked(oauthAdapterFor).mockReturnValue(fakeAdapterWithEnvReady as never);
      const res = await POST(req({ provider: "sentry" }), params());
      expect(res.status).toBe(200);
    });

    it("409 with the SAME clear-message shape as the oauthConfigFor gate when envReady() returns false — even though oauthConfigFor itself is satisfied", async () => {
      const fakeAdapterWithEnvReady = { ...fakeAdapter, envReady: vi.fn().mockReturnValue(false) };
      vi.mocked(oauthAdapterFor).mockReturnValue(fakeAdapterWithEnvReady as never);
      const res = await POST(req({ provider: "sentry" }), params());
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/oauth/i);
      expect(body.error).toMatch(/OAuth\/MCP.*not enabled/i);
      expect(mintConnectorOauthState).not.toHaveBeenCalled();
    });
  });

  describe("session-transport pre-mint clearing (W3-T3 fix round — last-mint-wins per user, across workspaces)", () => {
    it("calls clearPendingConnectorOauthStatesForUser(provider, userId) BEFORE mintConnectorOauthState when the adapter declares stateTransport: 'session'", async () => {
      const fakeSessionAdapter = { ...fakeAdapter, stateTransport: "session" as const };
      vi.mocked(oauthAdapterFor).mockReturnValue(fakeSessionAdapter as never);
      await POST(req({ provider: "sentry" }), params());
      expect(clearPendingConnectorOauthStatesForUser).toHaveBeenCalledWith("sentry", USER);
      const clearOrder = vi.mocked(clearPendingConnectorOauthStatesForUser).mock.invocationCallOrder[0]!;
      const mintOrder = vi.mocked(mintConnectorOauthState).mock.invocationCallOrder[0]!;
      expect(clearOrder).toBeLessThan(mintOrder);
    });

    it("does NOT call clearPendingConnectorOauthStatesForUser for a 'param'-transport provider (railway) — no-op, unaffected", async () => {
      await POST(req({ provider: "railway" }), params());
      expect(clearPendingConnectorOauthStatesForUser).not.toHaveBeenCalled();
    });

    it("does NOT call clearPendingConnectorOauthStatesForUser when the adapter declares no stateTransport at all (defaults to 'param')", async () => {
      await POST(req({ provider: "railway" }), params());
      expect(clearPendingConnectorOauthStatesForUser).not.toHaveBeenCalled();
      expect(mintConnectorOauthState).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // W3-T3 second fix round (independent review Finding 1) — per-transport
  // TTL: mintConnectorOauthState's 5th arg. The narrower window is the one
  // real mitigation for session-transport's disclosed artifact-interception
  // gap (see the callback route's own "SESSION-TRANSPORT CSRF ANALYSIS").
  // -----------------------------------------------------------------------
  describe("per-transport TTL (W3-T3 second fix round)", () => {
    it("passes SESSION_TRANSPORT_OAUTH_STATE_TTL_MS as the 5th arg for a 'session'-transport provider", async () => {
      const fakeSessionAdapter = { ...fakeAdapter, stateTransport: "session" as const };
      vi.mocked(oauthAdapterFor).mockReturnValue(fakeSessionAdapter as never);
      await POST(req({ provider: "sentry" }), params());
      const call = vi.mocked(mintConnectorOauthState).mock.calls[0]!;
      expect(call[4]).toBe(SESSION_TRANSPORT_OAUTH_STATE_TTL_MS);
    });

    it("passes undefined as the 5th arg for a 'param'-transport provider (railway) — mintConnectorOauthState's own default (30 min) applies", async () => {
      await POST(req({ provider: "railway" }), params());
      const call = vi.mocked(mintConnectorOauthState).mock.calls[0]!;
      expect(call[4]).toBeUndefined();
    });

    it("passes undefined as the 5th arg when the adapter declares no stateTransport at all (defaults to 'param')", async () => {
      await POST(req({ provider: "railway" }), params());
      const call = vi.mocked(mintConnectorOauthState).mock.calls[0]!;
      expect(call[4]).toBeUndefined();
    });
  });
});
