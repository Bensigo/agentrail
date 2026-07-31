import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors prometheus.test.ts's/datadog.test.ts's mocking idiom (mock the
// package's named export directly) and its global.fetch idiom for the real
// HTTP calls.
vi.mock("@agentrail/db-postgres", () => ({
  getConnector: vi.fn(),
}));

import { getConnector } from "@agentrail/db-postgres";
import { grafanaAdapter } from "./grafana";
import { adapterFor } from "./registry";
import type { EvidenceQuery } from "./types";
// The ONLY place this test file imports the catalog and verify.ts — the
// adapter itself (grafana.ts) never does (leaf-independence precedent,
// established by every prior Wave-2 provider's own test file). Used by the
// drift-protection describe block near the bottom of this file.
import { CONNECTOR_CATALOG } from "../../app/(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers";
import { verifyConnectorCredential } from "../../app/api/v1/workspaces/[workspaceId]/connectors/secret/verify";

const mockGetConnector = vi.mocked(getConnector);

const WS = "00000000-0000-0000-0000-000000000001";
const URL_BASE = "https://grafana.internal:3000";
// A service-account-shaped secret (glsa_ prefix, confirmed current) — the
// default for every test not specifically about the two-shape format gate.
// FIXTURE, deliberately non-realistic: every credential-shaped literal in
// this file is built from an obviously-fake body ("TESTFIXTURE"/repeated
// digits, or — for the eyJ… legacy-key shape below — the base64 of a
// nonsense JSON object) specifically so GitHub push protection's secret
// scanner never flags it. Do NOT "fix" these to look more like a real
// token/key — that is what gets them flagged.
const SECRET = "glsa_TESTFIXTURE0000000000000000000000AB";
const WINDOW_START = "2026-07-29T00:00:00.000Z";
const WINDOW_END = "2026-07-29T23:59:59.000Z";
const WINDOW_START_MS = new Date(WINDOW_START).getTime();
const WINDOW_END_MS = new Date(WINDOW_END).getTime();

function q(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return {
    verb: "search_events",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    ...overrides,
  };
}

/** `null` means "omit grafanaUrl from config entirely". */
function connectorRow(grafanaUrl: string | null = URL_BASE) {
  return {
    provider: "grafana" as const,
    enabled: true,
    config: {
      repos: [],
      triggerLabel: "ready-for-agent",
      pollIntervalSeconds: 60,
      ...(grafanaUrl !== null ? { grafanaUrl } : {}),
    },
    hasSecret: true,
    updatedAt: null,
  };
}

function httpResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** One `/api/annotations` array element — confirmed shape (see grafana.ts's
 * own doc-comment, "SEARCH_EVENTS"). `alertId: 0` is a plain annotation;
 * non-zero is a Grafana-managed alert state change. */
function annotation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    alertId: 0,
    dashboardUID: "abc123",
    panelId: 2,
    userId: 1,
    userName: "",
    newState: "",
    prevState: "",
    time: WINDOW_END_MS,
    timeEnd: WINDOW_END_MS,
    text: "test annotation",
    tags: [],
    data: {},
    ...overrides,
  };
}

/** Routes every fetch mock call by pathname (only one path exists for this
 * adapter, mirroring prometheus.test.ts's single-path router) and lets the
 * caller inspect/branch on the captured URL. */
function routeFetch(handler?: (url: URL) => { status: number; body: unknown }) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    void _init;
    const parsed = new URL(url);
    if (parsed.pathname !== "/api/annotations") throw new Error(`unexpected URL: ${url}`);
    const h = handler ? handler(parsed) : { status: 200, body: [] };
    return httpResponse(h.status, h.body);
  });
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConnector.mockResolvedValue(connectorRow());
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("grafanaAdapter — shape", () => {
  it("declares provider 'grafana' and verbs [search_events] only", () => {
    expect(grafanaAdapter.provider).toBe("grafana");
    expect(grafanaAdapter.verbs).toEqual(["search_events"]);
  });

  it("self-registers into the shared registry on module load", () => {
    expect(adapterFor("grafana")).toBe(grafanaAdapter);
  });
});

describe("grafanaAdapter — bad_request validation", () => {
  it("degrades bad_request on an unparseable windowStart, without ever reading the connector row", async () => {
    const res = await grafanaAdapter.query(WS, q({ windowStart: "not-a-date" }), SECRET);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades bad_request on an unparseable windowEnd", async () => {
    const res = await grafanaAdapter.query(WS, q({ windowEnd: "" }), SECRET);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades bad_request for a verb this adapter does not declare", async () => {
    const res = await grafanaAdapter.query(WS, q({ verb: "signals" }), SECRET);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
  });
});

describe("grafanaAdapter — config_missing", () => {
  it("degrades config_missing when secret is null, without ever reading the connector row", async () => {
    const res = await grafanaAdapter.query(WS, q(), null);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades config_missing when there is no grafana connector row at all", async () => {
    mockGetConnector.mockResolvedValue(null);
    const res = await grafanaAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("degrades config_missing when the row exists but grafanaUrl is absent", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(null));
    const res = await grafanaAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("degrades config_missing when grafanaUrl is present but blank/whitespace-only", async () => {
    mockGetConnector.mockResolvedValue(connectorRow("   "));
    const res = await grafanaAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("reads the connector row for provider 'grafana' specifically", async () => {
    global.fetch = routeFetch() as unknown as typeof fetch;
    await grafanaAdapter.query(WS, q(), SECRET);
    expect(mockGetConnector).toHaveBeenCalledWith(WS, "grafana");
  });

  it("strips a trailing slash from grafanaUrl before building the fetch target", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(`${URL_BASE}/`));
    let capturedUrl = "";
    global.fetch = routeFetch((url) => {
      capturedUrl = url.toString();
      return { status: 200, body: [] };
    }) as unknown as typeof fetch;
    await grafanaAdapter.query(WS, q(), SECRET);
    expect(capturedUrl.startsWith(`${URL_BASE}/api/annotations?`)).toBe(true);
  });
});

describe("grafanaAdapter — search_events: request shape", () => {
  it("GETs /api/annotations with from/to as epoch-MILLISECOND strings (no unit conversion, unlike datadog.ts)", async () => {
    let captured: URL | null = null;
    global.fetch = routeFetch((url) => {
      captured = url;
      return { status: 200, body: [] };
    }) as unknown as typeof fetch;

    await grafanaAdapter.query(WS, q(), SECRET);

    expect(captured).not.toBeNull();
    expect(captured!.searchParams.get("from")).toBe(String(WINDOW_START_MS));
    expect(captured!.searchParams.get("to")).toBe(String(WINDOW_END_MS));
  });

  it("sends a generous explicit limit param, independent of q.limit", async () => {
    let captured: URL | null = null;
    global.fetch = routeFetch((url) => {
      captured = url;
      return { status: 200, body: [] };
    }) as unknown as typeof fetch;

    await grafanaAdapter.query(WS, q({ limit: 5 }), SECRET);
    expect(captured!.searchParams.get("limit")).toBe("500");
  });

  it("omits the tags param entirely when q.scope is absent", async () => {
    let captured: URL | null = null;
    global.fetch = routeFetch((url) => {
      captured = url;
      return { status: 200, body: [] };
    }) as unknown as typeof fetch;

    await grafanaAdapter.query(WS, q(), SECRET);
    expect(captured!.searchParams.has("tags")).toBe(false);
  });

  it("sends q.scope as the tags param when present", async () => {
    let captured: URL | null = null;
    global.fetch = routeFetch((url) => {
      captured = url;
      return { status: 200, body: [] };
    }) as unknown as typeof fetch;

    await grafanaAdapter.query(WS, q({ scope: "checkout-service" }), SECRET);
    expect(captured!.searchParams.get("tags")).toBe("checkout-service");
  });
});

describe("grafanaAdapter — search_events: happy path rendering", () => {
  it("renders a plain annotation (alertId: 0) as type 'annotation'", async () => {
    global.fetch = routeFetch(() => ({
      status: 200,
      body: [annotation({ alertId: 0, text: "deployed v2" })],
    })) as unknown as typeof fetch;

    const res = await grafanaAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({
      ok: true,
      raw: `event annotation "deployed v2" at=${new Date(WINDOW_END_MS).toISOString()}`,
    });
  });

  it("renders a Grafana-managed alert (non-zero alertId) as type 'alert'", async () => {
    global.fetch = routeFetch(() => ({
      status: 200,
      body: [annotation({ alertId: 42, text: "CPU usage alert firing" })],
    })) as unknown as typeof fetch;

    const res = await grafanaAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({
      ok: true,
      raw: `event alert "CPU usage alert firing" at=${new Date(WINDOW_END_MS).toISOString()}`,
    });
  });

  it("falls back to '-' when alertId is missing entirely (defensive, undocumented shape)", async () => {
    const malformed = annotation({ text: "weird row" });
    delete (malformed as Record<string, unknown>).alertId;
    global.fetch = routeFetch(() => ({ status: 200, body: [malformed] })) as unknown as typeof fetch;

    const res = await grafanaAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({
      ok: true,
      raw: `event - "weird row" at=${new Date(WINDOW_END_MS).toISOString()}`,
    });
  });

  it("collapses embedded newlines and truncates text to 120 characters", async () => {
    const longText = "a\nb ".repeat(50); // well over 120 chars, contains a newline
    global.fetch = routeFetch(() => ({
      status: 200,
      body: [annotation({ text: longText })],
    })) as unknown as typeof fetch;

    const res = await grafanaAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).not.toContain("\n\"");
    const quoted = res.raw.match(/"([^"]*)"/)![1];
    expect(quoted.length).toBeLessThanOrEqual(120);
    expect(quoted).not.toContain("\n");
  });

  it("renders multiple entries chronologically ascending", async () => {
    const earlier = WINDOW_START_MS + 1000;
    const later = WINDOW_START_MS + 2000;
    global.fetch = routeFetch(() => ({
      status: 200,
      body: [
        annotation({ time: later, text: "second" }),
        annotation({ time: earlier, text: "first" }),
      ],
    })) as unknown as typeof fetch;

    const res = await grafanaAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toContain('"first"');
    expect(lines[1]).toContain('"second"');
  });
});

describe("grafanaAdapter — search_events: honest empty marker + cap", () => {
  it("renders '(no matching events)' when the response is an empty array", async () => {
    global.fetch = routeFetch(() => ({ status: 200, body: [] })) as unknown as typeof fetch;
    const res = await grafanaAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching events)" });
  });

  it("treats a malformed 200 body (not an array) as zero elements, not an error", async () => {
    global.fetch = routeFetch(() => ({ status: 200, body: { message: "unexpected" } })) as unknown as typeof fetch;
    const res = await grafanaAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching events)" });
  });

  it("clamps limit:0 to at least one line", async () => {
    global.fetch = routeFetch(() => ({
      status: 200,
      body: [annotation({ text: "only one" })],
    })) as unknown as typeof fetch;
    const res = await grafanaAdapter.query(WS, q({ limit: 0 }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
  });

  it("keeps the MOST RECENT `limit` entries (the tail of the ascending sort) when over cap", async () => {
    const body = [0, 1, 2, 3, 4].map((i) =>
      annotation({ time: WINDOW_START_MS + i * 1000, text: `event-${i}` })
    );
    global.fetch = routeFetch(() => ({ status: 200, body })) as unknown as typeof fetch;

    const res = await grafanaAdapter.query(WS, q({ limit: 2 }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"event-3"');
    expect(lines[1]).toContain('"event-4"');
  });
});

describe("grafanaAdapter — search_events: q.query client-side re-filter (no server-side home)", () => {
  it("matches against the annotation's own text field, case-insensitively", async () => {
    global.fetch = routeFetch(() => ({
      status: 200,
      body: [
        annotation({ time: WINDOW_START_MS + 1000, text: "checkout latency spike" }),
        annotation({ time: WINDOW_START_MS + 2000, text: "unrelated deploy note" }),
      ],
    })) as unknown as typeof fetch;

    const res = await grafanaAdapter.query(WS, q({ query: "CHECKOUT" }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("checkout latency spike");
    expect(res.raw).not.toContain("unrelated deploy note");
  });

  it("a q.query matching nothing renders the honest empty marker", async () => {
    global.fetch = routeFetch(() => ({
      status: 200,
      body: [annotation({ text: "some text" })],
    })) as unknown as typeof fetch;

    const res = await grafanaAdapter.query(WS, q({ query: "totally-unrelated-xyz" }), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching events)" });
  });

  it("q.query never rides server-side into the request URL at all", async () => {
    let captured: URL | null = null;
    global.fetch = routeFetch((url) => {
      captured = url;
      return { status: 200, body: [] };
    }) as unknown as typeof fetch;

    await grafanaAdapter.query(WS, q({ query: "should-never-appear" }), SECRET);
    expect(captured!.toString()).not.toContain("should-never-appear");
    expect(Array.from(captured!.searchParams.keys())).toEqual(
      expect.arrayContaining(["from", "to", "limit"])
    );
    expect(captured!.searchParams.has("query")).toBe(false);
  });
});

describe("grafanaAdapter — search_events: q.scope as tags= — no DSL, URL-encoding round-trips exactly", () => {
  it.each([
    ["plain text", "checkout-service"],
    ["a space", "my service"],
    ["an ampersand", "a&b"],
    ["an equals sign", "key=value"],
    ["a hash", "a#b"],
    ["a literal plus", "a+b"],
    ["non-ASCII characters", "svc-日本語-café"],
  ])("scope with %s: the tags param, decoded, recovers the ORIGINAL scope byte-for-byte", async (_label, scope) => {
    let captured: URL | null = null;
    global.fetch = routeFetch((url) => {
      captured = url;
      return { status: 200, body: [] };
    }) as unknown as typeof fetch;

    await grafanaAdapter.query(WS, q({ scope }), SECRET);
    expect(captured!.searchParams.get("tags")).toBe(scope);
  });
});

describe("grafanaAdapter — search_events: window sanity — belt-and-braces client-side re-filter", () => {
  it("drops an entry whose time falls outside the requested window even though the server was asked to scope it", async () => {
    const wayBefore = WINDOW_START_MS - 3600_000;
    global.fetch = routeFetch(() => ({
      status: 200,
      body: [
        annotation({ time: wayBefore, text: "stale entry" }),
        annotation({ time: WINDOW_START_MS + 500, text: "in window" }),
      ],
    })) as unknown as typeof fetch;

    const res = await grafanaAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("in window");
    expect(res.raw).not.toContain("stale entry");
  });

  it("keeps an entry exactly at windowStart and exactly at windowEnd (inclusive bounds)", async () => {
    global.fetch = routeFetch(() => ({
      status: 200,
      body: [
        annotation({ time: WINDOW_START_MS, text: "at start" }),
        annotation({ time: WINDOW_END_MS, text: "at end" }),
      ],
    })) as unknown as typeof fetch;

    const res = await grafanaAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("at start");
    expect(res.raw).toContain("at end");
  });

  it("skips an entry whose time isn't a finite number, rather than throwing", async () => {
    global.fetch = routeFetch(() => ({
      status: 200,
      body: [annotation({ time: "not-a-number", text: "malformed" }), annotation({ text: "fine" })],
    })) as unknown as typeof fetch;

    const res = await grafanaAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("fine");
    expect(res.raw).not.toContain("malformed");
  });
});

describe("grafanaAdapter — search_events: failure handling", () => {
  it("maps a 401 to unauthorized", async () => {
    global.fetch = routeFetch(() => ({ status: 401, body: {} })) as unknown as typeof fetch;
    const res = await grafanaAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("maps a 403 to unauthorized", async () => {
    global.fetch = routeFetch(() => ({ status: 403, body: {} })) as unknown as typeof fetch;
    const res = await grafanaAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("maps a non-2xx/non-401/403 status to upstream_error", async () => {
    global.fetch = routeFetch(() => ({ status: 503, body: {} })) as unknown as typeof fetch;
    const res = await grafanaAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("this is a SINGLE-SCOPE fetch with NO local try/catch — a thrown fetch propagates uncaught to the caller (Global Constraints: no whole-query try/catch)", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(grafanaAdapter.query(WS, q(), SECRET)).rejects.toThrow("network down");
  });
});

describe("grafanaAdapter — search_events: request hygiene", () => {
  it("sends Accept/Authorization/User-Agent headers and an AbortSignal, Bearer scheme regardless of token shape", async () => {
    const fetchMock = routeFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    await grafanaAdapter.query(WS, q(), SECRET);

    expect(fetchMock.mock.calls.length).toBe(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url as string).pathname).toBe("/api/annotations");
    expect((init as RequestInit).headers).toMatchObject({
      Accept: "application/json",
      Authorization: `Bearer ${SECRET}`,
      "User-Agent": "agentrail-console",
    });
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("sends the SAME Bearer scheme for a legacy eyJ-shaped API key too (no auth-scheme heuristic, unlike prometheus.ts)", async () => {
    const fetchMock = routeFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    // FIXTURE, deliberately non-realistic (see the module-level note above
    // SECRET) — base64 of {"TEST":"fixture-not-a-key"}, NOT the {"k":...,
    // "n":...,"id":...} shape a real legacy Grafana API key decodes to.
    const legacyKey = "eyJURVNUIjoiZml4dHVyZS1ub3QtYS1rZXkifQ==";

    await grafanaAdapter.query(WS, q(), legacyKey);

    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${legacyKey}` });
  });
});

describe("grafanaAdapter — catalog↔adapter↔verify config-key alignment (pin 4)", () => {
  const grafanaEntry = CONNECTOR_CATALOG.find((c) => c.kind === "grafana")!;
  const catalogFields = grafanaEntry.connect!.extraConfigFields!;

  it("the catalog declares exactly ['grafanaUrl'], required:true — the literal key grafana.ts's query() and verify.ts's verifyGrafana both read", () => {
    expect(catalogFields.map((f) => f.key)).toEqual(["grafanaUrl"]);
    for (const field of catalogFields) {
      expect(field.required).toBe(true);
    }
  });

  it("declares NO secretParts/secretPartPatterns — a single, non-composite secret, like prometheus/sentry", () => {
    expect(grafanaEntry.connect?.secretParts).toBeUndefined();
    expect(grafanaEntry.connect?.secretPartPatterns).toBeUndefined();
  });

  it("declares evidence capabilities search_events ONLY (the pivot — no signals)", () => {
    expect(grafanaEntry.capabilities).toEqual({
      ingest: false,
      postResult: false,
      notify: false,
      evidence: ["search_events"],
    });
  });

  it("the adapter reads config.<catalog-declared-key> — a connector row built from that key (not this test file's own hardcoded URL_BASE constant's key) reaches a real fetch rather than degrading config_missing", async () => {
    const [urlKey] = catalogFields.map((f) => f.key);
    mockGetConnector.mockResolvedValue({
      provider: "grafana" as const,
      enabled: true,
      config: {
        repos: [],
        triggerLabel: "ready-for-agent",
        pollIntervalSeconds: 60,
        [urlKey]: URL_BASE,
      },
      hasSecret: true,
      updatedAt: null,
    } as never);
    global.fetch = routeFetch() as unknown as typeof fetch;

    const res = await grafanaAdapter.query(WS, q(), SECRET);
    expect(res).not.toEqual({ ok: false, reason: "config_missing" });
  });

  it("verifyGrafana reads config using EXACTLY the catalog's declared key too — a config object built from that key reaches Grafana's /api/org endpoint rather than failing closed with the URL-missing error", async () => {
    const [urlKey] = catalogFields.map((f) => f.key);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("grafana", SECRET, undefined, {
      [urlKey]: URL_BASE,
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(res).toEqual({ ok: true });
  });
});
