import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors sentry.test.ts's/langfuse.test.ts's mocking idiom (mock the
// package's named export directly) and its global.fetch idiom for the real
// HTTP calls.
vi.mock("@agentrail/db-postgres", () => ({
  getConnector: vi.fn(),
}));

import { getConnector } from "@agentrail/db-postgres";
import { datadogAdapter, DATADOG_SECRET_SPEC, DATADOG_SITES as ADAPTER_DATADOG_SITES } from "./datadog";
import { adapterFor } from "./registry";
import type { EvidenceQuery, EvidenceVerb } from "./types";
// Fix Round 1, FOLD 2 precedent (sentry.test.ts): the ONLY place this test
// file imports the catalog (and verify.ts) — the adapter itself (datadog.ts)
// never does. Used exclusively by the drift-protection describe blocks near
// the bottom of this file.
import { CONNECTOR_CATALOG } from "../../app/(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers";
import {
  verifyConnectorCredential,
  DATADOG_SITES as VERIFY_DATADOG_SITES,
} from "../../app/api/v1/workspaces/[workspaceId]/connectors/secret/verify";

const mockGetConnector = vi.mocked(getConnector);

const WS = "00000000-0000-0000-0000-000000000001";
const API_KEY = "a".repeat(32);
const APP_KEY = "b".repeat(40);
const SECRET = `${API_KEY}:${APP_KEY}`;
const SITE = "datadoghq.com";
const WINDOW_START = "2026-07-29T00:00:00.000Z";
const WINDOW_END = "2026-07-29T23:59:59.000Z";
// Computed (never hand-typed magic numbers — a wrong guess here would
// silently fall outside the belt-and-braces window filter under test).
const WINDOW_START_SEC = Math.floor(new Date(WINDOW_START).getTime() / 1000);
const WINDOW_START_MS = new Date(WINDOW_START).getTime();
const WINDOW_END_MS = new Date(WINDOW_END).getTime();
// Fix Round 1: the rollup interval every metric query now appends — see
// datadog.ts's own rollupSecondsFor, mirrored here rather than imported so
// a wrong implementation on either side would show up as a test failure.
const ROLLUP_SECONDS = Math.max(1, Math.ceil((WINDOW_END_MS - WINDOW_START_MS) / 1000));

function q(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return {
    verb: "signals",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    ...overrides,
  };
}

/** `null` means "omit datadogSite from config entirely". */
function connectorRow(datadogSite: string | null = SITE) {
  return {
    provider: "datadog" as const,
    enabled: true,
    config: {
      repos: [],
      triggerLabel: "ready-for-agent",
      pollIntervalSeconds: 60,
      ...(datadogSite !== null ? { datadogSite } : {}),
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

function logEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "AAAA",
    attributes: {
      message: "checkout request failed with a 500",
      timestamp: "2026-07-29T14:02:00.000Z",
      service: "checkout",
      status: "error",
      ...(overrides.attributes as Record<string, unknown> | undefined),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "attributes")),
  };
}

interface RouteHandlers {
  query?: (url: URL) => { status: number; body: unknown };
  logsSearch?: (body: Record<string, unknown>) => { status: number; body: unknown };
}

/** Routes a fetch mock by inspecting the requested URL's pathname — mirrors
 * sentry.test.ts's/langfuse.test.ts's `routeFetch`. */
function routeFetch(handlers: RouteHandlers) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/v1/query") {
      const h = handlers.query ? handlers.query(parsed) : { status: 200, body: { series: [] } };
      return httpResponse(h.status, h.body);
    }
    if (parsed.pathname === "/api/v2/logs/events/search") {
      const parsedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const h = handlers.logsSearch ? handlers.logsSearch(parsedBody) : { status: 200, body: { data: [] } };
      return httpResponse(h.status, h.body);
    }
    throw new Error(`unexpected URL: ${url}`);
  });
}

/** Identifies which of the three fixed metric specs a captured
 * /api/v1/query request belongs to, by its `query` param text. */
function metricKind(url: URL): "cpu" | "load" | "mem" {
  const query = url.searchParams.get("query") ?? "";
  if (query.includes("system.load.1")) return "load";
  if (query.includes("system.mem.pct_usable")) return "mem";
  return "cpu";
}

function seriesWith(points: Array<[number, number | null]>) {
  return { series: [{ metric: "x", pointlist: points }] };
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConnector.mockResolvedValue(connectorRow());
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("datadogAdapter — shape", () => {
  it("declares provider 'datadog' and verbs [signals, search_events]", () => {
    expect(datadogAdapter.provider).toBe("datadog");
    expect(datadogAdapter.verbs).toEqual(["signals", "search_events"]);
  });

  it("self-registers into the shared registry on module load", () => {
    expect(adapterFor("datadog")).toBe(datadogAdapter);
  });
});

describe("datadogAdapter — bad_request validation", () => {
  it("degrades bad_request on an unparseable windowStart, without ever reading the connector row", async () => {
    const res = await datadogAdapter.query(WS, q({ windowStart: "not-a-date" }), SECRET);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades bad_request on an unparseable windowEnd", async () => {
    const res = await datadogAdapter.query(WS, q({ windowEnd: "" }), SECRET);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
  });

  it("degrades bad_request for a verb this adapter does not declare", async () => {
    const res = await datadogAdapter.query(WS, q({ verb: "traces" as EvidenceVerb }), SECRET);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });
});

describe("datadogAdapter — config_missing", () => {
  it("degrades config_missing when secret is null, without ever reading the connector row", async () => {
    const res = await datadogAdapter.query(WS, q(), null);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades config_missing when secret does not split into exactly two parts, without ever reading the connector row", async () => {
    const res = await datadogAdapter.query(WS, q(), "only-one-part");
    expect(res).toEqual({ ok: false, reason: "config_missing" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades config_missing when there is no datadog connector row at all", async () => {
    mockGetConnector.mockResolvedValue(null);
    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("degrades config_missing when the row exists but datadogSite is absent", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(null));
    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("degrades config_missing when datadogSite is stored but not on the documented allowlist (never becomes a fetch target)", async () => {
    mockGetConnector.mockResolvedValue(connectorRow("evil.example.com"));
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("degrades config_missing for a site that merely CONTAINS a real site as a substring — an exact-match allowlist, not a permissive regex", async () => {
    mockGetConnector.mockResolvedValue(connectorRow("datadoghq.com.attacker.example"));
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "datadoghq.com",
    "us3.datadoghq.com",
    "us5.datadoghq.com",
    "datadoghq.eu",
    "ddog-gov.com",
    "us2.ddog-gov.com",
    "ap1.datadoghq.com",
    "ap2.datadoghq.com",
    "uk1.datadoghq.com",
  ])("accepts the documented site %s and builds the correct host", async (site) => {
    mockGetConnector.mockResolvedValue(connectorRow(site));
    let capturedUrl = "";
    global.fetch = (async (url: string) => {
      capturedUrl = String(url);
      return httpResponse(200, { series: [] });
    }) as unknown as typeof fetch;
    await datadogAdapter.query(WS, q(), SECRET);
    expect(capturedUrl.startsWith(`https://api.${site}/`)).toBe(true);
  });

  it("is case-insensitive on the stored site value", async () => {
    mockGetConnector.mockResolvedValue(connectorRow("DataDogHQ.COM"));
    let capturedUrl = "";
    global.fetch = (async (url: string) => {
      capturedUrl = String(url);
      return httpResponse(200, { series: [] });
    }) as unknown as typeof fetch;
    await datadogAdapter.query(WS, q(), SECRET);
    expect(capturedUrl.startsWith("https://api.datadoghq.com/")).toBe(true);
  });

  it("reads the connector row for provider 'datadog' specifically", async () => {
    global.fetch = routeFetch({}) as unknown as typeof fetch;
    await datadogAdapter.query(WS, q(), SECRET);
    expect(mockGetConnector).toHaveBeenCalledWith(WS, "datadog");
  });
});

// ---------------------------------------------------------------------------
// signals
// ---------------------------------------------------------------------------

describe("datadogAdapter — signals: happy path rendering", () => {
  it("renders all three fixed metrics: cpu, load, mem — unscoped (no labels)", async () => {
    global.fetch = routeFetch({
      query: (url) => {
        const kind = metricKind(url);
        if (kind === "cpu") return { status: 200, body: seriesWith([[WINDOW_START_MS, 42.5]]) };
        if (kind === "load") return { status: 200, body: seriesWith([[WINDOW_START_MS, 1.2]]) };
        return { status: 200, body: seriesWith([[WINDOW_START_MS, 63.1]]) };
      },
    }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n").sort();
    expect(lines).toEqual(
      [
        `signal datadog.system.cpu.user window_agg=avg value=42.5 at=${new Date(WINDOW_START_MS).toISOString()}`,
        `signal datadog.system.load.1 window_agg=avg value=1.2 at=${new Date(WINDOW_START_MS).toISOString()}`,
        `signal datadog.system.mem.pct_usable window_agg=avg value=63.1 at=${new Date(WINDOW_START_MS).toISOString()}`,
      ].sort()
    );
  });

  it("sends the confirmed /api/v1/query params: from/to as EPOCH SECONDS (not ms), query=avg:<metric>{*}.rollup(avg, <window_seconds>) when unscoped", async () => {
    const captured: URL[] = [];
    global.fetch = routeFetch({
      query: (url) => {
        captured.push(url);
        return { status: 200, body: { series: [] } };
      },
    }) as unknown as typeof fetch;

    await datadogAdapter.query(WS, q(), SECRET);

    expect(captured).toHaveLength(3);
    for (const url of captured) {
      expect(url.searchParams.get("from")).toBe(String(WINDOW_START_SEC));
      expect(url.searchParams.get("to")).toBe(String(Math.floor(WINDOW_END_MS / 1000)));
    }
    const cpuUrl = captured.find((u) => metricKind(u) === "cpu")!;
    expect(cpuUrl.searchParams.get("query")).toBe(`avg:system.cpu.user{*}.rollup(avg, ${ROLLUP_SECONDS})`);
    const loadUrl = captured.find((u) => metricKind(u) === "load")!;
    expect(loadUrl.searchParams.get("query")).toBe(`avg:system.load.1{*}.rollup(avg, ${ROLLUP_SECONDS})`);
    const memUrl = captured.find((u) => metricKind(u) === "mem")!;
    expect(memUrl.searchParams.get("query")).toBe(`avg:system.mem.pct_usable{*}.rollup(avg, ${ROLLUP_SECONDS})`);
  });

  it("embeds q.scope as a service: tag filter on all three queries, and reflects it in the rendered {labels}", async () => {
    const captured: URL[] = [];
    global.fetch = routeFetch({
      query: (url) => {
        captured.push(url);
        if (metricKind(url) !== "cpu") return { status: 200, body: { series: [] } };
        return { status: 200, body: seriesWith([[WINDOW_START_MS, 5]]) };
      },
    }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, q({ scope: "checkout-service" }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    for (const url of captured) {
      expect(url.searchParams.get("query")).toContain("{service:checkout-service}");
    }
    expect(res.raw).toContain("datadog.system.cpu.user{service:checkout-service} window_agg=avg value=5");
  });

  it("falls back to the unscoped {*} filter when q.scope contains characters outside the safe tag-value charset (never breaks the {...} structure)", async () => {
    const captured: URL[] = [];
    global.fetch = routeFetch({
      query: (url) => {
        captured.push(url);
        return { status: 200, body: { series: [] } };
      },
    }) as unknown as typeof fetch;

    await datadogAdapter.query(WS, q({ scope: "foo,extra:bar}" }), SECRET);
    for (const url of captured) {
      expect(url.searchParams.get("query")).toContain("{*}.rollup(avg,");
    }
  });

  it("collapses multiple pointlist entries into ONE averaged line (Fix Round 1 — pin 2's single-row-per-metric contract; the belt for when .rollup() doesn't fully collapse the response), stamped at windowEnd, never rendered per-point", async () => {
    const laterMs = WINDOW_START_MS + 12 * 3600 * 1000;
    global.fetch = routeFetch({
      query: (url) => {
        if (metricKind(url) !== "cpu") return { status: 200, body: { series: [] } };
        return {
          status: 200,
          body: seriesWith([
            [WINDOW_START_MS, 10],
            [laterMs, 20],
          ]),
        };
      },
    }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // avg(10, 20) = 15 — ONE line, not two, stamped at windowEnd (no single
    // point's own timestamp is more "correct" for a synthesized value).
    expect(res.raw).toContain(`datadog.system.cpu.user window_agg=avg value=15 at=${new Date(WINDOW_END_MS).toISOString()}`);
    expect(res.raw).not.toContain("value=10");
    expect(res.raw).not.toContain("value=20");
  });

  it("rounds a synthesized multi-point average to 4 decimal places rather than a raw repeating-decimal float", async () => {
    global.fetch = routeFetch({
      query: (url) => {
        if (metricKind(url) !== "cpu") return { status: 200, body: { series: [] } };
        return {
          status: 200,
          body: seriesWith([
            [WINDOW_START_MS, 1],
            [WINDOW_START_MS + 1000, 2],
            [WINDOW_START_MS + 2000, 2],
          ]),
        };
      },
    }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // avg(1, 2, 2) = 1.6666666666666667 raw -> rounded to 1.6667.
    expect(res.raw).toContain("value=1.6667");
  });

  it("renders a SINGLE returned point AS RETURNED, at ITS OWN timestamp (the expected case once .rollup() collapses the response — real data preserved untouched, nothing synthesized)", async () => {
    global.fetch = routeFetch({
      query: (url) => {
        if (metricKind(url) !== "cpu") return { status: 200, body: { series: [] } };
        return { status: 200, body: seriesWith([[WINDOW_START_MS + 3600_000, 42.5]]) };
      },
    }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain(`value=42.5 at=${new Date(WINDOW_START_MS + 3600_000).toISOString()}`);
  });

  it("skips a point whose value is null — Datadog's own 'no data this point' signal, never rendered as a fabricated value", async () => {
    global.fetch = routeFetch({
      query: (url) => {
        if (metricKind(url) !== "cpu") return { status: 200, body: { series: [] } };
        return { status: 200, body: seriesWith([[WINDOW_START_MS, null]]) };
      },
    }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).not.toContain("datadog.system.cpu.user window_agg=avg value=");
  });

  it("treats a malformed 200 body (no series key) as zero points for that metric, not an error", async () => {
    global.fetch = routeFetch({ query: () => ({ status: 200, body: { status: "ok" } }) }) as unknown as typeof fetch;
    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching signals)" });
  });
});

describe("datadogAdapter — signals: belt-and-braces window re-filter on each point's own millisecond timestamp", () => {
  it("drops a point whose timestamp falls after windowEnd", async () => {
    const wayAfter = new Date("2026-08-01T00:00:00.000Z").getTime();
    global.fetch = routeFetch({
      query: (url) => {
        if (metricKind(url) !== "cpu") return { status: 200, body: { series: [] } };
        return {
          status: 200,
          body: seriesWith([
            [WINDOW_START_MS + 3600_000, 10],
            [wayAfter, 999],
          ]),
        };
      },
    }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("value=10");
    expect(res.raw).not.toContain("value=999");
  });

  it("drops a point whose timestamp falls before windowStart too (inclusive-bounds re-filter, not just an upper check)", async () => {
    const wayBefore = new Date("2026-07-20T00:00:00.000Z").getTime();
    global.fetch = routeFetch({
      query: (url) => {
        if (metricKind(url) !== "cpu") return { status: 200, body: { series: [] } };
        return {
          status: 200,
          body: seriesWith([
            [wayBefore, 888],
            [WINDOW_START_MS + 3600_000, 5],
          ]),
        };
      },
    }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("value=5");
    expect(res.raw).not.toContain("value=888");
  });

  it("keeps a point whose timestamp is exactly at the window bounds (inclusive) — proven via the aggregate reflecting BOTH endpoints, not just one", async () => {
    global.fetch = routeFetch({
      query: (url) => {
        if (metricKind(url) !== "cpu") return { status: 200, body: { series: [] } };
        return {
          status: 200,
          body: seriesWith([
            [WINDOW_START_MS, 10],
            [WINDOW_END_MS, 20],
          ]),
        };
      },
    }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // If either inclusive bound were wrongly EXCLUSIVE, only one point would
    // survive and render alone (value=10 or value=20); avg(10,20)=15 proves
    // both were kept and combined.
    expect(res.raw).toContain("datadog.system.cpu.user window_agg=avg value=15");
  });
});

describe("datadogAdapter — signals: honest empty marker + limit cap", () => {
  it("renders '(no matching signals)' when every metric returns zero usable points", async () => {
    global.fetch = routeFetch({ query: () => ({ status: 200, body: { series: [] } }) }) as unknown as typeof fetch;
    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching signals)" });
  });

  it("Fix Round 1: even when every metric's raw response carries 30 points (well over the old per-point default cap of 50), the aggregation collapses each metric to ONE line — 3 total, not 50, and the 50-line cap is structurally unreachable from this verb now", async () => {
    global.fetch = routeFetch({
      query: () => {
        const points = Array.from(
          { length: 30 },
          (_, i) => [WINDOW_START_MS + i, i] as [number, number]
        );
        return { status: 200, body: seriesWith(points) };
      },
    }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(3);
  });

  it("clamps limit:0 to at least one line", async () => {
    global.fetch = routeFetch({
      query: (url) => {
        if (metricKind(url) !== "cpu") return { status: 200, body: { series: [] } };
        return { status: 200, body: seriesWith([[WINDOW_START_MS, 1]]) };
      },
    }) as unknown as typeof fetch;
    const res = await datadogAdapter.query(WS, q({ limit: 0 }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
  });
});

describe("datadogAdapter — signals: q.query matches the signal's name+labels identifier, not the whole line", () => {
  it("matches the load signal by its own name text", async () => {
    global.fetch = routeFetch({
      query: (url) => {
        const kind = metricKind(url);
        if (kind === "cpu") return { status: 200, body: seriesWith([[WINDOW_START_MS, 1]]) };
        if (kind === "load") return { status: 200, body: seriesWith([[WINDOW_START_MS, 2]]) };
        return { status: 200, body: seriesWith([[WINDOW_START_MS, 3]]) };
      },
    }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, q({ query: "load" }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
    expect(res.raw).toContain("datadog.system.load.1");
  });

  it("does not match on the numeric value text", async () => {
    global.fetch = routeFetch({
      query: (url) => {
        if (metricKind(url) !== "cpu") return { status: 200, body: { series: [] } };
        return { status: 200, body: seriesWith([[WINDOW_START_MS, 4242]]) };
      },
    }) as unknown as typeof fetch;
    const res = await datadogAdapter.query(WS, q({ query: "4242" }), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching signals)" });
  });
});

describe("datadogAdapter — signals: per-metric failure isolation", () => {
  it("one metric's fetch 500s: a cap-exempt marker, rendered first; the other two metrics' lines still render, ok:true", async () => {
    global.fetch = routeFetch({
      query: (url) => {
        const kind = metricKind(url);
        if (kind === "cpu") return { status: 500, body: {} };
        if (kind === "load") return { status: 200, body: seriesWith([[WINDOW_START_MS, 1]]) };
        return { status: 200, body: seriesWith([[WINDOW_START_MS, 2]]) };
      },
    }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toBe("(signal cpu: datadog upstream_error)");
    expect(res.raw).toContain("datadog.system.load.1");
    expect(res.raw).toContain("datadog.system.mem.pct_usable");
  });

  it("a thrown fetch for one metric renders '(signal {key}: datadog unreachable)' when its siblings succeed", async () => {
    global.fetch = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname !== "/api/v1/query") throw new Error("unexpected URL");
      if (metricKind(parsed) === "mem") throw new Error("network down");
      return httpResponse(200, seriesWith([[WINDOW_START_MS, 1]]));
    }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("(signal mem: datadog unreachable)");
  });

  it("degrades to upstream_error when every metric's fetch fails", async () => {
    global.fetch = routeFetch({ query: () => ({ status: 503, body: {} }) }) as unknown as typeof fetch;
    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("markers are cap-exempt and rendered first, alongside sibling metrics' own single aggregated lines (Fix Round 1: each busy metric's 5 raw points still collapses to exactly 1 line, so there is nothing left for the limit to meaningfully cap)", async () => {
    global.fetch = routeFetch({
      query: (url) => {
        const kind = metricKind(url);
        if (kind === "cpu") return { status: 401, body: {} };
        const points = Array.from(
          { length: 5 },
          (_, i) => [WINDOW_START_MS + i, i] as [number, number]
        );
        return { status: 200, body: seriesWith(points) };
      },
    }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toBe("(signal cpu: datadog unauthorized)");
    const realLines = lines.filter((l) => l.startsWith("signal "));
    // load's own 5 points collapse to 1 line, mem's own 5 points collapse to
    // 1 line — 2 real lines total, one per surviving metric.
    expect(realLines).toHaveLength(2);
  });
});

describe("datadogAdapter — signals: request hygiene", () => {
  it("fires all three metric queries concurrently, each with DD-API-KEY/DD-APPLICATION-KEY headers, User-Agent, and an AbortSignal", async () => {
    const fetchMock = routeFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await datadogAdapter.query(WS, q(), SECRET);

    expect(fetchMock.mock.calls.length).toBe(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(new URL(url as string).pathname).toBe("/api/v1/query");
      expect((init as RequestInit).headers).toMatchObject({
        "DD-API-KEY": API_KEY,
        "DD-APPLICATION-KEY": APP_KEY,
        "User-Agent": "agentrail-console",
      });
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });
});

// ---------------------------------------------------------------------------
// search_events
// ---------------------------------------------------------------------------

function searchQuery(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return q({ verb: "search_events", ...overrides });
}

describe("datadogAdapter — search_events: happy path rendering", () => {
  it("renders a single log: status, service, quoted message, iso timestamp", async () => {
    global.fetch = routeFetch({
      logsSearch: () => ({ status: 200, body: { data: [logEntry()] } }),
    }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, searchQuery(), SECRET);
    expect(res).toEqual({
      ok: true,
      raw: 'log error checkout "checkout request failed with a 500" at=2026-07-29T14:02:00.000Z',
    });
  });

  it("falls back to status=- when status is absent", async () => {
    global.fetch = routeFetch({
      logsSearch: () => ({
        status: 200,
        body: { data: [logEntry({ attributes: { status: undefined } })] },
      }),
    }) as unknown as typeof fetch;
    const res = await datadogAdapter.query(WS, searchQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("log - checkout ");
  });

  it("falls back to service=- when service is absent", async () => {
    global.fetch = routeFetch({
      logsSearch: () => ({
        status: 200,
        body: { data: [logEntry({ attributes: { service: undefined } })] },
      }),
    }) as unknown as typeof fetch;
    const res = await datadogAdapter.query(WS, searchQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("log error - ");
  });

  it("truncates the message at 120 chars", async () => {
    const longMessage = "x".repeat(200);
    global.fetch = routeFetch({
      logsSearch: () => ({
        status: 200,
        body: { data: [logEntry({ attributes: { message: longMessage } })] },
      }),
    }) as unknown as typeof fetch;
    const res = await datadogAdapter.query(WS, searchQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain(`"${"x".repeat(120)}"`);
    expect(res.raw).not.toContain("x".repeat(121));
  });

  it("renders multiple logs chronologically (ascending), not trusting server ordering", async () => {
    global.fetch = routeFetch({
      logsSearch: () => ({
        status: 200,
        body: {
          data: [
            logEntry({ id: "new", attributes: { timestamp: "2026-07-29T18:00:00.000Z" } }),
            logEntry({ id: "old", attributes: { timestamp: "2026-07-29T10:00:00.000Z" } }),
          ],
        },
      }),
    }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, searchQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toContain("at=2026-07-29T10:00:00.000Z");
    expect(lines[1]).toContain("at=2026-07-29T18:00:00.000Z");
  });

  it("skips an entry missing attributes, or with an unparseable timestamp, rather than throwing", async () => {
    global.fetch = routeFetch({
      logsSearch: () => ({
        status: 200,
        body: {
          data: [
            { id: "no-attrs" },
            logEntry({ id: "bad-ts", attributes: { timestamp: "not-a-date" } }),
            logEntry({ id: "good" }),
          ],
        },
      }),
    }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, searchQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
  });

  it("treats a malformed 200 body (data missing/non-array) as zero entries, not an error", async () => {
    global.fetch = routeFetch({
      logsSearch: () => ({ status: 200, body: {} }),
    }) as unknown as typeof fetch;
    const res = await datadogAdapter.query(WS, searchQuery(), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching events)" });
  });
});

describe("datadogAdapter — search_events: window filtering (belt-and-braces client-side re-filter)", () => {
  it("excludes logs outside [windowStart, windowEnd] by attributes.timestamp, keeping inclusive bounds", async () => {
    global.fetch = routeFetch({
      logsSearch: () => ({
        status: 200,
        body: {
          data: [
            logEntry({ id: "before", attributes: { timestamp: "2026-07-28T23:00:00.000Z" } }),
            logEntry({ id: "after", attributes: { timestamp: "2026-07-30T00:00:01.000Z" } }),
            logEntry({ id: "at-start", attributes: { timestamp: WINDOW_START } }),
            logEntry({ id: "at-end", attributes: { timestamp: WINDOW_END } }),
          ],
        },
      }),
    }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, searchQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("at=2026-07-29T00:00:00.000Z");
    expect(res.raw).toContain("at=2026-07-29T23:59:59.000Z");
    expect(res.raw.split("\n")).toHaveLength(2);
  });
});

describe("datadogAdapter — search_events: honest empty marker + limit cap", () => {
  it("renders '(no matching events)' when nothing is in window", async () => {
    global.fetch = routeFetch({ logsSearch: () => ({ status: 200, body: { data: [] } }) }) as unknown as typeof fetch;
    const res = await datadogAdapter.query(WS, searchQuery(), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching events)" });
  });

  it("caps total lines at limit (default 200)", async () => {
    const data = Array.from({ length: 250 }, (_, i) =>
      logEntry({
        id: `log-${i}`,
        attributes: { timestamp: new Date(WINDOW_START_MS + i * 1000).toISOString() },
      })
    );
    global.fetch = routeFetch({ logsSearch: () => ({ status: 200, body: { data } }) }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, searchQuery(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(200);
  });

  it("respects an explicit smaller limit, keeping the MOST RECENT entries (tail of the ascending sort)", async () => {
    const data = Array.from({ length: 10 }, (_, i) =>
      logEntry({
        id: `log-${i}`,
        attributes: { timestamp: new Date(WINDOW_START_MS + i * 1000).toISOString(), message: `m${i}` },
      })
    );
    global.fetch = routeFetch({ logsSearch: () => ({ status: 200, body: { data } }) }) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, searchQuery({ limit: 3 }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"m7"');
    expect(lines[2]).toContain('"m9"');
  });

  it("clamps limit:0 to at least one line rather than a bare empty string", async () => {
    global.fetch = routeFetch({
      logsSearch: () => ({ status: 200, body: { data: [logEntry()] } }),
    }) as unknown as typeof fetch;
    const res = await datadogAdapter.query(WS, searchQuery({ limit: 0 }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).not.toBe("");
    expect(res.raw.split("\n")).toHaveLength(1);
  });
});

describe("datadogAdapter — search_events: upstream failure taxonomy", () => {
  it("degrades unauthorized on HTTP 401", async () => {
    global.fetch = routeFetch({ logsSearch: () => ({ status: 401, body: {} }) }) as unknown as typeof fetch;
    const res = await datadogAdapter.query(WS, searchQuery(), SECRET);
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("degrades unauthorized on HTTP 403", async () => {
    global.fetch = routeFetch({ logsSearch: () => ({ status: 403, body: {} }) }) as unknown as typeof fetch;
    const res = await datadogAdapter.query(WS, searchQuery(), SECRET);
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("degrades upstream_error on HTTP 500", async () => {
    global.fetch = routeFetch({ logsSearch: () => ({ status: 500, body: {} }) }) as unknown as typeof fetch;
    const res = await datadogAdapter.query(WS, searchQuery(), SECRET);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("degrades upstream_error on a 429 (rate limited) — no special-casing, no retry", async () => {
    global.fetch = routeFetch({ logsSearch: () => ({ status: 429, body: {} }) }) as unknown as typeof fetch;
    const res = await datadogAdapter.query(WS, searchQuery(), SECRET);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("a thrown/aborted fetch propagates uncaught (the route's job to convert to unreachable — see this module's own doc-comment)", async () => {
    global.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(datadogAdapter.query(WS, searchQuery(), SECRET)).rejects.toThrow("network down");
  });
});

describe("datadogAdapter — search_events: q.query dual filter (server-side quoted phrase AND client-side substring re-filter on the RENDERED LINE)", () => {
  it("omits filter.query entirely when q.query is absent (no hidden default to override, unlike Sentry)", async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = routeFetch({
      logsSearch: (body) => {
        capturedBody = body;
        return { status: 200, body: { data: [] } };
      },
    }) as unknown as typeof fetch;

    await datadogAdapter.query(WS, searchQuery(), SECRET);
    const filter = capturedBody.filter as Record<string, unknown>;
    expect("query" in filter).toBe(false);
  });

  it("quotes a plain word as a message: attribute search (Fix Round 1 — NOT a bare free-text phrase, which the docs say cannot match special characters at all)", async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = routeFetch({
      logsSearch: (body) => {
        capturedBody = body;
        return { status: 200, body: { data: [] } };
      },
    }) as unknown as typeof fetch;

    await datadogAdapter.query(WS, searchQuery({ query: "timeout" }), SECRET);
    const filter = capturedBody.filter as Record<string, unknown>;
    expect(filter.query).toBe('message:"timeout"');
  });

  it("quotes a query containing reserved characters (colon, parens) so Datadog's parser cannot misread it as filter tokens", async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = routeFetch({
      logsSearch: (body) => {
        capturedBody = body;
        return { status: 200, body: { data: [] } };
      },
    }) as unknown as typeof fetch;

    await datadogAdapter.query(WS, searchQuery({ query: "error: connection refused (retry 3)" }), SECRET);
    const filter = capturedBody.filter as Record<string, unknown>;
    expect(filter.query).toBe('message:"error: connection refused (retry 3)"');
  });

  it("escapes an embedded double quote as \\\" (the delimiter itself)", async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = routeFetch({
      logsSearch: (body) => {
        capturedBody = body;
        return { status: 200, body: { data: [] } };
      },
    }) as unknown as typeof fetch;

    await datadogAdapter.query(WS, searchQuery({ query: 'say "hi"' }), SECRET);
    const filter = capturedBody.filter as Record<string, unknown>;
    expect(filter.query).toBe('message:"say \\"hi\\""');
  });

  it("DOUBLES an embedded backslash (\\ -> \\\\) — UNLIKE sentry.ts, because Datadog's own docs list \\ itself as a reserved character requiring escaping", async () => {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = routeFetch({
      logsSearch: (body) => {
        capturedBody = body;
        return { status: 200, body: { data: [] } };
      },
    }) as unknown as typeof fetch;

    await datadogAdapter.query(WS, searchQuery({ query: "C:\\path\\to\\file" }), SECRET);
    const filter = capturedBody.filter as Record<string, unknown>;
    expect(filter.query).toBe('message:"C:\\\\path\\\\to\\\\file"');
  });

  it("filters client-side against the FULL RENDERED LINE (status/service text too), not just the message — the task's own pinned deviation from sentry.ts's/langfuse.ts's field-only re-filter", async () => {
    global.fetch = routeFetch({
      logsSearch: () => ({
        status: 200,
        body: {
          data: [
            logEntry({ id: "t1", attributes: { message: "ordinary log", service: "billing" } }),
            logEntry({ id: "t2", attributes: { message: "another ordinary log", service: "checkout" } }),
          ],
        },
      }),
    }) as unknown as typeof fetch;

    // "billing" appears only in one entry's service field, not its message —
    // proves the re-filter checks the whole rendered line, not message-only.
    const res = await datadogAdapter.query(WS, searchQuery({ query: "billing" }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
    expect(res.raw).toContain("billing");
  });

  it("renders the empty marker when the client-side re-filter matches nothing, even though the (mocked) server 'returned' something", async () => {
    global.fetch = routeFetch({
      logsSearch: () => ({ status: 200, body: { data: [logEntry()] } }),
    }) as unknown as typeof fetch;
    const res = await datadogAdapter.query(WS, searchQuery({ query: "nonexistent-term" }), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching events)" });
  });
});

/**
 * Round-trip tests (pin 3) — simulate Datadog's OWN documented escaping
 * rule (quoting.doc: "the following characters ... require escaping with
 * the \ character: ... \ ..., and spaces"; the one worked example,
 * `@my_attribute:hello\:world`, confirms `\<char>` is stripped back to the
 * literal `<char>` at parse time) run BACKWARDS against this adapter's own
 * wire output, for every category the module doc-comment names — exactly
 * the discipline that would have caught sentry.ts's Fix Round 1 CODA
 * regression before it shipped, now applied proactively here rather than
 * reactively after a bug.
 */
describe("datadogAdapter — search_events: quoteLogSearchText round-trips through Datadog's OWN documented unescape", () => {
  /** Mirrors Datadog's own confirmed unescape rule: strip every `\\` pair
   * back to `\` and every `\"` pair back to `"`, scanning left to right
   * (NOT two independent sequential global replaces, which can misparse an
   * adversarial input with adjacent escape sequences — this scanner
   * consumes exactly 2 characters per recognized escape pair, mirroring
   * what a real parser does). Takes the WIRE value with its `message:`
   * reserved-attribute prefix (Fix Round 1) AND its outer delimiting quotes
   * still attached (exactly what `filter.query` actually contains) — strips
   * the prefix first (proving it's actually present, not just the
   * escaping), then the outer quotes the same way the grammar's own
   * quoted-phrase rule does. */
  function simulateDatadogUnescape(wireValue: string): string {
    const PREFIX = "message:";
    if (!wireValue.startsWith(PREFIX)) {
      throw new Error(`expected wire value to start with "${PREFIX}", got: ${wireValue}`);
    }
    const quoted = wireValue.slice(PREFIX.length);
    const inner = quoted.slice(1, -1);
    let out = "";
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === "\\" && (inner[i + 1] === "\\" || inner[i + 1] === '"')) {
        out += inner[i + 1];
        i++;
      } else {
        out += inner[i];
      }
    }
    return out;
  }

  async function wireQueryFor(query: string): Promise<string> {
    let capturedBody: Record<string, unknown> = {};
    global.fetch = routeFetch({
      logsSearch: (body) => {
        capturedBody = body;
        return { status: 200, body: { data: [] } };
      },
    }) as unknown as typeof fetch;
    await datadogAdapter.query(WS, searchQuery({ query }), SECRET);
    return (capturedBody.filter as Record<string, unknown>).query as string;
  }

  it.each([
    ["reserved chars (colon, parens)", "error: connection refused (retry 3)"],
    ["embedded quotes", 'say "hi"'],
    ["backslash path", "C:\\path\\to\\file"],
    ["mixed backslash + quote", 'C:\\path\\to "file.txt"'],
    ["adjacent escape sequences", '\\"\\\\'],
  ])("round-trips %s unchanged: original → quoteLogSearchText → wire → simulateDatadogUnescape → original", async (_label, original) => {
    const wire = await wireQueryFor(original);
    expect(simulateDatadogUnescape(wire)).toBe(original);
  });
});

describe("datadogAdapter — search_events: request hygiene", () => {
  it("POSTs the logs search endpoint with DD-API-KEY/DD-APPLICATION-KEY headers, Content-Type, User-Agent, an AbortSignal, and the confirmed body shape", async () => {
    const fetchMock = routeFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await datadogAdapter.query(WS, searchQuery(), SECRET);

    expect(fetchMock.mock.calls.length).toBe(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    const parsed = new URL(url as string);
    expect(parsed.origin + parsed.pathname).toBe("https://api.datadoghq.com/api/v2/logs/events/search");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      "DD-API-KEY": API_KEY,
      "DD-APPLICATION-KEY": APP_KEY,
      "User-Agent": "agentrail-console",
      "Content-Type": "application/json",
    });
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    expect(body.sort).toBe("timestamp");
    expect((body.page as Record<string, unknown>).limit).toBe(1000);
    expect((body.filter as Record<string, unknown>).from).toBe(WINDOW_START);
    expect((body.filter as Record<string, unknown>).to).toBe(WINDOW_END);
  });

  it("never requests a second page — single page (this task's own pinned rate-limit discipline)", async () => {
    const fetchMock = routeFetch({ logsSearch: () => ({ status: 200, body: { data: [logEntry()] } }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    await datadogAdapter.query(WS, searchQuery(), SECRET);
    expect(fetchMock.mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pin 4 — catalog↔adapter config-key drift protection + composite
// secret-part-count parity (mirrors langfuse.test.ts's LANGFUSE_SECRET_SPEC
// cross-check and sentry.test.ts's dynamically-keyed FOLD 2 tests).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Fix Round 1, FOLD 3 — datadog.ts's own DATADOG_SITES allowlist and
// verify.ts's independently duplicated one (neither imports the other — see
// each module's own doc-comment for why) must stay set-equal, or the
// adapter's own query path and the connect-time live-verify path would
// silently accept/reject different sites, a real correctness gap no
// individual file's own tests could ever catch.
// ---------------------------------------------------------------------------
describe("datadogAdapter — DATADOG_SITES stays in sync with verify.ts's own duplicate (Fix Round 1, FOLD 3)", () => {
  it("the adapter's allowlist and verify.ts's allowlist are set-equal", () => {
    expect(ADAPTER_DATADOG_SITES.size).toBe(VERIFY_DATADOG_SITES.size);
    for (const site of ADAPTER_DATADOG_SITES) {
      expect(VERIFY_DATADOG_SITES.has(site)).toBe(true);
    }
    for (const site of VERIFY_DATADOG_SITES) {
      expect(ADAPTER_DATADOG_SITES.has(site)).toBe(true);
    }
  });

  it("neither list is accidentally empty (a vacuous set-equality check would pass trivially)", () => {
    expect(ADAPTER_DATADOG_SITES.size).toBeGreaterThan(0);
  });
});

describe("datadogAdapter — DATADOG_SECRET_SPEC matches the real catalog entry (pin 4)", () => {
  it("the adapter's local secretParts count equals the catalog's declared secretParts count", () => {
    const catalogEntry = CONNECTOR_CATALOG.find((c) => c.kind === "datadog")!;
    expect(DATADOG_SECRET_SPEC.secretParts).toHaveLength(catalogEntry.connect!.secretParts!.length);
  });
});

describe("datadogAdapter — catalog↔adapter↔verify config-key alignment (pin 4)", () => {
  const datadogEntry = CONNECTOR_CATALOG.find((c) => c.kind === "datadog")!;
  const catalogFields = datadogEntry.connect!.extraConfigFields!;

  it("the catalog declares exactly ['datadogSite'], required:true — the literal key datadog.ts's query() and verify.ts's verifyDatadog both read", () => {
    expect(catalogFields.map((f) => f.key)).toEqual(["datadogSite"]);
    for (const field of catalogFields) {
      expect(field.required).toBe(true);
    }
  });

  it("the adapter reads config.<catalog-declared-key> — a connector row built from that key (not this test file's own hardcoded SITE constant's key) reaches a real fetch rather than degrading config_missing", async () => {
    const [siteKey] = catalogFields.map((f) => f.key);
    mockGetConnector.mockResolvedValue({
      provider: "datadog" as const,
      enabled: true,
      config: {
        repos: [],
        triggerLabel: "ready-for-agent",
        pollIntervalSeconds: 60,
        [siteKey]: SITE,
      },
      hasSecret: true,
      updatedAt: null,
    } as never);
    global.fetch = routeFetch({}) as unknown as typeof fetch;

    const res = await datadogAdapter.query(WS, q(), SECRET);
    expect(res).not.toEqual({ ok: false, reason: "config_missing" });
  });

  it("verifyDatadog reads config using EXACTLY the catalog's declared key too — a config object built from that key reaches Datadog's verify endpoint rather than failing closed with the site-missing error", async () => {
    const [siteKey] = catalogFields.map((f) => f.key);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: "ok" }) }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("datadog", SECRET, undefined, {
      [siteKey]: SITE,
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(res).toEqual({ ok: true });
  });
});
