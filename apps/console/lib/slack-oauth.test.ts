import { describe, it, expect } from "vitest";
import {
  SLACK_AUTHORIZE_URL,
  SLACK_BOT_SCOPES,
  SLACK_CALLBACK_PATH,
  buildSlackAuthorizeUrl,
  buildSlackOauthAccessBody,
  buildSlackRedirectUri,
  normalizeSlackOauthResponse,
  renderSlackConnectedPage,
  renderSlackErrorPage,
  signSlackOauthState,
  verifySlackOauthState,
} from "./slack-oauth";

describe("SLACK_BOT_SCOPES", () => {
  it("matches the Slack app manifest exactly — do not add or drop any", () => {
    expect(SLACK_BOT_SCOPES).toEqual([
      "chat:write",
      "channels:history",
      "groups:history",
      "im:history",
      "mpim:history",
    ]);
  });
});

describe("buildSlackRedirectUri", () => {
  it("appends the registered callback path to a bare base URL", () => {
    expect(buildSlackRedirectUri("https://www.heyjace.com")).toBe(
      "https://www.heyjace.com/api/v1/connectors/slack/callback"
    );
  });

  it("strips one or more trailing slashes so the result is byte-identical either way", () => {
    expect(buildSlackRedirectUri("https://www.heyjace.com/")).toBe(
      "https://www.heyjace.com/api/v1/connectors/slack/callback"
    );
    expect(buildSlackRedirectUri("https://www.heyjace.com///")).toBe(
      "https://www.heyjace.com/api/v1/connectors/slack/callback"
    );
  });

  it("trims surrounding whitespace from a copy-pasted env value", () => {
    expect(buildSlackRedirectUri("  https://www.heyjace.com  ")).toBe(
      "https://www.heyjace.com/api/v1/connectors/slack/callback"
    );
  });
});

describe("buildSlackAuthorizeUrl", () => {
  it("builds the whole authorize URL — base, client_id, scope, redirect_uri, state — assert as one object, not one field", () => {
    const url = buildSlackAuthorizeUrl({
      clientId: "CLIENT123",
      redirectUri: "https://www.heyjace.com" + SLACK_CALLBACK_PATH,
      state: "abc.def",
    });
    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe(SLACK_AUTHORIZE_URL);
    expect(Object.fromEntries(parsed.searchParams.entries())).toEqual({
      client_id: "CLIENT123",
      scope: SLACK_BOT_SCOPES.join(","),
      redirect_uri: "https://www.heyjace.com/api/v1/connectors/slack/callback",
      state: "abc.def",
    });
  });
});

describe("sign/verify Slack OAuth state — CSRF", () => {
  const SECRET = "test-client-secret";

  it("a freshly signed state verifies immediately under the same secret", () => {
    const state = signSlackOauthState(SECRET, { now: 1_000_000 });
    expect(verifySlackOauthState(SECRET, state, { now: 1_000_001 })).toBe(true);
  });

  it("two mints produce different tokens (random nonce) even at the identical timestamp", () => {
    const a = signSlackOauthState(SECRET, { now: 1_000_000 });
    const b = signSlackOauthState(SECRET, { now: 1_000_000 });
    expect(a).not.toBe(b);
  });

  it("rejects a token once its embedded expiry has passed", () => {
    const state = signSlackOauthState(SECRET, { now: 1_000_000 });
    const TEN_MIN_MS = 10 * 60 * 1000;
    expect(verifySlackOauthState(SECRET, state, { now: 1_000_000 + TEN_MIN_MS + 1 })).toBe(false);
  });

  it("accepts a token right up to (but rejects at/after) its expiry boundary", () => {
    const state = signSlackOauthState(SECRET, { now: 1_000_000 });
    const TEN_MIN_MS = 10 * 60 * 1000;
    expect(verifySlackOauthState(SECRET, state, { now: 1_000_000 + TEN_MIN_MS })).toBe(false);
    expect(verifySlackOauthState(SECRET, state, { now: 1_000_000 + TEN_MIN_MS - 1 })).toBe(true);
  });

  it("rejects a token verified against the wrong secret", () => {
    const state = signSlackOauthState(SECRET);
    expect(verifySlackOauthState("a-different-secret", state)).toBe(false);
  });

  it("rejects a tampered payload segment even when the signature segment is untouched", () => {
    const state = signSlackOauthState(SECRET);
    const [, sig] = state.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ n: "forged", exp: Date.now() + 999_999 })).toString(
      "base64url"
    );
    expect(verifySlackOauthState(SECRET, `${forgedPayload}.${sig}`)).toBe(false);
  });

  it("rejects a tampered signature segment even when the payload segment is untouched", () => {
    const state = signSlackOauthState(SECRET);
    const [payload] = state.split(".");
    expect(verifySlackOauthState(SECRET, `${payload}.notarealsignature`)).toBe(false);
  });

  it("rejects malformed shapes: empty, missing dot, extra dots, null, undefined", () => {
    expect(verifySlackOauthState(SECRET, "")).toBe(false);
    expect(verifySlackOauthState(SECRET, "no-dot-here")).toBe(false);
    expect(verifySlackOauthState(SECRET, "a.b.c")).toBe(false);
    expect(verifySlackOauthState(SECRET, null)).toBe(false);
    expect(verifySlackOauthState(SECRET, undefined)).toBe(false);
  });

  it("fails closed on an empty signing secret", () => {
    const state = signSlackOauthState(SECRET);
    expect(verifySlackOauthState("", state)).toBe(false);
  });

  it("MUTATION CHECK — proves the expiry check has teeth: an always-fresh clock makes an expired state pass; this test documents the expectation the implementation must satisfy", () => {
    // This test intentionally re-derives what "expired" means rather than
    // trusting the earlier "rejects...expiry" test alone — a regression
    // that always evaluates `now` as `opts.now ?? Date.now()` but drops the
    // `exp > now` comparison (e.g. `true` unconditionally after signature
    // check) would still pass every OTHER test above but fail this one,
    // since it directly re-signs a state, fast-forwards time, and demands
    // rejection.
    const state = signSlackOauthState(SECRET, { now: 0 });
    expect(verifySlackOauthState(SECRET, state, { now: 24 * 60 * 60 * 1000 })).toBe(false);
  });
});

describe("buildSlackOauthAccessBody", () => {
  it("form-encodes exactly the four fields oauth.v2.access needs, as one object", () => {
    const body = buildSlackOauthAccessBody({
      clientId: "CLIENT123",
      clientSecret: "SECRETXYZ",
      code: "auth-code-abc",
      redirectUri: "https://www.heyjace.com/api/v1/connectors/slack/callback",
    });
    expect(Object.fromEntries(body.entries())).toEqual({
      client_id: "CLIENT123",
      client_secret: "SECRETXYZ",
      code: "auth-code-abc",
      redirect_uri: "https://www.heyjace.com/api/v1/connectors/slack/callback",
    });
  });
});

const FULL_OK_RESPONSE = {
  ok: true,
  access_token: "xoxb-fake-token",
  bot_user_id: "U0BOT123",
  team: { id: "T0TEAM1", name: "Acme Corp" },
  authed_user: { id: "U0AUTHED1" },
  scope: "chat:write,channels:history",
  is_enterprise_install: false,
};

describe("normalizeSlackOauthResponse — success", () => {
  it("normalizes a full, valid response into the exact installation candidate object", () => {
    expect(normalizeSlackOauthResponse(FULL_OK_RESPONSE)).toEqual({
      ok: true,
      installation: {
        teamId: "T0TEAM1",
        teamName: "Acme Corp",
        botToken: "xoxb-fake-token",
        botUserId: "U0BOT123",
        installedBySlackUserId: "U0AUTHED1",
        scopes: "chat:write,channels:history",
        enterpriseId: null,
      },
    });
  });

  it("records a non-null enterprise_id for a single-workspace install that merely sits inside a Grid org (is_enterprise_install still false)", () => {
    const result = normalizeSlackOauthResponse({
      ...FULL_OK_RESPONSE,
      enterprise: { id: "E0ORG1", name: "Acme Enterprise" },
    });
    expect(result).toEqual({
      ok: true,
      installation: {
        teamId: "T0TEAM1",
        teamName: "Acme Corp",
        botToken: "xoxb-fake-token",
        botUserId: "U0BOT123",
        installedBySlackUserId: "U0AUTHED1",
        scopes: "chat:write,channels:history",
        enterpriseId: "E0ORG1",
      },
    });
  });

  it("tolerates a missing optional team.name / authed_user / scope, normalizing to null", () => {
    const result = normalizeSlackOauthResponse({
      ok: true,
      access_token: "xoxb-fake-token",
      bot_user_id: "U0BOT123",
      team: { id: "T0TEAM1" },
      is_enterprise_install: false,
    });
    expect(result).toEqual({
      ok: true,
      installation: {
        teamId: "T0TEAM1",
        teamName: null,
        botToken: "xoxb-fake-token",
        botUserId: "U0BOT123",
        installedBySlackUserId: null,
        scopes: null,
        enterpriseId: null,
      },
    });
  });
});

describe("normalizeSlackOauthResponse — ok: false from Slack", () => {
  it("surfaces Slack's own short error enum, and carries no installation field at all", () => {
    const result = normalizeSlackOauthResponse({ ok: false, error: "invalid_code" });
    expect(result).toEqual({ ok: false, reason: "not_ok", slackError: "invalid_code" });
  });

  it("handles ok: false with no error string too", () => {
    const result = normalizeSlackOauthResponse({ ok: false });
    expect(result).toEqual({ ok: false, reason: "not_ok" });
  });
});

describe("normalizeSlackOauthResponse — Enterprise Grid refusal (spec §5)", () => {
  it("refuses is_enterprise_install: true even though every other field is fully populated", () => {
    const result = normalizeSlackOauthResponse({ ...FULL_OK_RESPONSE, is_enterprise_install: true });
    expect(result).toEqual({ ok: false, reason: "enterprise_install" });
  });

  it("MUTATION CHECK — proves the Grid guard has teeth: this fixture MUST be rejected; removing the is_enterprise_install branch (or reordering it after field extraction) would make this pass through as ok: true instead", () => {
    const gridResponse = { ...FULL_OK_RESPONSE, is_enterprise_install: true, enterprise: { id: "E0ORG1" } };
    const result = normalizeSlackOauthResponse(gridResponse);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("enterprise_install");
    }
  });
});

describe("normalizeSlackOauthResponse — a 2xx body missing required fields is a failure, never a partial write", () => {
  it("missing access_token", () => {
    const { access_token, ...rest } = FULL_OK_RESPONSE;
    void access_token;
    expect(normalizeSlackOauthResponse(rest)).toEqual({ ok: false, reason: "missing_fields" });
  });

  it("missing bot_user_id", () => {
    const { bot_user_id, ...rest } = FULL_OK_RESPONSE;
    void bot_user_id;
    expect(normalizeSlackOauthResponse(rest)).toEqual({ ok: false, reason: "missing_fields" });
  });

  it("missing team.id (team present but no id)", () => {
    expect(
      normalizeSlackOauthResponse({ ...FULL_OK_RESPONSE, team: { name: "Acme Corp" } })
    ).toEqual({ ok: false, reason: "missing_fields" });
  });

  it("missing team entirely", () => {
    const { team, ...rest } = FULL_OK_RESPONSE;
    void team;
    expect(normalizeSlackOauthResponse(rest)).toEqual({ ok: false, reason: "missing_fields" });
  });

  it("non-object body (null, string, primitive) is missing_fields, not a thrown error", () => {
    expect(normalizeSlackOauthResponse(null)).toEqual({ ok: false, reason: "missing_fields" });
    expect(normalizeSlackOauthResponse("not json")).toEqual({ ok: false, reason: "missing_fields" });
    expect(normalizeSlackOauthResponse(undefined)).toEqual({ ok: false, reason: "missing_fields" });
  });

  it("an array body is technically an object but has no ok: true, so it falls into not_ok — never thrown, never a partial write", () => {
    expect(normalizeSlackOauthResponse([1, 2, 3])).toEqual({ ok: false, reason: "not_ok" });
  });
});

describe("renderSlackConnectedPage", () => {
  it("tells the user to /invite @Jace and mention it", () => {
    const html = renderSlackConnectedPage("Acme Corp");
    expect(html).toContain("/invite @Jace");
    expect(html).toContain("mention");
    expect(html).toContain("Acme Corp");
  });

  it("renders without a team name too", () => {
    const html = renderSlackConnectedPage(null);
    expect(html).toContain("Jace is connected");
    expect(html).toContain("/invite @Jace");
  });

  it("HTML-escapes a hostile team name rather than injecting it raw", () => {
    const html = renderSlackConnectedPage('<script>alert(1)</script>"');
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderSlackErrorPage", () => {
  it("escapes both title and body", () => {
    const html = renderSlackErrorPage("<b>Title</b>", "<i>Body</i>");
    expect(html).not.toContain("<b>Title</b>");
    expect(html).not.toContain("<i>Body</i>");
    expect(html).toContain("&lt;b&gt;Title&lt;/b&gt;");
  });
});
