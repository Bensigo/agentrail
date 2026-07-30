import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors railway.test.ts's/github.test.ts's mocking idiom (mock the
// package's named export directly) and its global.fetch idiom for the real
// HTTP calls.
vi.mock("@agentrail/db-postgres", () => ({
  getConnector: vi.fn(),
}));

import { getConnector } from "@agentrail/db-postgres";
import { langfuseAdapter } from "./langfuse";
import { adapterFor } from "./registry";
import type { EvidenceQuery, EvidenceVerb } from "./types";

const mockGetConnector = vi.mocked(getConnector);

const WS = "00000000-0000-0000-0000-000000000001";
const PUBLIC_KEY = "pk-lf-abc123";
const SECRET_KEY = "sk-lf-def456";
const SECRET = `${PUBLIC_KEY}:${SECRET_KEY}`;
const HOST = "https://cloud.langfuse.com";
const WINDOW_START = "2026-07-29T00:00:00.000Z";
const WINDOW_END = "2026-07-29T23:59:59.000Z";

const EXPECTED_AUTH = `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64")}`;

function q(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return {
    verb: "traces",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    ...overrides,
  };
}

// `null` means "omit langfuseHost from config entirely".
function connectorRow(langfuseHost: string | null = HOST) {
  return {
    provider: "langfuse" as const,
    enabled: true,
    config: {
      repos: [],
      triggerLabel: "ready-for-agent",
      pollIntervalSeconds: 60,
      ...(langfuseHost !== null ? { langfuseHost } : {}),
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

function traceEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "trace-1",
    name: "checkout-flow",
    timestamp: "2026-07-29T14:02:00.000Z",
    latency: 1.234,
    ...overrides,
  };
}

interface RouteHandlers {
  traces?: (url: URL) => { status: number; body: unknown };
  metrics?: (query: Record<string, unknown>, url: URL) => { status: number; body: unknown };
}

/** Routes a fetch mock by inspecting the requested URL's pathname — GET-
 * based sibling of railway.test.ts's `routeFetch` (which routes a single
 * GraphQL POST endpoint by query text instead). Declares the (unused)
 * `init` param explicitly so `fetchMock.mock.calls[n]` types as a real
 * 2-tuple for the request-hygiene tests below, which inspect it. */
function routeFetch(handlers: RouteHandlers) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    void _init; // captured only so mock.calls[n] types as a real 2-tuple below
    const parsed = new URL(url);
    if (parsed.pathname === "/api/public/traces") {
      const h = handlers.traces ? handlers.traces(parsed) : { status: 200, body: { data: [] } };
      return httpResponse(h.status, h.body);
    }
    if (parsed.pathname === "/api/public/v2/metrics") {
      const query = JSON.parse(parsed.searchParams.get("query") ?? "{}") as Record<string, unknown>;
      const h = handlers.metrics
        ? handlers.metrics(query, parsed)
        : { status: 200, body: { data: [] } };
      return httpResponse(h.status, h.body);
    }
    throw new Error(`unexpected URL: ${url}`);
  });
}

/** Identifies which of the three fixed metric specs a captured v2 metrics
 * query belongs to, by its measure/aggregation/filter shape. */
function metricKind(query: Record<string, unknown>): "count" | "errors" | "latency_p95" {
  const metrics = query.metrics as Array<{ measure: string; aggregation: string }>;
  const filters = query.filters as unknown[];
  if (metrics[0].measure === "latency") return "latency_p95";
  return (filters?.length ?? 0) > 0 ? "errors" : "count";
}

function metricsRow(valueKey: string, value: number | null, timeDimension?: string) {
  return { time_dimension: timeDimension ?? null, [valueKey]: value };
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConnector.mockResolvedValue(connectorRow());
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("langfuseAdapter — shape", () => {
  it("declares provider 'langfuse' and verbs [traces, signals]", () => {
    expect(langfuseAdapter.provider).toBe("langfuse");
    expect(langfuseAdapter.verbs).toEqual(["traces", "signals"]);
  });

  it("self-registers into the shared registry on module load", () => {
    expect(adapterFor("langfuse")).toBe(langfuseAdapter);
  });
});

describe("langfuseAdapter — bad_request validation", () => {
  it("degrades bad_request on an unparseable windowStart, without ever reading the connector row", async () => {
    const res = await langfuseAdapter.query(WS, q({ windowStart: "not-a-date" }), SECRET);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades bad_request on an unparseable windowEnd", async () => {
    const res = await langfuseAdapter.query(WS, q({ windowEnd: "" }), SECRET);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
  });

  it("degrades bad_request for a verb this adapter does not declare", async () => {
    const res = await langfuseAdapter.query(WS, q({ verb: "changes" as EvidenceVerb }), SECRET);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });
});

describe("langfuseAdapter — config_missing", () => {
  it("degrades config_missing when secret is null, without ever reading the connector row", async () => {
    const res = await langfuseAdapter.query(WS, q(), null);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades config_missing when secret does not split into exactly two parts, without ever reading the connector row", async () => {
    const res = await langfuseAdapter.query(WS, q(), "only-one-part");
    expect(res).toEqual({ ok: false, reason: "config_missing" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades config_missing when there is no langfuse connector row at all", async () => {
    mockGetConnector.mockResolvedValue(null);
    const res = await langfuseAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("degrades config_missing when the row exists but langfuseHost is absent", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(null));
    const res = await langfuseAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("reads the connector row for provider 'langfuse' specifically", async () => {
    global.fetch = routeFetch({}) as unknown as typeof fetch;
    await langfuseAdapter.query(WS, q(), SECRET);
    expect(mockGetConnector).toHaveBeenCalledWith(WS, "langfuse");
  });
});

describe("langfuseAdapter — traces: happy path rendering", () => {
  it("renders a single trace: id, name, duration_ms converted from seconds, status=-, iso timestamp", async () => {
    global.fetch = routeFetch({
      traces: () => ({ status: 200, body: { data: [traceEntry()] } }),
    }) as unknown as typeof fetch;

    const res = await langfuseAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({
      ok: true,
      raw: "trace trace-1 checkout-flow duration_ms=1234 status=- at=2026-07-29T14:02:00.000Z",
    });
  });

  it("falls back to name=- when name is null", async () => {
    global.fetch = routeFetch({
      traces: () => ({ status: 200, body: { data: [traceEntry({ name: null })] } }),
    }) as unknown as typeof fetch;
    const res = await langfuseAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain(" - duration_ms=");
  });

  it("falls back to duration_ms=- when latency is null (never a fabricated 0)", async () => {
    global.fetch = routeFetch({
      traces: () => ({ status: 200, body: { data: [traceEntry({ latency: null })] } }),
    }) as unknown as typeof fetch;
    const res = await langfuseAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("duration_ms=-");
  });

  it("renders multiple traces most-recent-first, not trusting server ordering", async () => {
    global.fetch = routeFetch({
      traces: () => ({
        status: 200,
        body: {
          data: [
            traceEntry({ id: "trace-old", timestamp: "2026-07-29T10:00:00.000Z" }),
            traceEntry({ id: "trace-new", timestamp: "2026-07-29T18:00:00.000Z" }),
          ],
        },
      }),
    }) as unknown as typeof fetch;

    const res = await langfuseAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toContain("trace-new");
    expect(lines[1]).toContain("trace-old");
  });

  it("skips an entry with a missing id or unparseable timestamp rather than throwing", async () => {
    global.fetch = routeFetch({
      traces: () => ({
        status: 200,
        body: {
          data: [
            traceEntry({ id: null }),
            traceEntry({ id: "bad-ts", timestamp: "not-a-date" }),
            traceEntry({ id: "good" }),
          ],
        },
      }),
    }) as unknown as typeof fetch;

    const res = await langfuseAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("good");
    expect(res.raw.split("\n")).toHaveLength(1);
  });

  it("treats a malformed 200 body (data missing/non-array) as zero entries, not an error — mirrors github.ts's identical leniency", async () => {
    global.fetch = routeFetch({
      traces: () => ({ status: 200, body: {} }),
    }) as unknown as typeof fetch;
    const res = await langfuseAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching traces)" });
  });
});

describe("langfuseAdapter — traces: window filtering (belt-and-braces client-side re-filter)", () => {
  it("excludes traces outside [windowStart, windowEnd], keeping inclusive bounds", async () => {
    global.fetch = routeFetch({
      traces: () => ({
        status: 200,
        body: {
          data: [
            traceEntry({ id: "before", timestamp: "2026-07-28T23:00:00.000Z" }),
            traceEntry({ id: "after", timestamp: "2026-07-30T00:00:01.000Z" }),
            traceEntry({ id: "at-start", timestamp: WINDOW_START }),
            traceEntry({ id: "at-end", timestamp: WINDOW_END }),
          ],
        },
      }),
    }) as unknown as typeof fetch;

    const res = await langfuseAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("at-start");
    expect(res.raw).toContain("at-end");
    expect(res.raw).not.toContain("before");
    expect(res.raw).not.toContain("after");
  });

  it("drops a trace whose OWN timestamp falls outside the window even though the mock 'returns' it regardless of the server-side fromTimestamp/toTimestamp it was sent", async () => {
    global.fetch = routeFetch({
      traces: () => ({
        status: 200,
        body: {
          data: [
            traceEntry({ id: "in-window", timestamp: "2026-07-29T12:00:00.000Z" }),
            traceEntry({ id: "leaked", timestamp: "2026-08-01T00:00:00.000Z" }),
          ],
        },
      }),
    }) as unknown as typeof fetch;
    const res = await langfuseAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("in-window");
    expect(res.raw).not.toContain("leaked");
  });
});

describe("langfuseAdapter — traces: honest empty marker + limit cap", () => {
  it("renders '(no matching traces)' when nothing is in window", async () => {
    global.fetch = routeFetch({
      traces: () => ({ status: 200, body: { data: [] } }),
    }) as unknown as typeof fetch;
    const res = await langfuseAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching traces)" });
  });

  it("caps total lines at limit (default 50)", async () => {
    const data = Array.from({ length: 60 }, (_, i) =>
      traceEntry({
        id: `trace-${i}`,
        timestamp: new Date(new Date(WINDOW_START).getTime() + i * 1000).toISOString(),
      })
    );
    global.fetch = routeFetch({
      traces: () => ({ status: 200, body: { data } }),
    }) as unknown as typeof fetch;

    const res = await langfuseAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(50);
  });

  it("respects an explicit smaller limit", async () => {
    const data = Array.from({ length: 10 }, (_, i) =>
      traceEntry({
        id: `trace-${i}`,
        timestamp: new Date(new Date(WINDOW_START).getTime() + i * 1000).toISOString(),
      })
    );
    global.fetch = routeFetch({
      traces: () => ({ status: 200, body: { data } }),
    }) as unknown as typeof fetch;

    const res = await langfuseAdapter.query(WS, q({ limit: 3 }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(3);
  });

  it("clamps limit:0 to at least one line rather than a bare empty string", async () => {
    global.fetch = routeFetch({
      traces: () => ({ status: 200, body: { data: [traceEntry()] } }),
    }) as unknown as typeof fetch;
    const res = await langfuseAdapter.query(WS, q({ limit: 0 }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).not.toBe("");
    expect(res.raw.split("\n")).toHaveLength(1);
  });
});

describe("langfuseAdapter — traces: multi-page fetch hygiene", () => {
  it("fetches a second page when the first page comes back full (100 items)", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => traceEntry({ id: `p1-${i}` }));
    const secondPage = [traceEntry({ id: "p2-only" })];
    const requestedPages: string[] = [];
    global.fetch = routeFetch({
      traces: (url) => {
        const page = url.searchParams.get("page")!;
        requestedPages.push(page);
        return { status: 200, body: { data: page === "1" ? fullPage : secondPage } };
      },
    }) as unknown as typeof fetch;

    const res = await langfuseAdapter.query(WS, q({ limit: 200 }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(requestedPages).toEqual(["1", "2"]);
    expect(res.raw).toContain("p2-only");
  });

  it("stops after one page when the first page comes back short (< 100 items) — never requests page 2", async () => {
    const requestedPages: string[] = [];
    global.fetch = routeFetch({
      traces: (url) => {
        requestedPages.push(url.searchParams.get("page")!);
        return { status: 200, body: { data: [traceEntry()] } };
      },
    }) as unknown as typeof fetch;

    await langfuseAdapter.query(WS, q(), SECRET);
    expect(requestedPages).toEqual(["1"]);
  });

  it("never requests more than TRACES_MAX_PAGES (2) pages even when every page comes back full", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => traceEntry({ id: `x-${i}` }));
    const requestedPages: string[] = [];
    global.fetch = routeFetch({
      traces: (url) => {
        requestedPages.push(url.searchParams.get("page")!);
        return { status: 200, body: { data: fullPage } };
      },
    }) as unknown as typeof fetch;

    await langfuseAdapter.query(WS, q(), SECRET);
    expect(requestedPages).toEqual(["1", "2"]);
  });
});

describe("langfuseAdapter — traces: upstream failure taxonomy", () => {
  it("degrades unauthorized on HTTP 401", async () => {
    global.fetch = routeFetch({ traces: () => ({ status: 401, body: {} }) }) as unknown as typeof fetch;
    const res = await langfuseAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("degrades unauthorized on HTTP 403", async () => {
    global.fetch = routeFetch({ traces: () => ({ status: 403, body: {} }) }) as unknown as typeof fetch;
    const res = await langfuseAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("degrades upstream_error on HTTP 500", async () => {
    global.fetch = routeFetch({ traces: () => ({ status: 500, body: {} }) }) as unknown as typeof fetch;
    const res = await langfuseAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("a thrown/aborted fetch propagates uncaught (the route's job to convert to unreachable — see this module's own doc-comment)", async () => {
    global.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(langfuseAdapter.query(WS, q(), SECRET)).rejects.toThrow("network down");
  });
});

describe("langfuseAdapter — traces: q.query matches the trace NAME specifically, not the whole line", () => {
  it("filters by name, case-insensitive substring", async () => {
    global.fetch = routeFetch({
      traces: () => ({
        status: 200,
        body: {
          data: [
            traceEntry({ id: "t1", name: "checkout-flow" }),
            traceEntry({ id: "t2", name: "billing-sync" }),
          ],
        },
      }),
    }) as unknown as typeof fetch;

    const res = await langfuseAdapter.query(WS, q({ query: "CHECKOUT" }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
    expect(res.raw).toContain("t1");
  });

  it("does NOT match on the trace id or the iso timestamp text — name only", async () => {
    global.fetch = routeFetch({
      traces: () => ({
        status: 200,
        body: { data: [traceEntry({ id: "special-id-999", name: "ordinary" })] },
      }),
    }) as unknown as typeof fetch;

    const res = await langfuseAdapter.query(WS, q({ query: "special-id-999" }), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching traces)" });
  });

  it("renders the empty marker when the query matches nothing, even though traces exist in window", async () => {
    global.fetch = routeFetch({
      traces: () => ({ status: 200, body: { data: [traceEntry()] } }),
    }) as unknown as typeof fetch;
    const res = await langfuseAdapter.query(WS, q({ query: "nonexistent-term" }), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching traces)" });
  });
});

describe("langfuseAdapter — traces: request hygiene", () => {
  it("GETs the traces endpoint with Basic auth, User-Agent, an AbortSignal, and the confirmed query params", async () => {
    const fetchMock = routeFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await langfuseAdapter.query(WS, q(), SECRET);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    const parsed = new URL(url as string);
    expect(parsed.origin + parsed.pathname).toBe(`${HOST}/api/public/traces`);
    expect(parsed.searchParams.get("fromTimestamp")).toBe(WINDOW_START);
    expect(parsed.searchParams.get("toTimestamp")).toBe(WINDOW_END);
    expect(parsed.searchParams.get("orderBy")).toBe("timestamp.desc");
    expect(parsed.searchParams.get("page")).toBe("1");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: EXPECTED_AUTH,
      "User-Agent": "agentrail-console",
    });
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("strips a trailing slash from a stored host before building the URL", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(`${HOST}/`));
    const fetchMock = routeFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await langfuseAdapter.query(WS, q(), SECRET);

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain(`${HOST}/api/public/traces?`);
    expect(url).not.toContain(`${HOST}//api`);
  });
});

// ---------------------------------------------------------------------------
// signals
// ---------------------------------------------------------------------------

function signalsQuery(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return q({ verb: "signals", ...overrides });
}

describe("langfuseAdapter — signals: happy path rendering", () => {
  it("renders all three fixed metrics: count, errors (labeled), p95 latency", async () => {
    global.fetch = routeFetch({
      metrics: (query) => {
        const kind = metricKind(query);
        if (kind === "count") return { status: 200, body: { data: [metricsRow("count_count", 42)] } };
        if (kind === "errors") return { status: 200, body: { data: [metricsRow("count_count", 3)] } };
        return { status: 200, body: { data: [metricsRow("p95_latency", 1.5)] } };
      },
    }) as unknown as typeof fetch;

    const res = await langfuseAdapter.query(WS, signalsQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n").sort();
    expect(lines).toEqual(
      [
        `signal langfuse.observations.count window_agg=count value=42 at=${WINDOW_END}`,
        `signal langfuse.observations.count{level="ERROR"} window_agg=count value=3 at=${WINDOW_END}`,
        `signal langfuse.observations.latency_seconds window_agg=p95 value=1.5 at=${WINDOW_END}`,
      ].sort()
    );
  });

  it("sends the confirmed v2 metrics query shape: view=observations, empty dimensions, metrics=[{measure,aggregation}], timeDimension, fromTimestamp/toTimestamp", async () => {
    const captured: Record<string, unknown>[] = [];
    global.fetch = routeFetch({
      metrics: (query) => {
        captured.push(query);
        return { status: 200, body: { data: [] } };
      },
    }) as unknown as typeof fetch;

    await langfuseAdapter.query(WS, signalsQuery(), SECRET);

    expect(captured).toHaveLength(3);
    for (const query of captured) {
      expect(query.view).toBe("observations");
      expect(query.dimensions).toEqual([]);
      expect(query.timeDimension).toEqual({ granularity: "auto" });
      expect(query.fromTimestamp).toBe(WINDOW_START);
      expect(query.toTimestamp).toBe(WINDOW_END);
    }
    const errorsQuery = captured.find((c) => (c.filters as unknown[]).length > 0)!;
    expect(errorsQuery.filters).toEqual([{ column: "level", operator: "=", value: "ERROR", type: "string" }]);
  });

  it("renders one line PER ROW when a metric query returns multiple time-bucketed rows, each stamped with its own bucket", async () => {
    global.fetch = routeFetch({
      metrics: (query) => {
        if (metricKind(query) !== "count") return { status: 200, body: { data: [] } };
        return {
          status: 200,
          body: {
            data: [
              metricsRow("count_count", 10, "2026-07-29T00:00:00.000Z"),
              metricsRow("count_count", 15, "2026-07-29T12:00:00.000Z"),
            ],
          },
        };
      },
    }) as unknown as typeof fetch;

    const res = await langfuseAdapter.query(WS, signalsQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("value=10 at=2026-07-29T00:00:00.000Z");
    expect(res.raw).toContain("value=15 at=2026-07-29T12:00:00.000Z");
  });

  it("falls back to windowEnd as `at` when a row carries no time_dimension", async () => {
    global.fetch = routeFetch({
      metrics: (query) => {
        if (metricKind(query) !== "count") return { status: 200, body: { data: [] } };
        return { status: 200, body: { data: [{ count_count: 7 }] } };
      },
    }) as unknown as typeof fetch;

    const res = await langfuseAdapter.query(WS, signalsQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain(`value=7 at=${WINDOW_END}`);
  });

  it("skips a row whose aggregated value is null — Langfuse's own 'no data this bucket' signal, never rendered as a fabricated value", async () => {
    global.fetch = routeFetch({
      metrics: (query) => {
        if (metricKind(query) !== "count") return { status: 200, body: { data: [] } };
        return { status: 200, body: { data: [metricsRow("count_count", null)] } };
      },
    }) as unknown as typeof fetch;

    const res = await langfuseAdapter.query(WS, signalsQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).not.toContain("langfuse.observations.count value=");
  });
});

describe("langfuseAdapter — signals: honest empty marker + limit cap", () => {
  it("renders '(no matching signals)' when every metric returns zero usable rows", async () => {
    global.fetch = routeFetch({
      metrics: () => ({ status: 200, body: { data: [] } }),
    }) as unknown as typeof fetch;
    const res = await langfuseAdapter.query(WS, signalsQuery(), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching signals)" });
  });

  it("caps total lines at limit (default 50) across all three metrics combined", async () => {
    global.fetch = routeFetch({
      metrics: (query) => {
        const kind = metricKind(query);
        const rows = Array.from({ length: 30 }, (_, i) =>
          metricsRow(
            kind === "latency_p95" ? "p95_latency" : "count_count",
            i,
            new Date(new Date(WINDOW_START).getTime() + i * 1000).toISOString()
          )
        );
        return { status: 200, body: { data: rows } };
      },
    }) as unknown as typeof fetch;

    const res = await langfuseAdapter.query(WS, signalsQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(50);
  });

  it("clamps limit:0 to at least one line", async () => {
    global.fetch = routeFetch({
      metrics: (query) => {
        if (metricKind(query) !== "count") return { status: 200, body: { data: [] } };
        return { status: 200, body: { data: [metricsRow("count_count", 1)] } };
      },
    }) as unknown as typeof fetch;
    const res = await langfuseAdapter.query(WS, signalsQuery({ limit: 0 }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
  });
});

describe("langfuseAdapter — signals: q.query matches the signal's name+labels identifier, not the whole line", () => {
  it("matches the error-labeled signal by its {level=\"ERROR\"} label text", async () => {
    global.fetch = routeFetch({
      metrics: (query) => {
        const kind = metricKind(query);
        if (kind === "count") return { status: 200, body: { data: [metricsRow("count_count", 42)] } };
        if (kind === "errors") return { status: 200, body: { data: [metricsRow("count_count", 3)] } };
        return { status: 200, body: { data: [metricsRow("p95_latency", 1.5)] } };
      },
    }) as unknown as typeof fetch;

    const res = await langfuseAdapter.query(WS, signalsQuery({ query: "ERROR" }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
    expect(res.raw).toContain('level="ERROR"');
  });

  it("does not match on the numeric value text", async () => {
    global.fetch = routeFetch({
      metrics: (query) => {
        if (metricKind(query) !== "count") return { status: 200, body: { data: [] } };
        return { status: 200, body: { data: [metricsRow("count_count", 4242)] } };
      },
    }) as unknown as typeof fetch;
    const res = await langfuseAdapter.query(WS, signalsQuery({ query: "4242" }), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching signals)" });
  });
});

describe("langfuseAdapter — signals: per-metric failure isolation", () => {
  it("one metric's fetch 500s: a cap-exempt marker, rendered first; the other two metrics' lines still render, ok:true", async () => {
    global.fetch = routeFetch({
      metrics: (query) => {
        const kind = metricKind(query);
        if (kind === "count") return { status: 500, body: {} };
        if (kind === "errors") return { status: 200, body: { data: [metricsRow("count_count", 1)] } };
        return { status: 200, body: { data: [metricsRow("p95_latency", 0.5)] } };
      },
    }) as unknown as typeof fetch;

    const res = await langfuseAdapter.query(WS, signalsQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toBe("(signal count: langfuse upstream_error)");
    expect(res.raw).toContain("langfuse.observations.count{level=\"ERROR\"}");
    expect(res.raw).toContain("langfuse.observations.latency_seconds");
  });

  it("a thrown fetch for one metric renders '(signal {key}: langfuse unreachable)' when its siblings succeed", async () => {
    global.fetch = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname !== "/api/public/v2/metrics") throw new Error("unexpected URL");
      const query = JSON.parse(parsed.searchParams.get("query") ?? "{}") as Record<string, unknown>;
      if (metricKind(query) === "latency_p95") throw new Error("network down");
      return httpResponse(200, { data: [metricsRow("count_count", 1)] });
    }) as unknown as typeof fetch;

    const res = await langfuseAdapter.query(WS, signalsQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("(signal latency_p95: langfuse unreachable)");
  });

  it("degrades to upstream_error when every metric's fetch fails", async () => {
    global.fetch = routeFetch({
      metrics: () => ({ status: 503, body: {} }),
    }) as unknown as typeof fetch;
    const res = await langfuseAdapter.query(WS, signalsQuery(), SECRET);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("markers are cap-exempt — survive alongside a busy sibling metric's capped real lines", async () => {
    global.fetch = routeFetch({
      metrics: (query) => {
        const kind = metricKind(query);
        if (kind === "count") return { status: 401, body: {} };
        const rows = Array.from({ length: 5 }, (_, i) =>
          metricsRow(
            kind === "latency_p95" ? "p95_latency" : "count_count",
            i,
            new Date(new Date(WINDOW_START).getTime() + i * 1000).toISOString()
          )
        );
        return { status: 200, body: { data: rows } };
      },
    }) as unknown as typeof fetch;

    const res = await langfuseAdapter.query(WS, signalsQuery({ limit: 2 }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toBe("(signal count: langfuse unauthorized)");
    const realLines = lines.filter((l) => l.startsWith("signal "));
    expect(realLines).toHaveLength(2);
  });
});

describe("langfuseAdapter — signals: request hygiene", () => {
  it("fires all three metric queries concurrently, each with Basic auth, User-Agent, and an AbortSignal", async () => {
    const fetchMock = routeFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await langfuseAdapter.query(WS, signalsQuery(), SECRET);

    expect(fetchMock.mock.calls.length).toBe(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(new URL(url as string).pathname).toBe("/api/public/v2/metrics");
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: EXPECTED_AUTH,
        "User-Agent": "agentrail-console",
      });
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });
});
