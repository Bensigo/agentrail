import { describe, expect, it } from "vitest";
import {
  OAUTH_ERROR_REASONS,
  connectedRedirectUrl,
  oauthCallbackUri,
  oauthErrorRedirectUrl,
  type OauthErrorReason,
} from "./redirect";

/**
 * OAuth Connect Wave 3, W3-T1 — pure URL-building helpers for the callback
 * route (kept OUT of route.ts: the App Router's `next build` route-type
 * validation rejects any route.ts export beyond the HTTP verb handlers —
 * see 403920ea, "next build rejects extra route exports"). Mirrors
 * `install-callback/route.ts`'s own two-tier redirect precedent: before a
 * state is consumed (no workspaceId known yet) redirects land on the
 * workspace-less `/dashboard`; once a workspaceId is known, on that
 * workspace's connectors page.
 */

const BASE = "https://console.example.com";

describe("OAUTH_ERROR_REASONS closed set", () => {
  it("is a fixed, deduplicated set of reasons, never echoing vendor text", () => {
    expect(new Set(OAUTH_ERROR_REASONS).size).toBe(OAUTH_ERROR_REASONS.length);
    expect(OAUTH_ERROR_REASONS).toEqual([
      "state_invalid",
      "provider_unknown",
      "provider_unconfigured",
      "denied",
      "exchange_failed",
      "store_failed",
    ]);
  });
});

describe("connectedRedirectUrl", () => {
  it("targets the workspace's connectors page with ?connected=<provider>", () => {
    const url = connectedRedirectUrl(BASE, "ws-1", "railway");
    expect(url.pathname).toBe("/dashboard/ws-1/connectors");
    expect(url.searchParams.get("connected")).toBe("railway");
  });
});

describe("oauthErrorRedirectUrl", () => {
  it("targets the workspace-less dashboard root when workspaceId is unknown (state not yet consumed)", () => {
    const url = oauthErrorRedirectUrl(BASE, null, "state_invalid");
    expect(url.pathname).toBe("/dashboard");
    expect(url.searchParams.get("oauth_error")).toBe("state_invalid");
  });

  it("targets the workspace's connectors page once workspaceId is known", () => {
    const url = oauthErrorRedirectUrl(BASE, "ws-1", "exchange_failed");
    expect(url.pathname).toBe("/dashboard/ws-1/connectors");
    expect(url.searchParams.get("oauth_error")).toBe("exchange_failed");
  });

  it("accepts every reason in the closed set without narrowing at the call site", () => {
    for (const reason of OAUTH_ERROR_REASONS) {
      const url: URL = oauthErrorRedirectUrl(BASE, "ws-1", reason as OauthErrorReason);
      expect(url.searchParams.get("oauth_error")).toBe(reason);
    }
  });
});

describe("oauthCallbackUri", () => {
  it("builds the vendor-facing redirect_uri from CONSOLE_PUBLIC_URL + the provider path segment", () => {
    expect(oauthCallbackUri("https://heyjace.com", "railway")).toBe(
      "https://heyjace.com/api/v1/connectors/oauth/callback/railway"
    );
    expect(oauthCallbackUri("https://heyjace.com", "sentry")).toBe(
      "https://heyjace.com/api/v1/connectors/oauth/callback/sentry"
    );
  });

  it("trims whitespace and any trailing slash(es), mirroring buildSlackRedirectUri", () => {
    expect(oauthCallbackUri("https://heyjace.com/ ", "railway")).toBe(
      "https://heyjace.com/api/v1/connectors/oauth/callback/railway"
    );
    expect(oauthCallbackUri("https://heyjace.com//", "railway")).toBe(
      "https://heyjace.com/api/v1/connectors/oauth/callback/railway"
    );
  });
});
