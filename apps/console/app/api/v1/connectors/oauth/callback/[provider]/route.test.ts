import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  isConnectorProvider: vi.fn(),
  consumeConnectorOauthState: vi.fn(),
  setConnectorSecret: vi.fn(),
  serializeOauthEnvelope: vi.fn(),
}));
vi.mock("../../../../../../../lib/oauth/types", () => ({
  oauthAdapterFor: vi.fn(),
  oauthConfigFor: vi.fn(),
}));

import { GET } from "./route";
import {
  isConnectorProvider,
  consumeConnectorOauthState,
  setConnectorSecret,
  serializeOauthEnvelope,
} from "@agentrail/db-postgres";
import { oauthAdapterFor, oauthConfigFor } from "../../../../../../../lib/oauth/types";

/**
 * GET /api/v1/connectors/oauth/callback/[provider] (W3-T1, OAuth Connect
 * Wave 3). NO session check here (deliberate — see route.ts's own
 * doc-comment: mirrors `connectors/slack/callback/route.ts`'s precedent,
 * the closest REAL third-party-OAuth2-code-exchange analog in this
 * codebase; the single-use server-minted `state` IS the full security
 * boundary — session/membership re-verification is github install-
 * callback's OWN anti-IDOR answer to a DIFFERENT problem — a global
 * callback + a low-entropy, guessable `installation_id` — that doesn't
 * exist here: `code` is vendor-issued, single-use, and bound to OUR exact
 * `client_id`+`redirect_uri`, so an attacker who doesn't control the vendor
 * account cannot produce a valid one).
 *
 * Every query-string value the vendor could ever send is untrusted — this
 * route's failure branches (closed `oauth_error` set, never echoed vendor
 * text) are each tested in the ORDER route.ts itself checks them.
 */

const BASE = "http://localhost/api/v1/connectors/oauth/callback/railway";

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
  vi.mocked(isConnectorProvider).mockReturnValue(true);
  vi.mocked(oauthAdapterFor).mockReturnValue(fakeAdapter as never);
  vi.mocked(oauthConfigFor).mockReturnValue({ clientId: "cid", clientSecret: "csecret" });
  vi.mocked(consumeConnectorOauthState).mockResolvedValue({ workspaceId: "ws-1" });
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
