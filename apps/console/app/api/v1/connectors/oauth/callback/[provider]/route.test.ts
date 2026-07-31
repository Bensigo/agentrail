import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  isConnectorProvider: vi.fn(),
  consumeConnectorOauthState: vi.fn(),
  setConnectorSecret: vi.fn(),
  serializeOauthEnvelope: vi.fn(),
  getWorkspaceMembership: vi.fn(),
}));
vi.mock("../../../../../../../lib/oauth/types", () => ({
  oauthAdapterFor: vi.fn(),
  oauthConfigFor: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import {
  isConnectorProvider,
  consumeConnectorOauthState,
  setConnectorSecret,
  serializeOauthEnvelope,
  getWorkspaceMembership,
} from "@agentrail/db-postgres";
import { oauthAdapterFor, oauthConfigFor } from "../../../../../../../lib/oauth/types";

/**
 * GET /api/v1/connectors/oauth/callback/[provider] (W3-T1, OAuth Connect
 * Wave 3). W3-T1 FIX ROUND (independent review CRITICAL-1,
 * `.superpowers/sdd/review-W3T1.md`): this route now DOES require a
 * session — see route.ts's own doc-comment for the full misdirection
 * attack this closes and why the (unfixed) original session-less design's
 * citation of the slack callback precedent didn't actually hold. The
 * `USER`/`OTHER_USER` split below exercises the tenant-binding gate
 * directly: `consumeConnectorOauthState` is mocked to resolve the state's
 * BOUND minter id, independently of whichever session `auth()` is mocked
 * to return, so "same person" vs. "different person" is asserted exactly
 * the way the real functions compose it.
 *
 * Every query-string value the vendor could ever send is untrusted — this
 * route's failure branches (closed `oauth_error` set, never echoed vendor
 * text) are each tested in the ORDER route.ts itself checks them.
 */

const BASE = "http://localhost/api/v1/connectors/oauth/callback/railway";
const WS = "ws-1";
const USER = "user-1"; // the default session's user AND the state's bound minter — the happy path.

function req(query: Record<string, string> = {}): NextRequest {
  const url = new URL(BASE);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new NextRequest(url);
}
function params(provider = "railway") {
  return { params: Promise.resolve({ provider }) };
}

const fakeAdapter = {
  provider: "railway",
  authorizeUrl: vi.fn(),
  exchange: vi.fn(),
  refresh: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(isConnectorProvider).mockReturnValue(true);
  vi.mocked(oauthAdapterFor).mockReturnValue(fakeAdapter as never);
  vi.mocked(oauthConfigFor).mockReturnValue({ clientId: "cid", clientSecret: "csecret" });
  vi.mocked(consumeConnectorOauthState).mockResolvedValue({ workspaceId: WS, userId: USER });
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "owner" } as never);
  vi.mocked(fakeAdapter.exchange).mockResolvedValue({
    access: "acc-1",
    refresh: "ref-1",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  vi.mocked(serializeOauthEnvelope).mockReturnValue("serialized-envelope");
  vi.mocked(setConnectorSecret).mockResolvedValue({
    provider: "railway" as never,
    enabled: true,
    config: { repos: [], triggerLabel: "x", pollIntervalSeconds: 60 },
    hasSecret: true,
    updatedAt: null,
  });
  process.env["CONSOLE_PUBLIC_URL"] = "https://heyjace.com";
});

describe("GET /api/v1/connectors/oauth/callback/[provider]", () => {
  it("redirects to the workspace-less dashboard with oauth_error=provider_unknown for a garbage provider segment", async () => {
    vi.mocked(isConnectorProvider).mockReturnValue(false);
    const res = await GET(req({ state: "s", code: "c" }), params("not-a-real-provider"));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/dashboard");
    expect(loc.searchParams.get("oauth_error")).toBe("provider_unknown");
    expect(consumeConnectorOauthState).not.toHaveBeenCalled();
  });

  it("redirects with oauth_error=denied when the vendor sends ?error=, without ever consuming state (never spends a real code)", async () => {
    const res = await GET(req({ error: "access_denied", state: "s" }), params());
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/dashboard");
    expect(loc.searchParams.get("oauth_error")).toBe("denied");
    expect(consumeConnectorOauthState).not.toHaveBeenCalled();
  });

  it("never echoes the vendor's own error text into the redirect (closed set only)", async () => {
    const res = await GET(req({ error: "some_vendor_specific_diagnostic_string" }), params());
    const loc = new URL(res.headers.get("location")!);
    expect(loc.search).not.toContain("some_vendor_specific_diagnostic_string");
    expect(loc.searchParams.get("oauth_error")).toBe("denied");
  });

  it("redirects with oauth_error=state_invalid when state is missing", async () => {
    const res = await GET(req({ code: "c" }), params());
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/dashboard");
    expect(loc.searchParams.get("oauth_error")).toBe("state_invalid");
    expect(consumeConnectorOauthState).not.toHaveBeenCalled();
  });

  it("redirects with oauth_error=state_invalid when code is missing", async () => {
    const res = await GET(req({ state: "s" }), params());
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("oauth_error")).toBe("state_invalid");
    expect(consumeConnectorOauthState).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // W3-T1 fix round — CRITICAL-1 tenant-binding gate (review's finding).
  // -----------------------------------------------------------------------
  describe("tenant binding (review CRITICAL-1)", () => {
    it("redirects with oauth_error=state_invalid when there is no authenticated session — checked BEFORE consuming state", async () => {
      vi.mocked(auth).mockResolvedValue(null as never);
      const res = await GET(req({ state: "s", code: "c" }), params());
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/dashboard"); // workspace-less: state was never consumed
      expect(loc.searchParams.get("oauth_error")).toBe("state_invalid");
      expect(consumeConnectorOauthState).not.toHaveBeenCalled();
      expect(fakeAdapter.exchange).not.toHaveBeenCalled();
    });

    it("redirects with oauth_error=state_invalid when the redeeming session is a DIFFERENT user than the state's bound minter — the misdirection attack itself", async () => {
      vi.mocked(auth).mockResolvedValue({ user: { id: "attacker-or-innocent-victim" } } as never);
      // The state resolves fine (it's real and unexpired) — bound to USER,
      // NOT the redeeming session.
      vi.mocked(consumeConnectorOauthState).mockResolvedValue({ workspaceId: WS, userId: USER });
      const res = await GET(req({ state: "s", code: "c" }), params());
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe(`/dashboard/${WS}/connectors`); // workspace IS known (state resolved)
      expect(loc.searchParams.get("oauth_error")).toBe("state_invalid");
      expect(getWorkspaceMembership).not.toHaveBeenCalled(); // short-circuits before the membership check
      expect(fakeAdapter.exchange).not.toHaveBeenCalled();
      expect(setConnectorSecret).not.toHaveBeenCalled();
    });

    it("redirects with oauth_error=state_invalid when the redeeming (matching) user is not a member of the bound workspace at all", async () => {
      vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
      const res = await GET(req({ state: "s", code: "c" }), params());
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe(`/dashboard/${WS}/connectors`);
      expect(loc.searchParams.get("oauth_error")).toBe("state_invalid");
      expect(fakeAdapter.exchange).not.toHaveBeenCalled();
    });

    it("redirects with oauth_error=state_invalid when the redeeming user is a member but NOT owner/admin (re-checked fresh, not trusted from mint time)", async () => {
      vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "member" } as never);
      const res = await GET(req({ state: "s", code: "c" }), params());
      const loc = new URL(res.headers.get("location")!);
      expect(loc.searchParams.get("oauth_error")).toBe("state_invalid");
      expect(fakeAdapter.exchange).not.toHaveBeenCalled();
    });

    it("calls getWorkspaceMembership with the redeeming session's user id and the state-resolved workspaceId", async () => {
      await GET(req({ state: "s", code: "c" }), params());
      expect(getWorkspaceMembership).toHaveBeenCalledWith(USER, WS);
    });

    it("proceeds when the session equals the minter AND is owner/admin — 'admin' role also accepted, not just 'owner'", async () => {
      vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "admin" } as never);
      const res = await GET(req({ state: "s", code: "c" }), params("railway"));
      const loc = new URL(res.headers.get("location")!);
      expect(loc.searchParams.get("connected")).toBe("railway");
    });
  });

  it("redirects with oauth_error=state_invalid when the state fails to resolve (unknown/expired/reused)", async () => {
    vi.mocked(consumeConnectorOauthState).mockResolvedValue(null);
    const res = await GET(req({ state: "bad", code: "c" }), params());
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/dashboard");
    expect(loc.searchParams.get("oauth_error")).toBe("state_invalid");
    expect(fakeAdapter.exchange).not.toHaveBeenCalled();
  });

  it("calls consumeConnectorOauthState scoped to the path provider + query state", async () => {
    await GET(req({ state: "my-state", code: "c" }), params("railway"));
    expect(consumeConnectorOauthState).toHaveBeenCalledWith("railway", "my-state");
  });

  it("once workspaceId is known, redirects to that workspace's connectors page with oauth_error=provider_unconfigured when no adapter is registered", async () => {
    vi.mocked(oauthAdapterFor).mockReturnValue(null);
    const res = await GET(req({ state: "s", code: "c" }), params());
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/dashboard/ws-1/connectors");
    expect(loc.searchParams.get("oauth_error")).toBe("provider_unconfigured");
  });

  it("redirects with oauth_error=provider_unconfigured when the provider's env is unset at redemption time", async () => {
    vi.mocked(oauthConfigFor).mockReturnValue(null);
    const res = await GET(req({ state: "s", code: "c" }), params());
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/dashboard/ws-1/connectors");
    expect(loc.searchParams.get("oauth_error")).toBe("provider_unconfigured");
  });

  it("redirects with oauth_error=provider_unconfigured when CONSOLE_PUBLIC_URL is unset", async () => {
    delete process.env["CONSOLE_PUBLIC_URL"];
    const res = await GET(req({ state: "s", code: "c" }), params());
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("oauth_error")).toBe("provider_unconfigured");
    expect(fakeAdapter.exchange).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // W3-T1 fix round — MINOR-2: exchange/store failures must be logged
  // server-side, with provider+workspace+reason, NEVER token material or a
  // raw vendor response body (the caught error object itself).
  // -----------------------------------------------------------------------
  describe("failure logging (review MINOR-2)", () => {
    it("logs a fixed, value-free message naming provider+workspaceId on exchange_failed — never the raw error", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(fakeAdapter.exchange).mockRejectedValue(
        new Error("vendor said: access_token=SECRET_TOKEN_VALUE, refresh_token=SECRET_REFRESH")
      );
      const res = await GET(req({ state: "s", code: "c" }), params("railway"));
      const loc = new URL(res.headers.get("location")!);
      expect(loc.searchParams.get("oauth_error")).toBe("exchange_failed");
      expect(errSpy).toHaveBeenCalled();
      const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("railway");
      expect(logged).toContain(WS);
      expect(logged).not.toContain("SECRET_TOKEN_VALUE");
      expect(logged).not.toContain("SECRET_REFRESH");
      errSpy.mockRestore();
    });

    it("logs a fixed, value-free message naming provider+workspaceId on store_failed — never the raw error", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(setConnectorSecret).mockRejectedValue(
        new Error("insert failed, offending value: enc:v1:abcdefTOKENDATA")
      );
      const res = await GET(req({ state: "s", code: "c" }), params("railway"));
      const loc = new URL(res.headers.get("location")!);
      expect(loc.searchParams.get("oauth_error")).toBe("store_failed");
      expect(errSpy).toHaveBeenCalled();
      const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("railway");
      expect(logged).toContain(WS);
      expect(logged).not.toContain("TOKENDATA");
      errSpy.mockRestore();
    });
  });

  it("redirects with oauth_error=exchange_failed when the adapter's exchange() rejects", async () => {
    vi.mocked(fakeAdapter.exchange).mockRejectedValue(new Error("vendor 400"));
    const res = await GET(req({ state: "s", code: "c" }), params());
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/dashboard/ws-1/connectors");
    expect(loc.searchParams.get("oauth_error")).toBe("exchange_failed");
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("passes code + the SAME redirect_uri used at mint time (CONSOLE_PUBLIC_URL-derived) + every OTHER query param to exchange()", async () => {
    await GET(req({ state: "s", code: "auth-code-1", installationId: "42" }), params("sentry"));
    expect(fakeAdapter.exchange).toHaveBeenCalledWith({
      code: "auth-code-1",
      redirectUri: "https://heyjace.com/api/v1/connectors/oauth/callback/sentry",
      params: { installationId: "42" },
    });
  });

  it("redirects with oauth_error=store_failed when persisting the envelope throws", async () => {
    vi.mocked(setConnectorSecret).mockRejectedValue(new Error("db down"));
    const res = await GET(req({ state: "s", code: "c" }), params());
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/dashboard/ws-1/connectors");
    expect(loc.searchParams.get("oauth_error")).toBe("store_failed");
  });

  it("stores the SERIALIZED envelope via setConnectorSecret(workspaceId, provider, ...) — never the raw envelope object", async () => {
    await GET(req({ state: "s", code: "c" }), params("railway"));
    expect(serializeOauthEnvelope).toHaveBeenCalledWith({
      access: "acc-1",
      refresh: "ref-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(setConnectorSecret).toHaveBeenCalledWith("ws-1", "railway", "serialized-envelope");
  });

  it("redirects to the workspace's connectors page with ?connected=<provider> on the happy path", async () => {
    const res = await GET(req({ state: "s", code: "c" }), params("railway"));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/dashboard/ws-1/connectors");
    expect(loc.searchParams.get("connected")).toBe("railway");
    expect(loc.searchParams.has("oauth_error")).toBe(false);
  });
});
