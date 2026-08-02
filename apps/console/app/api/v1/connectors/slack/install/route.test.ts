import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { GET } from "./route";
import {
  SLACK_BOT_SCOPES,
  readSlackOauthState,
  verifySlackOauthState,
} from "../../../../../../lib/slack-oauth";

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

// Workspace attribution (bugfix: the console's Gateways page rendered "Add to
// Slack" forever, because nothing linked a completed install back to the
// workspace whose page rendered the button). The workspace id rides in the
// SIGNED state, and is admitted only for a signed-in member — an unchecked
// one would let anyone attribute a Slack team they control to someone else's
// workspace and have that workspace's console render it as connected.
describe("GET /api/v1/connectors/slack/install — workspace attribution", () => {
  const WS = "00000000-0000-0000-0000-000000000001";
  const USER = "user-1";

  function reqFor(workspaceId: string): NextRequest {
    return new NextRequest(
      `http://localhost/api/v1/connectors/slack/install?workspaceId=${workspaceId}`
    );
  }

  beforeEach(() => {
    vi.mocked(auth).mockReset();
    vi.mocked(getWorkspaceMembership).mockReset();
    process.env["SLACK_CLIENT_ID"] = "CLIENT123";
    process.env["SLACK_CLIENT_SECRET"] = "test-secret";
    process.env["CONSOLE_PUBLIC_URL"] = "https://www.heyjace.com";
  });

  it("signs the workspaceId into the state for a signed-in member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "owner" } as never);

    const url = new URL(res_location(await GET(reqFor(WS))));
    const state = url.searchParams.get("state")!;

    expect(readSlackOauthState("test-secret", state)).toEqual({
      workspaceId: WS,
    });
    // Never as a bare query param Slack would echo back unsigned.
    expect(url.searchParams.get("workspaceId")).toBeNull();
  });

  it("checks membership against the SESSION user, not anything in the request", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "member" } as never);

    await GET(reqFor(WS));

    expect(getWorkspaceMembership).toHaveBeenCalledWith(USER, WS);
  });

  it("401s a signed-out caller rather than silently dropping the attribution", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET(reqFor(WS));

    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });

  it("403s a signed-in non-member — no install may be attributed to a workspace the caller is not in", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);

    const res = await GET(reqFor(WS));

    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still redirects with an unattributed state, and never touches auth, when no workspaceId is asked for (Slack App Directory install)", async () => {
    const url = new URL(res_location(await GET(req())));
    const state = url.searchParams.get("state")!;

    expect(readSlackOauthState("test-secret", state)).toEqual({
      workspaceId: null,
    });
    expect(auth).not.toHaveBeenCalled();
  });
});
