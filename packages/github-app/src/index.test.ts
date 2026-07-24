import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import {
  resolveGithubAppConfig,
  signAppJwt,
  mintInstallationToken,
  getInstallationAccount,
  botCommitIdentity,
  listUserInstallations,
  getUserOrgRole,
} from "./index.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const ENV = {
  GITHUB_APP_ID: "12345",
  GITHUB_APP_SLUG: "jace",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_APP_BOT_USER_ID: "98765",
};

function b64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("resolveGithubAppConfig", () => {
  it("returns ok with all four values present", () => {
    const cfg = resolveGithubAppConfig(ENV as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ ok: true, appId: "12345", slug: "jace", botUserId: "98765" });
  });

  it("lists every missing var", () => {
    const cfg = resolveGithubAppConfig({} as NodeJS.ProcessEnv);
    expect(cfg.ok).toBe(false);
    if (!cfg.ok) {
      expect(cfg.missing).toEqual([
        "GITHUB_APP_ID",
        "GITHUB_APP_SLUG",
        "GITHUB_APP_PRIVATE_KEY",
        "GITHUB_APP_BOT_USER_ID",
      ]);
    }
  });

  it("normalizes literal \\n sequences in the private key (env-var transport)", () => {
    const cfg = resolveGithubAppConfig({
      ...ENV,
      GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n"),
    } as NodeJS.ProcessEnv);
    expect(cfg.ok).toBe(true);
    if (cfg.ok) expect(cfg.privateKey).toContain("\n");
  });
});

describe("signAppJwt", () => {
  it("produces an RS256 JWT with iss=appId, iat backdated 60s, exp 9min out", () => {
    const now = 1_800_000_000;
    const jwt = signAppJwt("12345", privateKey, now);
    const [h, p, s] = jwt.split(".");
    expect(b64urlJson(h)).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = b64urlJson(p);
    expect(payload).toEqual({ iss: "12345", iat: now - 60, exp: now + 540 });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    expect(verifier.verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });
});

describe("mintInstallationToken", () => {
  const cfg = { appId: "12345", privateKey };

  it("POSTs to the installation access_tokens endpoint with the app JWT and returns the token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ token: "ghs_abc", expires_at: "2026-07-24T12:00:00Z" }),
    });
    const res = await mintInstallationToken("777", cfg, fetchMock as unknown as typeof fetch);
    expect(res).toEqual({ ok: true, token: "ghs_abc", expiresAt: "2026-07-24T12:00:00Z" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/app/installations/777/access_tokens");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toMatch(/^Bearer eyJ/);
    expect(init.headers.Accept).toBe("application/vnd.github+json");
  });

  it("classifies 404 as not_installed (uninstall surfaces lazily here)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const res = await mintInstallationToken("777", cfg, fetchMock as unknown as typeof fetch);
    expect(res).toEqual({ ok: false, reason: "not_installed" });
  });

  it("classifies network failure as github_unreachable, other non-2xx as github_rejected", async () => {
    const boom = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    expect(await mintInstallationToken("777", cfg, boom as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: "github_unreachable",
    });
    const rejected = vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({}) });
    expect(await mintInstallationToken("777", cfg, rejected as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: "github_rejected",
    });
  });

  it("classifies a malformed private key (JWT signing throws) as github_rejected, without ever calling fetch", async () => {
    const fetchShouldNotBeCalled = vi.fn();
    const res = await mintInstallationToken(
      "777",
      { appId: "12345", privateKey: "not-a-pem" },
      fetchShouldNotBeCalled as unknown as typeof fetch
    );
    expect(res).toEqual({ ok: false, reason: "github_rejected" });
    expect(fetchShouldNotBeCalled).not.toHaveBeenCalled();
  });
});

describe("getInstallationAccount", () => {
  it("GETs the installation and returns account login/type", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ account: { login: "acme-org", type: "Organization" } }),
    });
    const res = await getInstallationAccount("777", { appId: "12345", privateKey }, fetchMock as unknown as typeof fetch);
    expect(res).toEqual({ ok: true, login: "acme-org", type: "Organization" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/app/installations/777");
  });
});

describe("botCommitIdentity", () => {
  it("builds the bot-user-id noreply identity (user id, NOT app id)", () => {
    expect(botCommitIdentity("jace", "98765")).toEqual({
      name: "jace[bot]",
      email: "98765+jace[bot]@users.noreply.github.com",
    });
  });
});

describe("listUserInstallations", () => {
  it("GETs /user/installations as the user token and maps id + account identity from the wrapper shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 2,
        installations: [
          { id: 111, account: { id: 555, login: "alice", type: "User" } },
          { id: 222, account: { id: 666, login: "acme-org", type: "Organization" } },
        ],
      }),
    });
    const res = await listUserInstallations(
      "gho_user_token",
      fetchMock as unknown as typeof fetch
    );
    expect(res).toEqual({
      ok: true,
      installations: [
        { id: "111", accountId: "555", accountLogin: "alice", accountType: "User" },
        { id: "222", accountId: "666", accountLogin: "acme-org", accountType: "Organization" },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/user/installations?per_page=100&page=1");
    expect(init.headers.Authorization).toBe("Bearer gho_user_token");
    expect(init.headers.Accept).toBe("application/vnd.github+json");
  });

  it("paginates per_page=100, stopping on the first short page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      account: { id: i + 1000, login: `user${i}`, type: "User" },
    }));
    const shortPage = [
      { id: 9999, account: { id: 8888, login: "last-user", type: "User" } },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ total_count: 101, installations: fullPage }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ total_count: 101, installations: shortPage }),
      });
    const res = await listUserInstallations(
      "gho_user_token",
      fetchMock as unknown as typeof fetch
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.installations).toHaveLength(101);
      expect(res.installations[100]).toEqual({
        id: "9999",
        accountId: "8888",
        accountLogin: "last-user",
        accountType: "User",
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.github.com/user/installations?per_page=100&page=2"
    );
  });

  it("classifies 401 as unauthorized (distinct from other rejections)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const res = await listUserInstallations(
      "expired_token",
      fetchMock as unknown as typeof fetch
    );
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("classifies a network throw as github_unreachable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const res = await listUserInstallations(
      "gho_user_token",
      fetchMock as unknown as typeof fetch
    );
    expect(res).toEqual({ ok: false, reason: "github_unreachable" });
  });

  it("classifies a forged-shape body (installations not an array) as github_rejected", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ total_count: 1, installations: "not-an-array" }),
    });
    const res = await listUserInstallations(
      "gho_user_token",
      fetchMock as unknown as typeof fetch
    );
    expect(res).toEqual({ ok: false, reason: "github_rejected" });
  });

  it("classifies other non-2xx as github_rejected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const res = await listUserInstallations(
      "gho_user_token",
      fetchMock as unknown as typeof fetch
    );
    expect(res).toEqual({ ok: false, reason: "github_rejected" });
  });
});

describe("getUserOrgRole", () => {
  it("GETs /user/memberships/orgs/{org} as the user token and parses role=admin", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ state: "active", role: "admin" }),
    });
    const res = await getUserOrgRole(
      "gho_user_token",
      "acme-org",
      fetchMock as unknown as typeof fetch
    );
    expect(res).toEqual({ ok: true, role: "admin" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/user/memberships/orgs/acme-org");
    expect(init.headers.Authorization).toBe("Bearer gho_user_token");
    expect(init.headers.Accept).toBe("application/vnd.github+json");
  });

  it("parses role=member as member", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ state: "active", role: "member" }),
    });
    const res = await getUserOrgRole(
      "gho_user_token",
      "acme-org",
      fetchMock as unknown as typeof fetch
    );
    expect(res).toEqual({ ok: true, role: "member" });
  });

  it("treats billing_manager (or any other role) as member, never admin", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ state: "active", role: "billing_manager" }),
    });
    const res = await getUserOrgRole(
      "gho_user_token",
      "acme-org",
      fetchMock as unknown as typeof fetch
    );
    expect(res).toEqual({ ok: true, role: "member" });
  });

  it("classifies 404 as not_a_member (caller isn't in the org at all)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const res = await getUserOrgRole(
      "gho_user_token",
      "acme-org",
      fetchMock as unknown as typeof fetch
    );
    expect(res).toEqual({ ok: false, reason: "not_a_member" });
  });

  it("classifies 401 as unauthorized", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const res = await getUserOrgRole(
      "expired_token",
      "acme-org",
      fetchMock as unknown as typeof fetch
    );
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("classifies a network throw as github_unreachable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const res = await getUserOrgRole(
      "gho_user_token",
      "acme-org",
      fetchMock as unknown as typeof fetch
    );
    expect(res).toEqual({ ok: false, reason: "github_unreachable" });
  });

  it("classifies other non-2xx as github_rejected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const res = await getUserOrgRole(
      "gho_user_token",
      "acme-org",
      fetchMock as unknown as typeof fetch
    );
    expect(res).toEqual({ ok: false, reason: "github_rejected" });
  });
});
