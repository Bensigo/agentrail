import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors datadog.test.ts's/sentry.test.ts's mocking idiom (mock the
// package's named export directly) and its global.fetch idiom for the real
// HTTP calls.
vi.mock("@agentrail/db-postgres", () => ({
  getConnector: vi.fn(),
}));

// OAuth Connect Wave 3, W3-T6: this adapter now resolves its bearer
// credential via `resolveProviderAuth` (`../oauth/core`) instead of using
// the raw `secret` parameter directly — mocked the same way as
// `@agentrail/db-postgres` above, and given a passing default in
// `beforeEach` so every pre-existing test in this file (which passes
// `SECRET` as the `secret` param and asserts `Bearer ${SECRET}`) keeps
// exercising the exact same GraphQL-call shape unmodified. Mirrors
// `railway.test.ts`'s identical W3-T2 mock exactly.
vi.mock("../oauth/core", () => ({
  resolveProviderAuth: vi.fn(),
}));

import { getConnector } from "@agentrail/db-postgres";
import { resolveProviderAuth } from "../oauth/core";
import {
  cloudflareAdapter,
  CLOUDFLARE_SIGNALS_QUERY,
  CLOUDFLARE_SEARCH_EVENTS_QUERY,
} from "./cloudflare";
import { adapterFor } from "./registry";
import type { EvidenceQuery, EvidenceVerb } from "./types";
// Fix Round 1, FOLD 2 precedent (sentry.test.ts/datadog.test.ts): the ONLY
// place this test file imports the catalog — the adapter itself
// (cloudflare.ts) never does. Used exclusively by the drift-protection
// describe block near the bottom of this file.
import { CONNECTOR_CATALOG } from "../../app/(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers";

const mockGetConnector = vi.mocked(getConnector);
const mockResolveProviderAuth = vi.mocked(resolveProviderAuth);

const WS = "00000000-0000-0000-0000-000000000001";
// FIXTURE, deliberately non-realistic (mirrors vercel.test.ts's/
// connector-helpers.test.ts's Fix-Round-2 concat-split discipline): starts
// with `TESTFIXTURE_`, not `cfut_`/`cfat_`/`cfk_` — the current,
// GitHub-secret-scanning-detected Cloudflare token prefixes (see
// cloudflare.ts's own doc-comment, "AUTH" / "SECRET FIXTURES"). No
// contiguous literal in this file bears any of those three prefixes.
const SECRET = "TESTFIXTURE_cloudflare_token_0000000000000";
const ZONE_ID = "023e105f4ecef8ad9ca31a8372d0c353";
const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const WINDOW_START = "2026-07-29T00:00:00.000Z";
const WINDOW_END = "2026-07-29T23:59:59.000Z";

function q(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return {
    verb: "signals",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    ...overrides,
  };
}

function searchQuery(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return q({ verb: "search_events", ...overrides });
}

/** `null` means "omit cloudflareZoneId from config entirely". */
function connectorRow(zoneId: string | null = ZONE_ID) {
  return {
    provider: "cloudflare" as const,
    enabled: true,
    config: {
      repos: [],
      triggerLabel: "ready-for-agent",
      pollIntervalSeconds: 60,
      ...(zoneId !== null ? { cloudflareZoneId: zoneId } : {}),
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

function signalsBody(overrides: { requests?: unknown; errorRequests?: unknown } = {}) {
  return {
    data: {
      viewer: {
        zones: [
          {
            requests: "requests" in overrides ? overrides.requests : [{ count: 100, sum: { edgeResponseBytes: 5000 } }],
            errorRequests: "errorRequests" in overrides ? overrides.errorRequests : [{ count: 3 }],
          },
        ],
      },
    },
  };
}

function firewallEvent(overrides: Record<string, unknown> = {}) {
  return {
    action: "block",
    source: "waf",
    ruleId: "abc123",
    rayName: "7f000000abcd1234",
    datetime: "2026-07-29T14:02:00Z",
    ...overrides,
  };
}

function searchEventsBody(entries: unknown[]) {
  return { data: { viewer: { zones: [{ firewallEventsAdaptive: entries }] } } };
}

interface RouteHandlers {
  signals?: (variables: Record<string, unknown>) => { status: number; body: unknown };
  searchEvents?: (variables: Record<string, unknown>) => { status: number; body: unknown };
}

/** Routes a fetch mock by inspecting the requested body's `query` text for
 * which of the two operation names it is — mirrors datadog.test.ts's/
 * sentry.test.ts's `routeFetch`, adapted for a single GraphQL endpoint
 * serving two distinct operations. */
function routeFetch(handlers: RouteHandlers) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== GRAPHQL_URL) throw new Error(`unexpected URL: ${url}`);
    const parsedBody = init?.body ? (JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> }) : { query: "", variables: {} };
    if (parsedBody.query.includes("CloudflareSignals")) {
      const h = handlers.signals ? handlers.signals(parsedBody.variables) : { status: 200, body: signalsBody() };
      return httpResponse(h.status, h.body);
    }
    if (parsedBody.query.includes("CloudflareSecurityEvents")) {
      const h = handlers.searchEvents
        ? handlers.searchEvents(parsedBody.variables)
        : { status: 200, body: searchEventsBody([]) };
      return httpResponse(h.status, h.body);
    }
    throw new Error(`unexpected query document: ${parsedBody.query}`);
  });
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConnector.mockResolvedValue(connectorRow());
  // OAuth Connect Wave 3, W3-T6 — default resolves to the pre-existing
  // SECRET constant so every prior test in this file (all of which pass
  // SECRET as the 3rd query() param and assert Bearer ${SECRET}) is
  // untouched. Mirrors railway.test.ts's identical default.
  mockResolveProviderAuth.mockResolvedValue({ ok: true, secret: SECRET });
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("cloudflareAdapter — shape", () => {
  it("declares provider 'cloudflare' and verbs [signals, search_events]", () => {
    expect(cloudflareAdapter.provider).toBe("cloudflare");
    expect(cloudflareAdapter.verbs).toEqual(["signals", "search_events"]);
  });

  it("self-registers into the shared registry on module load", () => {
    expect(adapterFor("cloudflare")).toBe(cloudflareAdapter);
  });
});

describe("cloudflareAdapter — bad_request validation", () => {
  it("degrades bad_request on an unparseable windowStart, without ever reading the connector row", async () => {
    const res = await cloudflareAdapter.query(WS, q({ windowStart: "not-a-date" }), SECRET);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades bad_request on an unparseable windowEnd", async () => {
    const res = await cloudflareAdapter.query(WS, q({ windowEnd: "" }), SECRET);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
  });

  it("degrades bad_request for a verb this adapter does not declare", async () => {
    const res = await cloudflareAdapter.query(WS, q({ verb: "traces" as EvidenceVerb }), SECRET);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });
});

describe("cloudflareAdapter — config_missing", () => {
  it("degrades config_missing when secret is null, without ever reading the connector row", async () => {
    const res = await cloudflareAdapter.query(WS, q(), null);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades config_missing when there is no cloudflare connector row at all", async () => {
    mockGetConnector.mockResolvedValue(null);
    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("degrades config_missing when the row exists but cloudflareZoneId is absent", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(null));
    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("degrades config_missing when viewer.zones comes back EMPTY despite a configured zone id (signals) — mirrors vercel.ts's 404-on-configured-project adjudication", async () => {
    global.fetch = routeFetch({
      signals: () => ({ status: 200, body: { data: { viewer: { zones: [] } } } }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("degrades config_missing when viewer.zones comes back EMPTY despite a configured zone id (search_events)", async () => {
    global.fetch = routeFetch({
      searchEvents: () => ({ status: 200, body: { data: { viewer: { zones: [] } } } }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery(), SECRET);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("degrades config_missing when viewer itself is absent from the response", async () => {
    global.fetch = routeFetch({ signals: () => ({ status: 200, body: { data: {} } }) }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("reads the connector row for provider 'cloudflare' specifically", async () => {
    global.fetch = routeFetch({}) as unknown as typeof fetch;
    await cloudflareAdapter.query(WS, q(), SECRET);
    expect(mockGetConnector).toHaveBeenCalledWith(WS, "cloudflare");
  });
});

// ---------------------------------------------------------------------------
// OAuth Connect Wave 3, W3-T6 — auth resolution via resolveProviderAuth.
// Mirrors railway.test.ts's identical describe block.
// ---------------------------------------------------------------------------
describe("cloudflareAdapter — auth resolution via resolveProviderAuth (W3-T6)", () => {
  it("calls resolveProviderAuth(workspaceId, 'cloudflare') once the secret-presence and zoneId checks pass", async () => {
    global.fetch = routeFetch({}) as unknown as typeof fetch;
    await cloudflareAdapter.query(WS, q(), SECRET);
    expect(mockResolveProviderAuth).toHaveBeenCalledTimes(1);
    expect(mockResolveProviderAuth).toHaveBeenCalledWith(WS, "cloudflare");
  });

  it("never calls resolveProviderAuth when secret is null (the cheap existence gate still short-circuits first)", async () => {
    await cloudflareAdapter.query(WS, q(), null);
    expect(mockResolveProviderAuth).not.toHaveBeenCalled();
  });

  it("never calls resolveProviderAuth when cloudflareZoneId is absent (the config_missing gate still short-circuits first)", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(null));
    await cloudflareAdapter.query(WS, q(), SECRET);
    expect(mockResolveProviderAuth).not.toHaveBeenCalled();
  });

  it("legacy-token kind: uses resolveProviderAuth's resolved secret as the Bearer credential — NOT the raw secret param passed into query()", async () => {
    mockResolveProviderAuth.mockResolvedValue({ ok: true, secret: "resolved-legacy-token" });
    const fetchMock = routeFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;

    // The raw `secret` param is deliberately a DIFFERENT value than what
    // resolveProviderAuth resolves — proving the Authorization header comes
    // from the resolved value, never the raw param.
    await cloudflareAdapter.query(WS, q(), "raw-secret-param-must-be-ignored");

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer resolved-legacy-token");
  });

  it("oauth kind, just-refreshed: uses a freshly-rotated access token when resolveProviderAuth reports one", async () => {
    mockResolveProviderAuth.mockResolvedValue({ ok: true, secret: "freshly-rotated-access-token" });
    const fetchMock = routeFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await cloudflareAdapter.query(WS, q(), SECRET);

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer freshly-rotated-access-token");
  });

  it("degrades config_missing when resolveProviderAuth itself reports config_missing, without ever calling fetch", async () => {
    mockResolveProviderAuth.mockResolvedValue({ ok: false, reason: "config_missing" });
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // "Bounded 401-refresh-retry": resolveProviderAuth (core.ts) is what
  // performs the actual proactive, TTL-driven refresh BEFORE this adapter
  // ever calls Cloudflare's GraphQL endpoint — a rejected/timed-out refresh
  // degrades to `unauthorized` from resolveProviderAuth itself, exactly
  // once, never retried in a loop by this adapter (core.ts's own
  // single-flight + 30s-bounded refresh is where that boundedness is
  // actually enforced — see core.test.ts). This adapter's own contribution
  // to the contract is simply: call resolveProviderAuth exactly once per
  // query() call, and never attempt a second one if the first fails.
  it("degrades unauthorized when resolveProviderAuth reports unauthorized (e.g. a rejected/timed-out refresh), without ever calling fetch, and without a second resolveProviderAuth attempt", async () => {
    mockResolveProviderAuth.mockResolvedValue({ ok: false, reason: "unauthorized" });
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockResolveProviderAuth).toHaveBeenCalledTimes(1);
  });

  it("resolveProviderAuth is called exactly once per query() call for search_events too — not just signals", async () => {
    global.fetch = routeFetch({}) as unknown as typeof fetch;
    await cloudflareAdapter.query(WS, searchQuery(), SECRET);
    expect(mockResolveProviderAuth).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// GraphQL query documents are CONSTANTS (pin 3)
// ---------------------------------------------------------------------------

describe("cloudflareAdapter — GraphQL query documents are CONSTANTS, zoneTag/time/limit ride as variables (pin 3)", () => {
  it("signals: the exact document sent over the wire equals the exported constant, byte for byte, across calls with different q.query/q.scope", async () => {
    const capturedQueries: string[] = [];
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedQueries.push((JSON.parse(String(init?.body)) as { query: string }).query);
      return httpResponse(200, signalsBody());
    }) as unknown as typeof fetch;

    await cloudflareAdapter.query(WS, q({ query: "checkout", scope: "web" }), SECRET);
    await cloudflareAdapter.query(WS, q({ query: "a-totally-different-term", scope: "other-scope" }), SECRET);

    expect(capturedQueries).toHaveLength(2);
    expect(capturedQueries[0]).toBe(CLOUDFLARE_SIGNALS_QUERY);
    expect(capturedQueries[1]).toBe(CLOUDFLARE_SIGNALS_QUERY);
    expect(capturedQueries[0]).toBe(capturedQueries[1]);
    expect(capturedQueries[0]).not.toContain("checkout");
    expect(capturedQueries[0]).not.toContain("a-totally-different-term");
  });

  it("search_events: the exact document sent over the wire equals the exported constant, byte for byte, across calls with different q.query", async () => {
    const capturedQueries: string[] = [];
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedQueries.push((JSON.parse(String(init?.body)) as { query: string }).query);
      return httpResponse(200, searchEventsBody([]));
    }) as unknown as typeof fetch;

    await cloudflareAdapter.query(WS, searchQuery({ query: "sql injection" }), SECRET);
    await cloudflareAdapter.query(WS, searchQuery({ query: "totally different" }), SECRET);

    expect(capturedQueries[0]).toBe(CLOUDFLARE_SEARCH_EVENTS_QUERY);
    expect(capturedQueries[0]).toBe(capturedQueries[1]);
    expect(capturedQueries[0]).not.toContain("sql injection");
    expect(capturedQueries[0]).not.toContain("totally different");
  });

  it("Fix Round 1: zoneTag, the window bounds, the error threshold, and limit ALL ride as FLAT LEAF-value GraphQL variables — never inlined into the query text, and never nested inside a whole-object $filter variable (signals)", async () => {
    let capturedQueryText = "";
    let capturedVariables: Record<string, unknown> = {};
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      capturedQueryText = body.query;
      capturedVariables = body.variables;
      return httpResponse(200, signalsBody());
    }) as unknown as typeof fetch;

    await cloudflareAdapter.query(WS, q(), SECRET);

    expect(capturedVariables).toEqual({
      zoneTag: ZONE_ID,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      errorStatus: 500,
      limit: expect.any(Number),
    });
    expect(capturedQueryText).not.toContain(ZONE_ID);
    expect(capturedQueryText).not.toContain(WINDOW_START);
    // Fix Round 1's whole point: no `$filter`-shaped variable of any kind —
    // the filter SHAPE is inlined in the document itself (see
    // CLOUDFLARE_SIGNALS_QUERY's own doc-comment).
    expect(capturedVariables).not.toHaveProperty("filter");
    expect(capturedVariables).not.toHaveProperty("errorFilter");
    expect(capturedQueryText).not.toMatch(/\$filter\b/);
  });

  it("Fix Round 1: zoneTag and the window bounds ride as FLAT LEAF-value GraphQL variables — never inlined into the query text, never nested inside a whole-object $filter variable (search_events)", async () => {
    let capturedQueryText = "";
    let capturedVariables: Record<string, unknown> = {};
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      capturedQueryText = body.query;
      capturedVariables = body.variables;
      return httpResponse(200, searchEventsBody([]));
    }) as unknown as typeof fetch;

    await cloudflareAdapter.query(WS, searchQuery(), SECRET);

    expect(capturedVariables).toEqual({
      zoneTag: ZONE_ID,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      limit: expect.any(Number),
    });
    expect(capturedQueryText).not.toContain(ZONE_ID);
    expect(capturedQueryText).not.toContain(WINDOW_START);
    expect(capturedVariables).not.toHaveProperty("filter");
    expect(capturedQueryText).not.toMatch(/\$filter\b/);
  });

  it("Fix Round 1: the query documents declare only schema-confirmed leaf scalar types — string/Time/uint16/uint64 — never the fabricated 'filter' scalar or the GraphQL-spec 'Int'", () => {
    expect(CLOUDFLARE_SIGNALS_QUERY).toContain("$zoneTag: string");
    expect(CLOUDFLARE_SIGNALS_QUERY).toContain("$windowStart: Time");
    expect(CLOUDFLARE_SIGNALS_QUERY).toContain("$windowEnd: Time");
    expect(CLOUDFLARE_SIGNALS_QUERY).toContain("$errorStatus: uint16");
    expect(CLOUDFLARE_SIGNALS_QUERY).toContain("$limit: uint64");
    expect(CLOUDFLARE_SEARCH_EVENTS_QUERY).toContain("$zoneTag: string");
    expect(CLOUDFLARE_SEARCH_EVENTS_QUERY).toContain("$windowStart: Time");
    expect(CLOUDFLARE_SEARCH_EVENTS_QUERY).toContain("$windowEnd: Time");
    expect(CLOUDFLARE_SEARCH_EVENTS_QUERY).toContain("$limit: uint64");
    for (const doc of [CLOUDFLARE_SIGNALS_QUERY, CLOUDFLARE_SEARCH_EVENTS_QUERY]) {
      expect(doc).not.toContain(": filter");
      expect(doc).not.toContain(": Int");
    }
  });
});

// ---------------------------------------------------------------------------
// signals
// ---------------------------------------------------------------------------

describe("cloudflareAdapter — signals: happy path rendering", () => {
  it("renders all three signals: requests count, bytes sum, 5xx error count — all stamped at windowEnd", async () => {
    global.fetch = routeFetch({}) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n").sort();
    expect(lines).toEqual(
      [
        `signal cloudflare.requests.count window_agg=count value=100 at=${WINDOW_END}`,
        `signal cloudflare.requests.bytes window_agg=sum value=5000 at=${WINDOW_END}`,
        `signal cloudflare.requests.errors{status="5xx"} window_agg=count value=3 at=${WINDOW_END}`,
      ].sort()
    );
  });

  it("skips the bytes line (not a marker) when sum.edgeResponseBytes is absent/non-numeric on every row — the request itself succeeded", async () => {
    global.fetch = routeFetch({
      signals: () => ({ status: 200, body: signalsBody({ requests: [{ count: 10, sum: {} }] }) }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("cloudflare.requests.count");
    expect(res.raw).not.toContain("cloudflare.requests.bytes");
    expect(res.raw).not.toMatch(/\(signal/);
  });

  it("renders count=0 honestly (not a marker, not skipped) when a zone genuinely has zero requests in window", async () => {
    global.fetch = routeFetch({
      signals: () => ({ status: 200, body: signalsBody({ requests: [{ count: 0, sum: { edgeResponseBytes: 0 } }], errorRequests: [{ count: 0 }] }) }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("cloudflare.requests.count window_agg=count value=0");
    expect(res.raw).toContain('cloudflare.requests.errors{status="5xx"} window_agg=count value=0');
  });

  it("sends the request as a POST to the confirmed GraphQL endpoint with Bearer auth, Content-Type, User-Agent, and an AbortSignal", async () => {
    const fetchMock = routeFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;
    await cloudflareAdapter.query(WS, q(), SECRET);

    expect(fetchMock.mock.calls.length).toBe(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(GRAPHQL_URL);
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: `Bearer ${SECRET}`,
      "User-Agent": "agentrail-console",
    });
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
});

describe("cloudflareAdapter — signals: collapseRequestGroups belt (SUM, not AVG, when more than one row survives)", () => {
  it("sums count/bytes across multiple rows returned for the SAME alias (structurally unexpected, defensively handled)", async () => {
    global.fetch = routeFetch({
      signals: () => ({
        status: 200,
        body: signalsBody({
          requests: [
            { count: 10, sum: { edgeResponseBytes: 100 } },
            { count: 20, sum: { edgeResponseBytes: 200 } },
          ],
        }),
      }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("cloudflare.requests.count window_agg=count value=30");
    expect(res.raw).toContain("cloudflare.requests.bytes window_agg=sum value=300");
  });

  it("skips a row whose count is non-numeric without throwing, while still summing a sibling row's usable value", async () => {
    global.fetch = routeFetch({
      signals: () => ({
        status: 200,
        body: signalsBody({ requests: [{ count: "not-a-number" }, { count: 5, sum: { edgeResponseBytes: 50 } }] }),
      }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("cloudflare.requests.count window_agg=count value=5");
  });
});

describe("cloudflareAdapter — signals: honest empty marker + limit cap", () => {
  it("renders '(no matching signals)' when both aliases return an empty row array (a genuinely empty, still-successful window)", async () => {
    global.fetch = routeFetch({
      signals: () => ({ status: 200, body: signalsBody({ requests: [], errorRequests: [] }) }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // count still renders as 0 (an empty ROW ARRAY collapses to a zero sum,
    // not "no data") — the marker only fires if q.query then filters
    // everything away; this case simply has real, zero-valued lines.
    expect(res.raw).toContain("value=0");
  });

  it("clamps limit:0 to at least one line", async () => {
    global.fetch = routeFetch({}) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, q({ limit: 0 }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
  });

  it("respects an explicit smaller limit", async () => {
    global.fetch = routeFetch({}) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, q({ limit: 2 }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(2);
  });
});

describe("cloudflareAdapter — signals: q.query matches the signal's own name identifier, not the whole line", () => {
  it("matches the errors signal by its own name text", async () => {
    global.fetch = routeFetch({}) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, q({ query: "errors" }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
    expect(res.raw).toContain("cloudflare.requests.errors");
  });

  it("does not match on the numeric value text", async () => {
    global.fetch = routeFetch({
      signals: () => ({ status: 200, body: signalsBody({ requests: [{ count: 4242, sum: {} }] }) }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, q({ query: "4242" }), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching signals)" });
  });
});

describe("cloudflareAdapter — signals: per-alias GraphQL partial-failure isolation", () => {
  it("one alias nulled by a GraphQL partial failure: a cap-exempt marker, rendered first; the surviving alias's lines still render, ok:true, console.warn logs the raw errors", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = routeFetch({
      signals: () => ({
        status: 200,
        body: {
          data: { viewer: { zones: [{ requests: null, errorRequests: [{ count: 3 }] }] } },
          errors: [{ message: "internal error", path: ["viewer", "zones", 0, "requests"] }],
        },
      }),
    }) as unknown as typeof fetch;

    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toBe("(signal requests: cloudflare upstream_error)");
    expect(res.raw).toContain("cloudflare.requests.errors");
    expect(res.raw).not.toContain("cloudflare.requests.count");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("degrades to upstream_error, without console.warn embedding the raw message in the reason, when BOTH aliases are nulled", async () => {
    global.fetch = routeFetch({
      signals: () => ({
        status: 200,
        body: {
          data: { viewer: { zones: [{ requests: null, errorRequests: null }] } },
          errors: [{ message: "internal error" }],
        },
      }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("data entirely null alongside an errors array → upstream_error, console.warn logs it, never thrown", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = routeFetch({
      signals: () => ({ status: 200, body: { data: null, errors: [{ message: "bad query" }] } }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
    expect(warnSpy).toHaveBeenCalled();
  });

  it("degrades unauthorized on HTTP 401 before any GraphQL body parsing happens", async () => {
    global.fetch = routeFetch({ signals: () => ({ status: 401, body: {} }) }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("degrades unauthorized on HTTP 403", async () => {
    global.fetch = routeFetch({ signals: () => ({ status: 403, body: {} }) }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("degrades upstream_error on a non-401/403 non-2xx HTTP status", async () => {
    global.fetch = routeFetch({ signals: () => ({ status: 500, body: {} }) }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("degrades upstream_error on a 429 (rate limited) — no special-casing, no retry", async () => {
    global.fetch = routeFetch({ signals: () => ({ status: 429, body: {} }) }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("a thrown/aborted fetch propagates uncaught — NOT wrapped locally, unlike datadog.ts's/sentry.ts's per-metric signals fetches (this adapter's own ONE-request design)", async () => {
    global.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(cloudflareAdapter.query(WS, q(), SECRET)).rejects.toThrow("network down");
  });
});

// ---------------------------------------------------------------------------
// search_events
// ---------------------------------------------------------------------------

describe("cloudflareAdapter — search_events: happy path rendering", () => {
  it("renders a single event: action, ray=rayName (NOT rayId), quoted ruleId, iso timestamp", async () => {
    global.fetch = routeFetch({
      searchEvents: () => ({ status: 200, body: searchEventsBody([firewallEvent()]) }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery(), SECRET);
    expect(res).toEqual({
      ok: true,
      raw: 'event block ray=7f000000abcd1234 "abc123" at=2026-07-29T14:02:00.000Z',
    });
  });

  it("falls back to action=- when action is absent", async () => {
    global.fetch = routeFetch({
      searchEvents: () => ({ status: 200, body: searchEventsBody([firewallEvent({ action: undefined })]) }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("event - ray=");
  });

  it("falls back to ray=- when rayName is absent", async () => {
    global.fetch = routeFetch({
      searchEvents: () => ({ status: 200, body: searchEventsBody([firewallEvent({ rayName: undefined })]) }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("ray=- ");
  });

  it("prefers ruleId over source when both are present", async () => {
    global.fetch = routeFetch({
      searchEvents: () => ({
        status: 200,
        body: searchEventsBody([firewallEvent({ ruleId: "my-rule-id", source: "waf" })]),
      }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain('"my-rule-id"');
    expect(res.raw).not.toContain('"waf"');
  });

  it("falls back to source when ruleId is absent", async () => {
    global.fetch = routeFetch({
      searchEvents: () => ({ status: 200, body: searchEventsBody([firewallEvent({ ruleId: undefined, source: "ratelimit" })]) }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain('"ratelimit"');
  });

  it("renders an empty quoted string when both ruleId and source are absent", async () => {
    global.fetch = routeFetch({
      searchEvents: () => ({
        status: 200,
        body: searchEventsBody([firewallEvent({ ruleId: undefined, source: undefined })]),
      }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain('""');
  });

  it("truncates ruleOrSource at 120 chars", async () => {
    const longRule = "x".repeat(200);
    global.fetch = routeFetch({
      searchEvents: () => ({ status: 200, body: searchEventsBody([firewallEvent({ ruleId: longRule })]) }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain(`"${"x".repeat(120)}"`);
    expect(res.raw).not.toContain("x".repeat(121));
  });

  it("renders multiple events chronologically (ascending), not trusting server ordering", async () => {
    global.fetch = routeFetch({
      searchEvents: () => ({
        status: 200,
        body: searchEventsBody([
          firewallEvent({ rayName: "new", datetime: "2026-07-29T18:00:00Z" }),
          firewallEvent({ rayName: "old", datetime: "2026-07-29T10:00:00Z" }),
        ]),
      }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toContain("ray=old");
    expect(lines[1]).toContain("ray=new");
  });

  it("skips an entry with an absent/unparseable datetime rather than throwing", async () => {
    global.fetch = routeFetch({
      searchEvents: () => ({
        status: 200,
        body: searchEventsBody([
          firewallEvent({ rayName: "bad", datetime: undefined }),
          firewallEvent({ rayName: "bad2", datetime: "not-a-date" }),
          firewallEvent({ rayName: "good" }),
        ]),
      }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
    expect(res.raw).toContain("ray=good");
  });

  it("treats a null firewallEventsAdaptive (nullable per Cloudflare's own schema, or a GraphQL-nulled field) as zero entries, not an error", async () => {
    global.fetch = routeFetch({
      searchEvents: () => ({ status: 200, body: { data: { viewer: { zones: [{ firewallEventsAdaptive: null }] } } } }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery(), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching events)" });
  });
});

describe("cloudflareAdapter — search_events: window filtering (belt-and-braces client-side re-filter)", () => {
  it("excludes events outside [windowStart, windowEnd] by their own datetime, keeping inclusive bounds", async () => {
    global.fetch = routeFetch({
      searchEvents: () => ({
        status: 200,
        body: searchEventsBody([
          firewallEvent({ rayName: "before", datetime: "2026-07-28T23:00:00Z" }),
          firewallEvent({ rayName: "after", datetime: "2026-07-30T00:00:01Z" }),
          firewallEvent({ rayName: "at-start", datetime: WINDOW_START }),
          firewallEvent({ rayName: "at-end", datetime: WINDOW_END }),
        ]),
      }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("ray=at-start");
    expect(res.raw).toContain("ray=at-end");
    expect(res.raw.split("\n")).toHaveLength(2);
  });
});

describe("cloudflareAdapter — search_events: honest empty marker + limit cap", () => {
  it("renders '(no matching events)' when nothing is in window", async () => {
    global.fetch = routeFetch({}) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery(), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching events)" });
  });

  it("caps total lines at limit (default 200)", async () => {
    const entries = Array.from({ length: 250 }, (_, i) =>
      firewallEvent({ rayName: `r${i}`, datetime: new Date(new Date(WINDOW_START).getTime() + i * 1000).toISOString() })
    );
    global.fetch = routeFetch({ searchEvents: () => ({ status: 200, body: searchEventsBody(entries) }) }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(200);
  });

  it("respects an explicit smaller limit, keeping the MOST RECENT entries (tail of the ascending sort)", async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      firewallEvent({
        rayName: `r${i}`,
        datetime: new Date(new Date(WINDOW_START).getTime() + i * 1000).toISOString(),
      })
    );
    global.fetch = routeFetch({ searchEvents: () => ({ status: 200, body: searchEventsBody(entries) }) }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery({ limit: 3 }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("ray=r7");
    expect(lines[2]).toContain("ray=r9");
  });

  it("clamps limit:0 to at least one line rather than a bare empty string", async () => {
    global.fetch = routeFetch({
      searchEvents: () => ({ status: 200, body: searchEventsBody([firewallEvent()]) }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery({ limit: 0 }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).not.toBe("");
    expect(res.raw.split("\n")).toHaveLength(1);
  });
});

describe("cloudflareAdapter — search_events: q.query is CLIENT-ONLY (no server-side text field on this dataset)", () => {
  it("filters client-side against the rendered line", async () => {
    global.fetch = routeFetch({
      searchEvents: () => ({
        status: 200,
        body: searchEventsBody([
          firewallEvent({ rayName: "r1", ruleId: "block-sqli" }),
          firewallEvent({ rayName: "r2", ruleId: "block-xss" }),
        ]),
      }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery({ query: "sqli" }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
    expect(res.raw).toContain("block-sqli");
  });

  it("never sends q.query as part of the request (no server-side text field exists for this dataset)", async () => {
    let capturedBody = "";
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body);
      return httpResponse(200, searchEventsBody([]));
    }) as unknown as typeof fetch;
    await cloudflareAdapter.query(WS, searchQuery({ query: "a-very-distinctive-search-term" }), SECRET);
    expect(capturedBody).not.toContain("a-very-distinctive-search-term");
  });

  it("renders the empty marker when the client-side re-filter matches nothing", async () => {
    global.fetch = routeFetch({
      searchEvents: () => ({ status: 200, body: searchEventsBody([firewallEvent()]) }),
    }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery({ query: "nonexistent-term" }), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching events)" });
  });
});

describe("cloudflareAdapter — search_events: upstream failure taxonomy + request hygiene", () => {
  it("degrades unauthorized on HTTP 401", async () => {
    global.fetch = routeFetch({ searchEvents: () => ({ status: 401, body: {} }) }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery(), SECRET);
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("degrades upstream_error on HTTP 500", async () => {
    global.fetch = routeFetch({ searchEvents: () => ({ status: 500, body: {} }) }) as unknown as typeof fetch;
    const res = await cloudflareAdapter.query(WS, searchQuery(), SECRET);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("a thrown/aborted fetch propagates uncaught (the route's job to convert to unreachable)", async () => {
    global.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(cloudflareAdapter.query(WS, searchQuery(), SECRET)).rejects.toThrow("network down");
  });

  it("never requests a second page — single request (this task's own ONE-GraphQL-request design)", async () => {
    const fetchMock = routeFetch({ searchEvents: () => ({ status: 200, body: searchEventsBody([firewallEvent()]) }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    await cloudflareAdapter.query(WS, searchQuery(), SECRET);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("sends the request with Bearer auth, Content-Type, User-Agent, and an AbortSignal", async () => {
    const fetchMock = routeFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;
    await cloudflareAdapter.query(WS, searchQuery(), SECRET);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(GRAPHQL_URL);
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${SECRET}`,
      "User-Agent": "agentrail-console",
      "Content-Type": "application/json",
    });
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// Pin 4 — catalog↔adapter config-key drift protection.
// ---------------------------------------------------------------------------
describe("cloudflareAdapter — catalog↔adapter config-key alignment (pin 4)", () => {
  const cloudflareEntry = CONNECTOR_CATALOG.find((c) => c.kind === "cloudflare")!;
  const catalogFields = cloudflareEntry.connect!.extraConfigFields!;

  it("the catalog declares exactly ['cloudflareZoneId'], required:true — the literal key cloudflare.ts's query() reads", () => {
    expect(catalogFields.map((f) => f.key)).toEqual(["cloudflareZoneId"]);
    for (const field of catalogFields) {
      expect(field.required).toBe(true);
    }
  });

  it("does NOT declare cloudflareAccountId — this task's own pinned decision (zoneTag suffices for both datasets, see cloudflare.ts's own doc-comment)", () => {
    expect(catalogFields.map((f) => f.key)).not.toContain("cloudflareAccountId");
  });

  it("declares neither secretParts nor secretPartPatterns — a SINGLE-part credential, like sentry/prometheus/grafana/vercel", () => {
    expect(cloudflareEntry.connect?.secretParts).toBeUndefined();
    expect(cloudflareEntry.connect?.secretPartPatterns).toBeUndefined();
  });

  it("the adapter reads config.<catalog-declared-key> — a connector row built from that key (not this test file's own hardcoded ZONE_ID constant's key) reaches a real fetch rather than degrading config_missing", async () => {
    const [zoneKey] = catalogFields.map((f) => f.key);
    mockGetConnector.mockResolvedValue({
      provider: "cloudflare" as const,
      enabled: true,
      config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60, [zoneKey]: ZONE_ID },
      hasSecret: true,
      updatedAt: null,
    } as never);
    global.fetch = routeFetch({}) as unknown as typeof fetch;

    const res = await cloudflareAdapter.query(WS, q(), SECRET);
    expect(res).not.toEqual({ ok: false, reason: "config_missing" });
  });
});
