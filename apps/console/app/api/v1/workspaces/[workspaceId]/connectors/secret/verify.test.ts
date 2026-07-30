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
