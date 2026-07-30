import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  upsertSlackInstallation: vi.fn(),
}));

import { GET } from "./route";
import { upsertSlackInstallation } from "@agentrail/db-postgres";
import { signSlackOauthState } from "../../../../../../lib/slack-oauth";

const mockUpsert = vi.mocked(upsertSlackInstallation);

const ENV_KEYS = ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "CONSOLE_PUBLIC_URL"] as const;
const ORIGINAL: Record<string, string | undefined> = {};
const CLIENT_ID = "CLIENT123";
const CLIENT_SECRET = "test-client-secret";
const CONSOLE_PUBLIC_URL = "https://www.heyjace.com";

function validState(): string {
  return signSlackOauthState(CLIENT_SECRET);
}

function req(query: Record<string, string>): NextRequest {
  const url = new URL("http://localhost/api/v1/connectors/slack/callback");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

const FULL_OK_RESPONSE = {
  ok: true,
  access_token: "xoxb-should-never-be-logged",
  bot_user_id: "U0BOT123",
  team: { id: "T0TEAM1", name: "Acme Corp" },
  authed_user: { id: "U0AUTHED1" },
  scope: "chat:write,channels:history",
  is_enterprise_install: false,
};

let fetchMock: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const key of ENV_KEYS) ORIGINAL[key] = process.env[key];
  process.env["SLACK_CLIENT_ID"] = CLIENT_ID;
  process.env["SLACK_CLIENT_SECRET"] = CLIENT_SECRET;
  process.env["CONSOLE_PUBLIC_URL"] = CONSOLE_PUBLIC_URL;

  mockUpsert.mockReset();
  mockUpsert.mockResolvedValue(undefined);

  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL[key];
  }
  vi.unstubAllGlobals();
  errorSpy.mockRestore();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function bodyText(res: Response): Promise<string> {
  return res.text();
}

describe("GET /api/v1/connectors/slack/callback — error=access_denied (user declined)", () => {
  it("renders a friendly page, writes no row, and never attempts the code exchange", async () => {
    const res = await GET(req({ error: "access_denied", state: "irrelevant" }));

    expect(res.status).toBe(200);
    const text = await bodyText(res);
    expect(text).toContain("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("also short-circuits on any other Slack-reported error value, e.g. invalid_scope", async () => {
    const res = await GET(req({ error: "invalid_scope" }));
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/connectors/slack/callback — state validation (CSRF)", () => {
  it("rejects a missing state and never attempts the code exchange", async () => {
    const res = await GET(req({ code: "some-code" }));

    expect(res.status).toBe(400);
    const text = await bodyText(res);
    expect(text).toContain("expired");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects an expired state and never attempts the code exchange", async () => {
    const expired = signSlackOauthState(CLIENT_SECRET, { now: 0 });
    const res = await GET(req({ code: "some-code", state: expired }));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects a mismatched/forged state and never attempts the code exchange", async () => {
    const forged = signSlackOauthState("wrong-secret");
    const res = await GET(req({ code: "some-code", state: forged }));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("MUTATION CHECK — proves the state guard has teeth: this exact forged-state request MUST be rejected before any exchange; a guard that were accidentally removed or short-circuited to always-pass would make fetch get called here", async () => {
    const forged = "not-even-shaped-like-a-token";
    const res = await GET(req({ code: "some-code", state: forged }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/connectors/slack/callback — missing config", () => {
  it("500s when SLACK_CLIENT_ID is unset, before ever checking state", async () => {
    delete process.env["SLACK_CLIENT_ID"];
    const res = await GET(req({ code: "c", state: "s" }));
    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/connectors/slack/callback — missing code", () => {
  it("rejects when state is valid but code is absent, without calling fetch", async () => {
    const res = await GET(req({ state: validState() }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/connectors/slack/callback — Slack ok: false", () => {
  it("writes no row, and logs the failure WITHOUT the code, client secret, or a token", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: "invalid_code" }));

    const res = await GET(req({ code: "the-real-auth-code", state: validState() }));

    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();

    expect(errorSpy).toHaveBeenCalled();
    const loggedText = errorSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
    expect(loggedText).toContain("invalid_code");
    expect(loggedText).not.toContain("the-real-auth-code");
    expect(loggedText).not.toContain(CLIENT_SECRET);
  });
});

describe("GET /api/v1/connectors/slack/callback — Enterprise Grid refusal (spec §5)", () => {
  it("refuses is_enterprise_install: true, writes no row, and explains why", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...FULL_OK_RESPONSE, is_enterprise_install: true }));

    const res = await GET(req({ code: "the-real-auth-code", state: validState() }));

    expect(res.status).toBe(200);
    const text = await bodyText(res);
    expect(text).toContain("Enterprise Grid");
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("MUTATION CHECK — proves the Grid guard has teeth end-to-end: this exact Slack response MUST NOT reach upsertSlackInstallation; a guard that were removed would call it with is_enterprise_install's team", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...FULL_OK_RESPONSE, is_enterprise_install: true }));
    await GET(req({ code: "the-real-auth-code", state: validState() }));
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/connectors/slack/callback — 2xx body missing required fields", () => {
  it("treats a response missing access_token as a failure, never a partial write", async () => {
    const { access_token, ...rest } = FULL_OK_RESPONSE;
    void access_token;
    fetchMock.mockResolvedValue(jsonResponse(rest));

    const res = await GET(req({ code: "c", state: validState() }));
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("treats a response missing bot_user_id as a failure, never a partial write", async () => {
    const { bot_user_id, ...rest } = FULL_OK_RESPONSE;
    void bot_user_id;
    fetchMock.mockResolvedValue(jsonResponse(rest));

    const res = await GET(req({ code: "c", state: validState() }));
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("treats a response missing team.id as a failure, never a partial write", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...FULL_OK_RESPONSE, team: { name: "Acme Corp" } }));

    const res = await GET(req({ code: "c", state: validState() }));
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/connectors/slack/callback — network failure reaching Slack", () => {
  it("renders a failure page and never logs the request body (client_secret + code)", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    const res = await GET(req({ code: "the-real-auth-code", state: validState() }));

    expect(res.status).toBe(502);
    expect(mockUpsert).not.toHaveBeenCalled();

    const loggedText = errorSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
    expect(loggedText).not.toContain("the-real-auth-code");
    expect(loggedText).not.toContain(CLIENT_SECRET);
  });
});

describe("GET /api/v1/connectors/slack/callback — happy path", () => {
  it("exchanges the code with the correct form-encoded request, upserts the exact installation object, and renders the connected page", async () => {
    fetchMock.mockResolvedValue(jsonResponse(FULL_OK_RESPONSE));

    const res = await GET(req({ code: "the-real-auth-code", state: validState() }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://slack.com/api/oauth.v2.access");
    expect(calledInit.method).toBe("POST");
    const sentBody = new URLSearchParams(calledInit.body as string);
    expect(Object.fromEntries(sentBody.entries())).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: "the-real-auth-code",
      redirect_uri: "https://www.heyjace.com/api/v1/connectors/slack/callback",
    });

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledWith({
      teamId: "T0TEAM1",
      teamName: "Acme Corp",
      botToken: "xoxb-should-never-be-logged",
      botUserId: "U0BOT123",
      installedBySlackUserId: "U0AUTHED1",
      scopes: "chat:write,channels:history",
      enterpriseId: null,
    });

    expect(res.status).toBe(200);
    const text = await bodyText(res);
    expect(text).toContain("/invite @Jace");
    expect(text).toContain("Acme Corp");
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("never logs the bot token on the success path either", async () => {
    fetchMock.mockResolvedValue(jsonResponse(FULL_OK_RESPONSE));
    await GET(req({ code: "the-real-auth-code", state: validState() }));

    const loggedText = errorSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
    expect(loggedText).not.toContain("xoxb-should-never-be-logged");
  });
});
