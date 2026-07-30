import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { SLACK_BOT_SCOPES, verifySlackOauthState } from "../../../../../../lib/slack-oauth";

const ENV_KEYS = ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "CONSOLE_PUBLIC_URL"] as const;
const ORIGINAL: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) ORIGINAL[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL[key];
  }
});

function req(): NextRequest {
  return new NextRequest("http://localhost/api/v1/connectors/slack/install");
}

describe("GET /api/v1/connectors/slack/install — config fails closed", () => {
  it("500s (never redirects) when SLACK_CLIENT_ID is unset", async () => {
    delete process.env["SLACK_CLIENT_ID"];
    process.env["SLACK_CLIENT_SECRET"] = "secret";
    process.env["CONSOLE_PUBLIC_URL"] = "https://www.heyjace.com";

    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("500s when SLACK_CLIENT_SECRET is unset", async () => {
    process.env["SLACK_CLIENT_ID"] = "CLIENT1";
    delete process.env["SLACK_CLIENT_SECRET"];
    process.env["CONSOLE_PUBLIC_URL"] = "https://www.heyjace.com";

    const res = await GET(req());
    expect(res.status).toBe(500);
  });

  it("500s when CONSOLE_PUBLIC_URL is unset", async () => {
    process.env["SLACK_CLIENT_ID"] = "CLIENT1";
    process.env["SLACK_CLIENT_SECRET"] = "secret";
    delete process.env["CONSOLE_PUBLIC_URL"];

    const res = await GET(req());
    expect(res.status).toBe(500);
  });
});

describe("GET /api/v1/connectors/slack/install — happy path", () => {
  beforeEach(() => {
    process.env["SLACK_CLIENT_ID"] = "CLIENT123";
    process.env["SLACK_CLIENT_SECRET"] = "test-secret";
    process.env["CONSOLE_PUBLIC_URL"] = "https://www.heyjace.com";
  });

  it("302s to slack.com/oauth/v2/authorize with the whole query string correct — client_id, exact scope list, redirect_uri, and a state that verifies under the same secret", async () => {
    const res = await GET(req());
    expect(res.status).toBe(302);

    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);

    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    const params = Object.fromEntries(url.searchParams.entries());
    expect(params["client_id"]).toBe("CLIENT123");
    expect(params["scope"]).toBe(SLACK_BOT_SCOPES.join(","));
    expect(params["redirect_uri"]).toBe("https://www.heyjace.com/api/v1/connectors/slack/callback");
    expect(typeof params["state"]).toBe("string");
    expect(params["state"].length).toBeGreaterThan(0);
    expect(verifySlackOauthState("test-secret", params["state"])).toBe(true);
  });

  it("mints a different state on each call (fresh nonce, single-use in spirit)", async () => {
    const first = new URL(res_location(await GET(req())));
    const second = new URL(res_location(await GET(req())));
    expect(first.searchParams.get("state")).not.toBe(second.searchParams.get("state"));
  });
});

function res_location(res: Response): string {
  const location = res.headers.get("location");
  if (!location) throw new Error("expected a location header");
  return location;
}
