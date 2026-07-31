import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyConnectorCredential } from "./verify";
import type { ConnectorCatalogEntry } from "../../../../../../../app/(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers";

/**
 * Task 7 (debugging design spec): `verify.ts` had no dedicated test file
 * before this task — every case was only exercised indirectly (or not at
 * all) through `secret/route.test.ts`, which never mocks `global.fetch`.
 * This file adds direct coverage for the Railway branch specifically (the
 * one this task adds), mirroring the `global.fetch` swap-and-restore idiom
 * already used by `github.test.ts` / `github-repos.test.ts`. It does not
 * attempt to backfill coverage for the pre-existing Linear/Figma branches —
 * out of scope for this task.
 */

function railwayResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("verifyConnectorCredential('railway', ...)", () => {
  it("posts to Railway's GraphQL endpoint with Authorization: Bearer <token> and the docs' own me{name email} query", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return railwayResponse(200, { data: { me: { name: "Ada", email: "ada@example.com" } } });
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential(
      "railway",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6"
    );

    expect(res).toEqual({ ok: true });
    expect(capturedUrl).toBe("https://backboard.railway.com/graphql/v2");
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(
      "Bearer 3fa85f64-5717-4562-b3fc-2c963f66afa6"
    );
    const body = JSON.parse(String(capturedInit?.body)) as { query: string };
    expect(body.query).toBe("query { me { name email } }");
  });

  it("accepts a response carrying only `name` (not `email`)", async () => {
    global.fetch = (async () =>
      railwayResponse(200, { data: { me: { name: "Ada" } } })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("railway", "any-token");
    expect(res).toEqual({ ok: true });
  });

  it("rejects on HTTP 401", async () => {
    global.fetch = (async () => railwayResponse(401, {})) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("railway", "bad-token");
    expect(res).toEqual({ ok: false, error: "Railway rejected this token." });
  });

  it("rejects on HTTP 403", async () => {
    global.fetch = (async () => railwayResponse(403, {})) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("railway", "bad-token");
    expect(res).toEqual({ ok: false, error: "Railway rejected this token." });
  });

  it("rejects a 200 body carrying a GraphQL errors array (no data.me)", async () => {
    global.fetch = (async () =>
      railwayResponse(200, { errors: [{ message: "Not Authorized" }] })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("railway", "some-token");
    expect(res).toEqual({ ok: false, error: "Railway rejected this token." });
  });

  it("rejects a 200 body with neither data.me.name nor data.me.email present", async () => {
    global.fetch = (async () => railwayResponse(200, { data: { me: {} } })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("railway", "some-token");
    expect(res).toEqual({ ok: false, error: "Railway rejected this token." });
  });

  it("reports a non-2xx, non-401/403 status with its HTTP code", async () => {
    global.fetch = (async () => railwayResponse(500, {})) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("railway", "some-token");
    expect(res).toEqual({ ok: false, error: "Couldn't verify with Railway (HTTP 500)." });
  });

  it("reports an unreachable upstream (thrown fetch) with a retry hint, never throwing itself", async () => {
    global.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("railway", "some-token");
    expect(res).toEqual({
      ok: false,
      error: "Couldn't reach Railway to verify the token — try again.",
    });
  });

  it("trims the token before sending it", async () => {
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return railwayResponse(200, { data: { me: { email: "a@b.com" } } });
    }) as unknown as typeof fetch;

    await verifyConnectorCredential("railway", "  3fa85f64-5717-4562-b3fc-2c963f66afa6  ");
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(
      "Bearer 3fa85f64-5717-4562-b3fc-2c963f66afa6"
    );
  });
});

/**
 * Task P2: langfuse verify — `GET {host}/api/public/projects`, HTTP Basic
 * auth (public key as username, secret key as password). The `config`
 * parameter (this module's own doc-comment, "LANGFUSE HOST — THE ORDERING
 * GAP") is where `langfuseHost` comes from — never a persisted connector
 * row at this call site.
 */
describe("verifyConnectorCredential('langfuse', ...)", () => {
  const HOST = "https://cloud.langfuse.com";
  const PUBLIC_KEY = "pk-lf-abc123";
  const SECRET_KEY = "sk-lf-def456";
  const SECRET = `${PUBLIC_KEY}:${SECRET_KEY}`;
  const EXPECTED_AUTH = `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64")}`;

  function projectsResponse(status: number, body: unknown = {}) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  it("GETs {host}/api/public/projects with HTTP Basic auth built from the split public:secret key pair", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return projectsResponse(200, { data: [{ id: "proj-1" }] });
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("langfuse", SECRET, undefined, {
      langfuseHost: HOST,
    });

    expect(res).toEqual({ ok: true });
    expect(capturedUrl).toBe(`${HOST}/api/public/projects`);
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(EXPECTED_AUTH);
  });

  it("fails closed with a clear error and never calls fetch when config.langfuseHost is absent", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("langfuse", SECRET, undefined, {});
    expect(res).toEqual({ ok: false, error: "Set the Langfuse host before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed and never calls fetch when config itself is undefined (no 4th argument at all)", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("langfuse", SECRET);
    expect(res).toEqual({ ok: false, error: "Set the Langfuse host before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on a langfuseHost that isn't a valid URL", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await verifyConnectorCredential("langfuse", SECRET, undefined, {
      langfuseHost: "not-a-url",
    });
    expect(res).toEqual({ ok: false, error: "Set the Langfuse host before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on a non-http(s) scheme (defensive re-gate — this value has not passed validateUrlConfigString yet)", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await verifyConnectorCredential("langfuse", SECRET, undefined, {
      langfuseHost: "javascript:alert(1)",
    });
    expect(res).toEqual({ ok: false, error: "Set the Langfuse host before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("strips a trailing slash from the host before building the URL", async () => {
    let capturedUrl = "";
    global.fetch = (async (url: string) => {
      capturedUrl = String(url);
      return projectsResponse(200, { data: [] });
    }) as unknown as typeof fetch;

    await verifyConnectorCredential("langfuse", SECRET, undefined, { langfuseHost: `${HOST}/` });
    expect(capturedUrl).toBe(`${HOST}/api/public/projects`);
  });

  it("rejects on HTTP 401", async () => {
    global.fetch = (async () => projectsResponse(401)) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("langfuse", SECRET, undefined, { langfuseHost: HOST });
    expect(res).toEqual({ ok: false, error: "Langfuse rejected these API keys." });
  });

  it("rejects on HTTP 403", async () => {
    global.fetch = (async () => projectsResponse(403)) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("langfuse", SECRET, undefined, { langfuseHost: HOST });
    expect(res).toEqual({ ok: false, error: "Langfuse rejected these API keys." });
  });

  it("reports a non-2xx, non-401/403 status with its HTTP code", async () => {
    global.fetch = (async () => projectsResponse(500)) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("langfuse", SECRET, undefined, { langfuseHost: HOST });
    expect(res).toEqual({ ok: false, error: "Couldn't verify with Langfuse (HTTP 500)." });
  });

  it("reports an unreachable upstream (thrown fetch) with a retry hint, never throwing itself", async () => {
    global.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("langfuse", SECRET, undefined, { langfuseHost: HOST });
    expect(res).toEqual({
      ok: false,
      error: "Couldn't reach Langfuse to verify the keys — try again.",
    });
  });

  it("rejects a malformed composite secret (wrong part count) before ever reading config or calling fetch", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await verifyConnectorCredential("langfuse", "only-one-part", undefined, {
      langfuseHost: HOST,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("2 parts");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * Task P3: sentry verify — `GET /api/0/projects/{org}/{project}/`, `Bearer`
 * auth. Unlike langfuse above, `secret` is a SINGLE token (no composite
 * split); `config` carries BOTH `sentryOrg` and `sentryProject` — the same
 * "not yet persisted" ordering gap Task P2 hit first (this module's own
 * doc-comment, "LANGFUSE HOST — THE ORDERING GAP"), now with two keys
 * instead of one.
 */
describe("verifyConnectorCredential('sentry', ...)", () => {
  const TOKEN = "sntrys_abc123";
  const ORG = "acme";
  const PROJECT = "web";

  function projectResponse(status: number, body: unknown = {}) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  it("GETs /api/0/projects/{org}/{project}/ with Bearer auth built from the token", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return projectResponse(200, { id: "123", slug: PROJECT });
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("sentry", TOKEN, undefined, {
      sentryOrg: ORG,
      sentryProject: PROJECT,
    });

    expect(res).toEqual({ ok: true });
    expect(capturedUrl).toBe(`https://sentry.io/api/0/projects/${ORG}/${PROJECT}/`);
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("URL-encodes org and project when building the path", async () => {
    let capturedUrl = "";
    global.fetch = (async (url: string) => {
      capturedUrl = String(url);
      return projectResponse(200, {});
    }) as unknown as typeof fetch;

    await verifyConnectorCredential("sentry", TOKEN, undefined, {
      sentryOrg: "my org",
      sentryProject: "my/project",
    });
    expect(capturedUrl).toBe(
      `https://sentry.io/api/0/projects/${encodeURIComponent("my org")}/${encodeURIComponent("my/project")}/`
    );
  });

  it("fails closed with a distinct error and never calls fetch when config.sentryOrg is absent", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("sentry", TOKEN, undefined, { sentryProject: PROJECT });
    expect(res).toEqual({ ok: false, error: "Set the Sentry organization before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed with a distinct error and never calls fetch when config.sentryProject is absent (org present)", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("sentry", TOKEN, undefined, { sentryOrg: ORG });
    expect(res).toEqual({ ok: false, error: "Set the Sentry project before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks org before project — org-missing error wins when BOTH are absent", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("sentry", TOKEN, undefined, {});
    expect(res).toEqual({ ok: false, error: "Set the Sentry organization before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed and never calls fetch when config itself is undefined (no 4th argument at all)", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("sentry", TOKEN);
    expect(res).toEqual({ ok: false, error: "Set the Sentry organization before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only sentryOrg as absent", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await verifyConnectorCredential("sentry", TOKEN, undefined, {
      sentryOrg: "   ",
      sentryProject: PROJECT,
    });
    expect(res).toEqual({ ok: false, error: "Set the Sentry organization before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects on HTTP 401", async () => {
    global.fetch = (async () => projectResponse(401)) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("sentry", TOKEN, undefined, {
      sentryOrg: ORG,
      sentryProject: PROJECT,
    });
    expect(res).toEqual({ ok: false, error: "Sentry rejected this token." });
  });

  it("rejects on HTTP 403", async () => {
    global.fetch = (async () => projectResponse(403)) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("sentry", TOKEN, undefined, {
      sentryOrg: ORG,
      sentryProject: PROJECT,
    });
    expect(res).toEqual({ ok: false, error: "Sentry rejected this token." });
  });

  it("rejects on HTTP 404 (org or project not found / not accessible) with its HTTP code", async () => {
    global.fetch = (async () => projectResponse(404)) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("sentry", TOKEN, undefined, {
      sentryOrg: ORG,
      sentryProject: PROJECT,
    });
    expect(res).toEqual({ ok: false, error: "Couldn't verify with Sentry (HTTP 404)." });
  });

  it("reports a non-2xx, non-401/403 status with its HTTP code", async () => {
    global.fetch = (async () => projectResponse(500)) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("sentry", TOKEN, undefined, {
      sentryOrg: ORG,
      sentryProject: PROJECT,
    });
    expect(res).toEqual({ ok: false, error: "Couldn't verify with Sentry (HTTP 500)." });
  });

  it("reports an unreachable upstream (thrown fetch) with a retry hint, never throwing itself", async () => {
    global.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("sentry", TOKEN, undefined, {
      sentryOrg: ORG,
      sentryProject: PROJECT,
    });
    expect(res).toEqual({
      ok: false,
      error: "Couldn't reach Sentry to verify the token — try again.",
    });
  });

  it("trims the token before sending it", async () => {
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return projectResponse(200, {});
    }) as unknown as typeof fetch;

    await verifyConnectorCredential("sentry", `  ${TOKEN}  `, undefined, {
      sentryOrg: ORG,
      sentryProject: PROJECT,
    });
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("single-part credential — no composite split involved, unaffected by the generic split-before-dispatch mechanism", async () => {
    // sentry declares no secretParts in the real catalog, so
    // splitCompositeSecret's passthrough makes split.parts[0] === the
    // trimmed token, same as railway's own single-part precedent.
    global.fetch = (async () => projectResponse(200, {})) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("sentry", TOKEN, undefined, {
      sentryOrg: ORG,
      sentryProject: PROJECT,
    });
    expect(res).toEqual({ ok: true });
  });
});

/**
 * Task P4: datadog verify — `GET https://api.<site>/api/v2/validate_keys`,
 * `DD-API-KEY`/`DD-APPLICATION-KEY` headers built from the split
 * `apiKey:appKey` composite. `config` carries `datadogSite` — the same
 * "not yet persisted" ordering gap Langfuse/Sentry hit first — but UNLIKE
 * either of those, this module also re-validates the value against a
 * closed site allowlist (not just a scheme/non-empty check), since
 * `datadogSite` never passes through `validateUrlConfigString` at write
 * time at all.
 */
describe("verifyConnectorCredential('datadog', ...)", () => {
  const API_KEY = "a".repeat(32);
  const APP_KEY = "b".repeat(40);
  const SECRET = `${API_KEY}:${APP_KEY}`;
  const SITE = "datadoghq.com";

  function validateKeysResponse(status: number, body: unknown = {}) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  it("GETs https://api.<site>/api/v2/validate_keys with DD-API-KEY/DD-APPLICATION-KEY headers built from the split apiKey:appKey pair", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return validateKeysResponse(200, { status: "ok" });
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("datadog", SECRET, undefined, { datadogSite: SITE });

    expect(res).toEqual({ ok: true });
    expect(capturedUrl).toBe(`https://api.${SITE}/api/v2/validate_keys`);
    expect((capturedInit?.headers as Record<string, string>)?.["DD-API-KEY"]).toBe(API_KEY);
    expect((capturedInit?.headers as Record<string, string>)?.["DD-APPLICATION-KEY"]).toBe(APP_KEY);
  });

  it("fails closed with a clear error and never calls fetch when config.datadogSite is absent", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("datadog", SECRET, undefined, {});
    expect(res).toEqual({ ok: false, error: "Set a valid Datadog site before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed and never calls fetch when config itself is undefined (no 4th argument at all)", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("datadog", SECRET);
    expect(res).toEqual({ ok: false, error: "Set a valid Datadog site before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on a datadogSite value that isn't on the documented allowlist — this value never passed a scheme/URL check at write time, so this is the ONLY gate", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await verifyConnectorCredential("datadog", SECRET, undefined, {
      datadogSite: "evil.example.com",
    });
    expect(res).toEqual({ ok: false, error: "Set a valid Datadog site before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is case-insensitive on the stored site value", async () => {
    let capturedUrl = "";
    global.fetch = (async (url: string) => {
      capturedUrl = String(url);
      return validateKeysResponse(200, { status: "ok" });
    }) as unknown as typeof fetch;
    await verifyConnectorCredential("datadog", SECRET, undefined, { datadogSite: "DataDogHQ.COM" });
    expect(capturedUrl).toBe("https://api.datadoghq.com/api/v2/validate_keys");
  });

  it("rejects on HTTP 401", async () => {
    global.fetch = (async () => validateKeysResponse(401)) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("datadog", SECRET, undefined, { datadogSite: SITE });
    expect(res).toEqual({ ok: false, error: "Datadog rejected these API keys." });
  });

  it("rejects on HTTP 403", async () => {
    global.fetch = (async () => validateKeysResponse(403)) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("datadog", SECRET, undefined, { datadogSite: SITE });
    expect(res).toEqual({ ok: false, error: "Datadog rejected these API keys." });
  });

  it("reports a non-2xx, non-401/403 status with its HTTP code", async () => {
    global.fetch = (async () => validateKeysResponse(500)) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("datadog", SECRET, undefined, { datadogSite: SITE });
    expect(res).toEqual({ ok: false, error: "Couldn't verify with Datadog (HTTP 500)." });
  });

  it("reports an unreachable upstream (thrown fetch) with a retry hint, never throwing itself", async () => {
    global.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("datadog", SECRET, undefined, { datadogSite: SITE });
    expect(res).toEqual({
      ok: false,
      error: "Couldn't reach Datadog to verify the keys — try again.",
    });
  });

  it("rejects a malformed composite secret (wrong part count) before ever reading config or calling fetch", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await verifyConnectorCredential("datadog", "only-one-part", undefined, {
      datadogSite: SITE,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("2 parts");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * Task P5: prometheus verify — a THREE-LEG fallback chain (buildinfo →
 * `/-/ready` → a trivial `vector(1)` instant query), unlike every prior
 * Wave-2 provider's single-endpoint verify. `secret` is a SINGLE field
 * (no composite split) that is EITHER a bearer token OR a `user:pass`
 * pair, disambiguated by a colon-presence heuristic — see
 * `lib/evidence/prometheus.ts`'s own doc-comment ("AUTH HEURISTIC").
 */
describe("verifyConnectorCredential('prometheus', ...)", () => {
  const URL_BASE = "https://prometheus.internal:9090";
  const BEARER = "sometoken1234567890";
  const BASIC = "myuser:mypass";

  it("leg 1 (buildinfo) succeeds: GETs {url}/api/v1/status/buildinfo with Authorization: Bearer <token>", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({ status: "success", data: {} }) };
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("prometheus", BEARER, undefined, { prometheusUrl: URL_BASE });

    expect(res).toEqual({ ok: true });
    expect(capturedUrl).toBe(`${URL_BASE}/api/v1/status/buildinfo`);
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${BEARER}`);
  });

  it("uses Basic auth (base64 of user:pass) when the secret contains a colon", async () => {
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({ status: "success" }) };
    }) as unknown as typeof fetch;

    await verifyConnectorCredential("prometheus", BASIC, undefined, { prometheusUrl: URL_BASE });
    const expected = `Basic ${Buffer.from(BASIC).toString("base64")}`;
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(expected);
  });

  it("falls back to /-/ready when buildinfo 404s (an older/hardened Prometheus)", async () => {
    const calledPaths: string[] = [];
    global.fetch = (async (url: string) => {
      const path = new URL(String(url)).pathname;
      calledPaths.push(path);
      if (path === "/api/v1/status/buildinfo") return { ok: false, status: 404, json: async () => ({}) };
      if (path === "/-/ready") return { ok: true, status: 200, json: async () => ({}) };
      throw new Error("should not reach the third leg");
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("prometheus", BEARER, undefined, { prometheusUrl: URL_BASE });
    expect(res).toEqual({ ok: true });
    expect(calledPaths).toEqual(["/api/v1/status/buildinfo", "/-/ready"]);
  });

  it("falls back all the way to the trivial instant query (vector(1)) when BOTH buildinfo and /-/ready 404", async () => {
    const calledPaths: string[] = [];
    global.fetch = (async (url: string) => {
      const parsed = new URL(String(url));
      calledPaths.push(parsed.pathname);
      if (parsed.pathname === "/api/v1/status/buildinfo") return { ok: false, status: 404, json: async () => ({}) };
      if (parsed.pathname === "/-/ready") return { ok: false, status: 404, json: async () => ({}) };
      if (parsed.pathname === "/api/v1/query") {
        expect(parsed.searchParams.get("query")).toBe("vector(1)");
        return { ok: true, status: 200, json: async () => ({ status: "success", data: {} }) };
      }
      throw new Error("unexpected URL");
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("prometheus", BEARER, undefined, { prometheusUrl: URL_BASE });
    expect(res).toEqual({ ok: true });
    expect(calledPaths).toEqual(["/api/v1/status/buildinfo", "/-/ready", "/api/v1/query"]);
  });

  it("fails with the final leg's own HTTP status when all three legs are non-2xx, non-401/403", async () => {
    global.fetch = (async (url: string) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/v1/query") return { ok: false, status: 500, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("prometheus", BEARER, undefined, { prometheusUrl: URL_BASE });
    expect(res).toEqual({ ok: false, error: "Couldn't verify with Prometheus (HTTP 500)." });
  });

  it("fails FAST on a 401 at the FIRST leg — never tries /-/ready or the trivial query with the same rejected credential", async () => {
    const calledPaths: string[] = [];
    global.fetch = (async (url: string) => {
      calledPaths.push(new URL(String(url)).pathname);
      return { ok: false, status: 401, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("prometheus", BEARER, undefined, { prometheusUrl: URL_BASE });
    expect(res).toEqual({ ok: false, error: "Prometheus rejected this credential." });
    expect(calledPaths).toEqual(["/api/v1/status/buildinfo"]);
  });

  it("also fails fast on a 403 at the SECOND leg (buildinfo 404'd first)", async () => {
    const calledPaths: string[] = [];
    global.fetch = (async (url: string) => {
      const path = new URL(String(url)).pathname;
      calledPaths.push(path);
      if (path === "/api/v1/status/buildinfo") return { ok: false, status: 404, json: async () => ({}) };
      return { ok: false, status: 403, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("prometheus", BEARER, undefined, { prometheusUrl: URL_BASE });
    expect(res).toEqual({ ok: false, error: "Prometheus rejected this credential." });
    expect(calledPaths).toEqual(["/api/v1/status/buildinfo", "/-/ready"]);
  });

  it("a thrown/network-error first leg falls through to the next leg rather than failing immediately", async () => {
    const calledPaths: string[] = [];
    global.fetch = (async (url: string) => {
      const path = new URL(String(url)).pathname;
      calledPaths.push(path);
      if (path === "/api/v1/status/buildinfo") throw new Error("network down");
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("prometheus", BEARER, undefined, { prometheusUrl: URL_BASE });
    expect(res).toEqual({ ok: true });
    expect(calledPaths).toEqual(["/api/v1/status/buildinfo", "/-/ready"]);
  });

  it("reports an unreachable upstream (every leg throws) with a retry hint, never throwing itself", async () => {
    global.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("prometheus", BEARER, undefined, { prometheusUrl: URL_BASE });
    expect(res).toEqual({
      ok: false,
      error: "Couldn't reach Prometheus to verify the credential — try again.",
    });
  });

  it("fails closed with a clear error and never calls fetch when config.prometheusUrl is absent", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("prometheus", BEARER, undefined, {});
    expect(res).toEqual({ ok: false, error: "Set the Prometheus base URL before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed and never calls fetch when config itself is undefined (no 4th argument at all)", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("prometheus", BEARER);
    expect(res).toEqual({ ok: false, error: "Set the Prometheus base URL before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on a non-http(s) scheme (defensive re-gate — reuses the existing resolveHttpUrl, same as langfuse)", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await verifyConnectorCredential("prometheus", BEARER, undefined, {
      prometheusUrl: "javascript:alert(1)",
    });
    expect(res).toEqual({ ok: false, error: "Set the Prometheus base URL before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a private/internal host (self-hosted Prometheus — only the scheme is gated, never the host)", async () => {
    global.fetch = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("prometheus", BEARER, undefined, {
      prometheusUrl: "http://prometheus.internal:9090",
    });
    expect(res).toEqual({ ok: true });
  });

  it("does NOT go through splitCompositeSecret's exact-part-count model — a user:pass:word triple survives whole (no catalog secretParts declared for this kind)", async () => {
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;

    await verifyConnectorCredential("prometheus", "myuser:my:pass:word", undefined, { prometheusUrl: URL_BASE });
    const expected = `Basic ${Buffer.from("myuser:my:pass:word").toString("base64")}`;
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(expected);
  });
});

/**
 * Task P6: grafana verify — a SINGLE endpoint (`GET /api/org`, confirmed the
 * one of the two candidates — /api/org vs /api/user — that actually accepts
 * a service account token), unlike prometheus's three-leg fallback chain
 * above. `secret` is a SINGLE field (no composite split), accepting EITHER a
 * glsa_-prefixed service account token or a legacy eyJ-prefixed API key —
 * both use the IDENTICAL Bearer scheme, so unlike prometheus's own
 * bearer-vs-Basic heuristic there is nothing to disambiguate here.
 */
describe("verifyConnectorCredential('grafana', ...)", () => {
  const URL_BASE = "https://grafana.internal:3000";
  // FIXTURE, deliberately non-realistic: built from an obviously-fake body
  // ("TESTFIXTURE"/repeated digits, or — for the eyJ… legacy-key shape
  // below — the base64 of a nonsense JSON object) specifically so GitHub
  // push protection's secret scanner never flags it. Do NOT "fix" these to
  // look more like a real token/key — that is what gets them flagged.
  const TOKEN = "glsa_TESTFIXTURE0000000000000000000000AB";

  it("succeeds: GETs {url}/api/org with Authorization: Bearer <token>", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("grafana", TOKEN, undefined, { grafanaUrl: URL_BASE });

    expect(res).toEqual({ ok: true });
    expect(capturedUrl).toBe(`${URL_BASE}/api/org`);
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("sends the SAME Bearer scheme for a legacy eyJ-prefixed API key too", async () => {
    let capturedInit: RequestInit | undefined;
    // base64 of {"TEST":"fixture-not-a-key"} — NOT the {"k":...,"n":...,
    // "id":...} shape a real legacy Grafana API key decodes to.
    const legacyKey = "eyJURVNUIjoiZml4dHVyZS1ub3QtYS1rZXkifQ==";
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;

    await verifyConnectorCredential("grafana", legacyKey, undefined, { grafanaUrl: URL_BASE });
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${legacyKey}`);
  });

  it("maps a 401 to a rejection error", async () => {
    global.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("grafana", TOKEN, undefined, { grafanaUrl: URL_BASE });
    expect(res).toEqual({ ok: false, error: "Grafana rejected this token." });
  });

  it("maps a 403 to the same rejection error", async () => {
    global.fetch = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("grafana", TOKEN, undefined, { grafanaUrl: URL_BASE });
    expect(res).toEqual({ ok: false, error: "Grafana rejected this token." });
  });

  it("surfaces a non-2xx/non-401/403 status with its own HTTP code", async () => {
    global.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("grafana", TOKEN, undefined, { grafanaUrl: URL_BASE });
    expect(res).toEqual({ ok: false, error: "Couldn't verify with Grafana (HTTP 500)." });
  });

  it("reports an unreachable upstream with a retry hint, never throwing itself", async () => {
    global.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("grafana", TOKEN, undefined, { grafanaUrl: URL_BASE });
    expect(res).toEqual({
      ok: false,
      error: "Couldn't reach Grafana to verify the token — try again.",
    });
  });

  it("fails closed with a clear error and never calls fetch when config.grafanaUrl is absent", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("grafana", TOKEN, undefined, {});
    expect(res).toEqual({ ok: false, error: "Set the Grafana base URL before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed and never calls fetch when config itself is undefined (no 4th argument at all)", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("grafana", TOKEN);
    expect(res).toEqual({ ok: false, error: "Set the Grafana base URL before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on a non-http(s) scheme (defensive re-gate — reuses the existing resolveHttpUrl, same as langfuse/prometheus)", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await verifyConnectorCredential("grafana", TOKEN, undefined, {
      grafanaUrl: "javascript:alert(1)",
    });
    expect(res).toEqual({ ok: false, error: "Set the Grafana base URL before connecting." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a private/internal host (self-hosted Grafana — only the scheme is gated, never the host)", async () => {
    global.fetch = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("grafana", TOKEN, undefined, {
      grafanaUrl: "http://grafana.internal:3000",
    });
    expect(res).toEqual({ ok: true });
  });

  it("does NOT go through splitCompositeSecret's exact-part-count model — no catalog secretParts declared for this kind", async () => {
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;

    await verifyConnectorCredential("grafana", TOKEN, undefined, { grafanaUrl: URL_BASE });
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

/**
 * Task P7: vercel verify — TWO legs, the token leg unconditional (`GET
 * /v2/user`) and the project leg CONDITIONAL on `config.vercelProjectId`
 * being present (`GET /v9/projects/{id}`) — see verify.ts's own doc-comment
 * ("VERCEL (Task P7)") for why this is additive rather than Sentry's
 * "both required values gate the ONE call" shape. `secret` is a SINGLE
 * field (no composite split).
 */
describe("verifyConnectorCredential('vercel', ...)", () => {
  // FIXTURE, deliberately non-realistic (Fix Round 1 — shape asserted
  // explicitly, per review): starts with `TESTFIXTURE_`, NOT `vcp_` — the
  // current, GitHub-secret-scanning-detected personal-access-token prefix
  // (see lib/evidence/vercel.ts's own doc-comment, "AUTH"); cannot match
  // that detector's prefix check by construction.
  const TOKEN = "TESTFIXTURE_vercel_token_0000000000000000";
  const PROJECT_ID = "prj_abc123";
  const TEAM_ID = "team_abc123";

  it("token-only: succeeds via GET /v2/user alone when no vercelProjectId is configured", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toBe("https://api.vercel.com/v2/user");
      return { ok: true, status: 200, json: async () => ({ user: { id: "u1" } }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("vercel", TOKEN, undefined, {});
    expect(res).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("token-only: succeeds when config itself is undefined (no 4th argument at all)", async () => {
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ user: { id: "u1" } }),
    })) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("vercel", TOKEN);
    expect(res).toEqual({ ok: true });
  });

  it("token leg sends Authorization: Bearer <token>", async () => {
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({ user: { id: "u1" } }) };
    }) as unknown as typeof fetch;

    await verifyConnectorCredential("vercel", TOKEN, undefined, {});
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("maps a 401 on the token leg to a rejection error, never reaching the project leg", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("vercel", TOKEN, undefined, { vercelProjectId: PROJECT_ID });
    expect(res).toEqual({ ok: false, error: "Vercel rejected this token." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a 403 on the token leg to the same rejection error", async () => {
    global.fetch = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("vercel", TOKEN, undefined, {});
    expect(res).toEqual({ ok: false, error: "Vercel rejected this token." });
  });

  it("surfaces a non-2xx/non-401/403 token-leg status with its own HTTP code", async () => {
    global.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("vercel", TOKEN, undefined, {});
    expect(res).toEqual({ ok: false, error: "Couldn't verify with Vercel (HTTP 500)." });
  });

  it("reports an unreachable token-leg upstream with a retry hint, never throwing itself", async () => {
    global.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("vercel", TOKEN, undefined, {});
    expect(res).toEqual({ ok: false, error: "Couldn't reach Vercel to verify the token — try again." });
  });

  it("project leg: when vercelProjectId is present, ALSO GETs /v9/projects/{id} and includes teamId when configured", async () => {
    const calledUrls: string[] = [];
    global.fetch = (async (url: string) => {
      calledUrls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ id: PROJECT_ID }) };
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("vercel", TOKEN, undefined, {
      vercelProjectId: PROJECT_ID,
      vercelTeamId: TEAM_ID,
    });

    expect(res).toEqual({ ok: true });
    expect(calledUrls).toEqual([
      "https://api.vercel.com/v2/user",
      `https://api.vercel.com/v9/projects/${PROJECT_ID}?teamId=${TEAM_ID}`,
    ]);
  });

  it("project leg omits teamId from the URL when vercelTeamId is absent (personal scope)", async () => {
    const calledUrls: string[] = [];
    global.fetch = (async (url: string) => {
      calledUrls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ id: PROJECT_ID }) };
    }) as unknown as typeof fetch;

    await verifyConnectorCredential("vercel", TOKEN, undefined, { vercelProjectId: PROJECT_ID });
    expect(calledUrls[1]).toBe(`https://api.vercel.com/v9/projects/${PROJECT_ID}`);
  });

  it("project leg 404 → a distinct, actionable 'project not found' error (a wrong project id is an operator config mistake, not a rejected credential)", async () => {
    global.fetch = (async (url: string) => {
      if (String(url).includes("/v9/projects/")) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ user: { id: "u1" } }) };
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("vercel", TOKEN, undefined, { vercelProjectId: PROJECT_ID });
    expect(res).toEqual({ ok: false, error: "Couldn't find this Vercel project — check the project ID." });
  });

  it("project leg 401/403 → the same 'rejected this token' error as the token leg", async () => {
    global.fetch = (async (url: string) => {
      if (String(url).includes("/v9/projects/")) {
        return { ok: false, status: 403, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ user: { id: "u1" } }) };
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("vercel", TOKEN, undefined, { vercelProjectId: PROJECT_ID });
    expect(res).toEqual({ ok: false, error: "Vercel rejected this token." });
  });

  it("project leg non-2xx/non-401/403/404 surfaces its own HTTP code", async () => {
    global.fetch = (async (url: string) => {
      if (String(url).includes("/v9/projects/")) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ user: { id: "u1" } }) };
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("vercel", TOKEN, undefined, { vercelProjectId: PROJECT_ID });
    expect(res).toEqual({ ok: false, error: "Couldn't verify with Vercel (HTTP 500)." });
  });

  it("reports an unreachable project-leg upstream with its own retry hint", async () => {
    global.fetch = (async (url: string) => {
      if (String(url).includes("/v9/projects/")) {
        throw new Error("network down");
      }
      return { ok: true, status: 200, json: async () => ({ user: { id: "u1" } }) };
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("vercel", TOKEN, undefined, { vercelProjectId: PROJECT_ID });
    expect(res).toEqual({ ok: false, error: "Couldn't reach Vercel to verify the project — try again." });
  });

  it("does NOT go through splitCompositeSecret's exact-part-count model — no catalog secretParts declared for this kind", async () => {
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({ user: { id: "u1" } }) };
    }) as unknown as typeof fetch;

    await verifyConnectorCredential("vercel", TOKEN, undefined, {});
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

/**
 * Task P8 (FINAL Wave-2 provider): cloudflare verify — a SINGLE leg
 * (`GET /client/v4/user/tokens/verify`), no `config` needed at all (unlike
 * every Wave-2 provider before Vercel's own unconditional token leg — see
 * verify.ts's own doc-comment, "CLOUDFLARE (Task P8)"). `secret` is a
 * SINGLE field (no composite split).
 */
describe("verifyConnectorCredential('cloudflare', ...)", () => {
  // FIXTURE, deliberately non-realistic (mirrors the vercel block's own
  // shared discipline above): starts with `TESTFIXTURE_`, not
  // `cfut_`/`cfat_`/`cfk_` — the current, GitHub-secret-scanning-detected
  // Cloudflare token prefixes (see cloudflare.ts's own doc-comment,
  // "AUTH"); cannot match those detectors' prefix checks by construction.
  const TOKEN = "TESTFIXTURE_cloudflare_token_00000000000000";

  it("posts to the confirmed token-verify endpoint with Authorization: Bearer <token>", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({ success: true, result: { id: "t1", status: "active" } }) };
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential("cloudflare", TOKEN);
    expect(res).toEqual({ ok: true });
    expect(capturedUrl).toBe("https://api.cloudflare.com/client/v4/user/tokens/verify");
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("succeeds even when config itself is undefined (no 4th argument at all) — this verify needs no config", async () => {
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { status: "active" } }),
    })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("cloudflare", TOKEN);
    expect(res).toEqual({ ok: true });
  });

  it("rejects a token whose status is 'disabled' even though success:true and HTTP 200 — success alone is not sufficient", async () => {
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { status: "disabled" } }),
    })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("cloudflare", TOKEN);
    expect(res).toEqual({ ok: false, error: "Cloudflare rejected this token." });
  });

  it("rejects a token whose status is 'expired'", async () => {
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { status: "expired" } }),
    })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("cloudflare", TOKEN);
    expect(res).toEqual({ ok: false, error: "Cloudflare rejected this token." });
  });

  it("rejects a body with success:false even on HTTP 200", async () => {
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: false, errors: [{ message: "invalid" }] }),
    })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("cloudflare", TOKEN);
    expect(res).toEqual({ ok: false, error: "Cloudflare rejected this token." });
  });

  it("maps a 401 to a rejection error", async () => {
    global.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("cloudflare", TOKEN);
    expect(res).toEqual({ ok: false, error: "Cloudflare rejected this token." });
  });

  it("maps a 403 to the same rejection error", async () => {
    global.fetch = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("cloudflare", TOKEN);
    expect(res).toEqual({ ok: false, error: "Cloudflare rejected this token." });
  });

  it("surfaces a non-2xx/non-401/403 status with its own HTTP code", async () => {
    global.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("cloudflare", TOKEN);
    expect(res).toEqual({ ok: false, error: "Couldn't verify with Cloudflare (HTTP 500)." });
  });

  it("reports an unreachable upstream with a retry hint, never throwing itself", async () => {
    global.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("cloudflare", TOKEN);
    expect(res).toEqual({ ok: false, error: "Couldn't reach Cloudflare to verify the token — try again." });
  });

  it("does NOT go through splitCompositeSecret's exact-part-count model — no catalog secretParts declared for this kind", async () => {
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({ success: true, result: { status: "active" } }) };
    }) as unknown as typeof fetch;

    await verifyConnectorCredential("cloudflare", TOKEN);
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

/**
 * Task P0: `verifyConnectorCredential` splits `secret` via
 * `splitCompositeSecret` BEFORE dispatching to any per-kind case — proven
 * here with a synthetic composite catalog entry (P0 adds no real composite
 * provider). A malformed composite secret is rejected before any network
 * call is attempted.
 */
describe("verifyConnectorCredential — generic split-before-dispatch (Task P0)", () => {
  const compositeEntry: ConnectorCatalogEntry = {
    kind: "context7",
    type: "mcp",
    connectMethod: "secret",
    label: "Composite Test",
    description: "test",
    availability: "available",
    capabilities: { ingest: false, postResult: false, notify: false },
    connect: {
      credentialLabel: "test",
      credentialPlaceholder: "test",
      credentialHint: "test",
      helpUrl: "https://example.com",
      setupSteps: [],
      secretParts: [{ name: "Public key" }, { name: "Secret key" }],
    },
  };

  it("rejects a malformed composite secret (wrong part count) WITHOUT ever calling fetch", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("context7", "only-one-part", [compositeEntry]);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("2 parts");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a well-formed composite secret with no matching case falls through to the harmless default (context7's own case, since P0 adds no real composite provider)", async () => {
    const res = await verifyConnectorCredential("context7", "pk-abc:sk-def", [compositeEntry]);
    expect(res).toEqual({ ok: true });
  });

  it("single-part providers are unaffected by the split — the default (real) catalog still verifies railway exactly as before", async () => {
    global.fetch = (async () =>
      railwayResponse(200, { data: { me: { email: "a@b.com" } } })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential(
      "railway",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6"
    );
    expect(res).toEqual({ ok: true });
  });
});
