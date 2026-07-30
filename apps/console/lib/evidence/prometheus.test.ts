import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors datadog.test.ts's/sentry.test.ts's/langfuse.test.ts's mocking
// idiom (mock the package's named export directly) and its global.fetch
// idiom for the real HTTP calls.
vi.mock("@agentrail/db-postgres", () => ({
  getConnector: vi.fn(),
}));

import { getConnector } from "@agentrail/db-postgres";
import { prometheusAdapter, resolvePrometheusAuth } from "./prometheus";
import { adapterFor } from "./registry";
import type { EvidenceQuery } from "./types";
// Fix Round 1, FOLD 2 precedent (sentry.test.ts / datadog.test.ts): the ONLY
// place this test file imports the catalog and verify.ts — the adapter
// itself (prometheus.ts) never does. Used by the drift-protection and
// auth-heuristic-parity describe blocks near the bottom of this file.
import { CONNECTOR_CATALOG } from "../../app/(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers";
import {
  verifyConnectorCredential,
  resolvePrometheusAuthForVerify,
} from "../../app/api/v1/workspaces/[workspaceId]/connectors/secret/verify";

const mockGetConnector = vi.mocked(getConnector);

const WS = "00000000-0000-0000-0000-000000000001";
const URL_BASE = "https://prometheus.internal:9090";
// A plain bearer-shaped secret (no colon) — the default for every test not
// specifically about the auth heuristic itself.
const SECRET = "prom-bearer-token-abc123";
const WINDOW_START = "2026-07-29T00:00:00.000Z";
const WINDOW_END = "2026-07-29T23:59:59.000Z";
const WINDOW_START_MS = new Date(WINDOW_START).getTime();
const WINDOW_END_MS = new Date(WINDOW_END).getTime();
const WINDOW_END_SEC = WINDOW_END_MS / 1000;
// Computed (never hand-typed) — mirrors datadog.test.ts's ROLLUP_SECONDS
// precedent: a wrong guess here would silently fall outside what the
// adapter actually sends.
const RANGE_SECONDS = Math.max(1, Math.ceil((WINDOW_END_MS - WINDOW_START_MS) / 1000));

function q(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return {
    verb: "signals",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    ...overrides,
  };
}

/** `null` means "omit prometheusUrl from config entirely". */
function connectorRow(prometheusUrl: string | null = URL_BASE) {
  return {
    provider: "prometheus" as const,
    enabled: true,
    config: {
      repos: [],
      triggerLabel: "ready-for-agent",
      pollIntervalSeconds: 60,
      ...(prometheusUrl !== null ? { prometheusUrl } : {}),
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

/** One `result[]` element — `value: [<unix_time_seconds>, "<sample_value>"]`
 * (confirmed shape — see prometheus.ts's own doc-comment, "INSTANT QUERY"). */
function sample(atSec: number, value: number | string) {
  return { metric: {}, value: [atSec, typeof value === "number" ? String(value) : value] };
}

function vectorBody(samples: unknown[]) {
  return { status: "success", data: { resultType: "vector", result: samples } };
}

/** Routes every fetch mock call by pathname (only one path exists for this
 * adapter, unlike datadog.test.ts's two-path router) and lets the caller
 * inspect/branch on the captured URL. */
function routeFetch(handler?: (url: URL) => { status: number; body: unknown }) {
  // Declares BOTH params (even though this function's own body never reads
  // `init`) so `vi.fn`'s inferred mock-call tuple type has an index [1] —
  // every caller that destructures `[url, init] = fetchMock.mock.calls[n]`
  // (the request-hygiene / auth-heuristic tests below) needs it typed.
  // Mirrors sentry.test.ts's own identical `_init` + `void` idiom.
  return vi.fn(async (url: string, _init?: RequestInit) => {
    void _init;
    const parsed = new URL(url);
    if (parsed.pathname !== "/api/v1/query") throw new Error(`unexpected URL: ${url}`);
    const h = handler ? handler(parsed) : { status: 200, body: vectorBody([]) };
    return httpResponse(h.status, h.body);
  });
}

/** Identifies which of the four fixed metric specs a captured `/api/v1/query`
 * request belongs to, by its `query` param text — mirrors datadog.test.ts's
 * `metricKind`. Order matters: check the MOST SPECIFIC substrings first
 * (error_rate/p95/up all also contain "http_requests_total"-adjacent text
 * or would otherwise collide with request_rate's own, broader check). */
function metricKind(url: URL): "request_rate" | "error_rate" | "p95_duration" | "up" {
  const query = url.searchParams.get("query") ?? "";
  if (query.includes('code=~"5..')) return "error_rate";
  if (query.includes("http_request_duration_seconds_bucket")) return "p95_duration";
  if (query.includes("sum(up")) return "up";
  return "request_rate";
}

/** Inverts `escapePromQLString`'s own output — the confirmed Go-style
 * backslash escape rules, limited to the five escape sequences this
 * adapter's own encoder ever produces (`\\`, `\"`, `\n`, `\r`, `\t`). Used
 * only by the round-trip escaping tests below, to independently simulate
 * what PROMETHEUS'S OWN PARSER would do to the wire text, never by calling
 * back into the adapter's own internals. */
function simulatePromQLStringUnescape(wire: string): string {
  let out = "";
  for (let i = 0; i < wire.length; i++) {
    const ch = wire[i];
    if (ch === "\\") {
      const next = wire[i + 1];
      if (next === "\\") {
        out += "\\";
        i++;
      } else if (next === '"') {
        out += '"';
        i++;
      } else if (next === "n") {
        out += "\n";
        i++;
      } else if (next === "r") {
        out += "\r";
        i++;
      } else if (next === "t") {
        out += "\t";
        i++;
      } else {
        out += ch; // shouldn't happen for this adapter's own output
      }
    } else {
      out += ch;
    }
  }
  return out;
}

/** Extracts the WIRE text between a `matcherPrefix` (e.g. `job=~"`) and its
 * matching (backslash-respecting) closing quote out of a captured PromQL
 * query string — the counterpart to `simulatePromQLStringUnescape`, which
 * expects exactly this wire text as its input. */
function extractQuotedMatcherValue(promqlText: string, matcherPrefix: string): string {
  const start = promqlText.indexOf(matcherPrefix);
  if (start === -1) throw new Error(`matcher prefix not found in: ${promqlText}`);
  let i = start + matcherPrefix.length;
  let out = "";
  while (i < promqlText.length) {
    const ch = promqlText[i];
    if (ch === "\\") {
      out += ch + (promqlText[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (ch === '"') break;
    out += ch;
    i++;
  }
  return out;
}

const originalFetch = global.fetch;
const originalWarn = console.warn;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConnector.mockResolvedValue(connectorRow());
});

afterEach(() => {
  global.fetch = originalFetch;
  console.warn = originalWarn;
});

describe("prometheusAdapter — shape", () => {
  it("declares provider 'prometheus' and verbs [signals] only", () => {
    expect(prometheusAdapter.provider).toBe("prometheus");
    expect(prometheusAdapter.verbs).toEqual(["signals"]);
  });

  it("self-registers into the shared registry on module load", () => {
    expect(adapterFor("prometheus")).toBe(prometheusAdapter);
  });
});

describe("prometheusAdapter — bad_request validation", () => {
  it("degrades bad_request on an unparseable windowStart, without ever reading the connector row", async () => {
    const res = await prometheusAdapter.query(WS, q({ windowStart: "not-a-date" }), SECRET);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades bad_request on an unparseable windowEnd", async () => {
    const res = await prometheusAdapter.query(WS, q({ windowEnd: "" }), SECRET);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades bad_request for a verb this adapter does not declare", async () => {
    const res = await prometheusAdapter.query(WS, q({ verb: "search_events" }), SECRET);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
  });
});

describe("prometheusAdapter — config_missing", () => {
  it("degrades config_missing when secret is null, without ever reading the connector row", async () => {
    const res = await prometheusAdapter.query(WS, q(), null);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades config_missing when there is no prometheus connector row at all", async () => {
    mockGetConnector.mockResolvedValue(null);
    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("degrades config_missing when the row exists but prometheusUrl is absent", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(null));
    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("degrades config_missing when prometheusUrl is present but blank/whitespace-only", async () => {
    mockGetConnector.mockResolvedValue(connectorRow("   "));
    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("reads the connector row for provider 'prometheus' specifically", async () => {
    global.fetch = routeFetch() as unknown as typeof fetch;
    await prometheusAdapter.query(WS, q(), SECRET);
    expect(mockGetConnector).toHaveBeenCalledWith(WS, "prometheus");
  });

  it("strips a trailing slash from prometheusUrl before building the fetch target", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(`${URL_BASE}/`));
    let capturedUrl = "";
    global.fetch = routeFetch((url) => {
      capturedUrl = url.toString();
      return { status: 200, body: vectorBody([]) };
    }) as unknown as typeof fetch;
    await prometheusAdapter.query(WS, q(), SECRET);
    expect(capturedUrl.startsWith(`${URL_BASE}/api/v1/query?`)).toBe(true);
  });
});

describe("prometheusAdapter — signals: instant-query request shape (unscoped)", () => {
  it("fires all four metric queries concurrently against /api/v1/query with time=windowEnd (RFC3339, UNCONVERTED)", async () => {
    const captured: URL[] = [];
    global.fetch = routeFetch((url) => {
      captured.push(url);
      return { status: 200, body: vectorBody([]) };
    }) as unknown as typeof fetch;

    await prometheusAdapter.query(WS, q(), SECRET);

    expect(captured).toHaveLength(4);
    for (const url of captured) {
      expect(url.pathname).toBe("/api/v1/query");
      expect(url.searchParams.get("time")).toBe(WINDOW_END);
    }
  });

  it("request_rate: sum(rate(http_requests_total[<W>s])) — no braces at all when unscoped", async () => {
    const captured: URL[] = [];
    global.fetch = routeFetch((url) => {
      captured.push(url);
      return { status: 200, body: vectorBody([]) };
    }) as unknown as typeof fetch;
    await prometheusAdapter.query(WS, q(), SECRET);
    const url = captured.find((u) => metricKind(u) === "request_rate")!;
    expect(url.searchParams.get("query")).toBe(`sum(rate(http_requests_total[${RANGE_SECONDS}s]))`);
  });

  it('error_rate: sum(rate(http_requests_total{code=~"5.."}[<W>s])) — the fixed matcher present even when unscoped', async () => {
    const captured: URL[] = [];
    global.fetch = routeFetch((url) => {
      captured.push(url);
      return { status: 200, body: vectorBody([]) };
    }) as unknown as typeof fetch;
    await prometheusAdapter.query(WS, q(), SECRET);
    const url = captured.find((u) => metricKind(u) === "error_rate")!;
    expect(url.searchParams.get("query")).toBe(
      `sum(rate(http_requests_total{code=~"5.."}[${RANGE_SECONDS}s]))`
    );
  });

  it("p95_duration: histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[<W>s])))", async () => {
    const captured: URL[] = [];
    global.fetch = routeFetch((url) => {
      captured.push(url);
      return { status: 200, body: vectorBody([]) };
    }) as unknown as typeof fetch;
    await prometheusAdapter.query(WS, q(), SECRET);
    const url = captured.find((u) => metricKind(u) === "p95_duration")!;
    expect(url.searchParams.get("query")).toBe(
      `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[${RANGE_SECONDS}s])))`
    );
  });

  it("up: sum(up) — a gauge read, NO range selector and NO rate()", async () => {
    const captured: URL[] = [];
    global.fetch = routeFetch((url) => {
      captured.push(url);
      return { status: 200, body: vectorBody([]) };
    }) as unknown as typeof fetch;
    await prometheusAdapter.query(WS, q(), SECRET);
    const url = captured.find((u) => metricKind(u) === "up")!;
    expect(url.searchParams.get("query")).toBe("sum(up)");
  });
});

describe("prometheusAdapter — signals: happy path rendering", () => {
  it("renders all four fixed metrics, one line each, unscoped", async () => {
    global.fetch = routeFetch((url) => {
      const kind = metricKind(url);
      if (kind === "request_rate") return { status: 200, body: vectorBody([sample(WINDOW_END_SEC, 42)]) };
      if (kind === "error_rate") return { status: 200, body: vectorBody([sample(WINDOW_END_SEC, 1.5)]) };
      if (kind === "p95_duration") return { status: 200, body: vectorBody([sample(WINDOW_END_SEC, 0.231)]) };
      return { status: 200, body: vectorBody([sample(WINDOW_END_SEC, 3)]) };
    }) as unknown as typeof fetch;

    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n").sort();
    expect(lines).toEqual(
      [
        `signal prometheus.http.request_rate window_agg=sum value=42 at=${WINDOW_END}`,
        `signal prometheus.http.error_rate{code=~"5.."} window_agg=sum value=1.5 at=${WINDOW_END}`,
        `signal prometheus.http.request_duration_seconds window_agg=p95 value=0.231 at=${WINDOW_END}`,
        `signal prometheus.up.count window_agg=sum value=3 at=${WINDOW_END}`,
      ].sort()
    );
  });

  it("embeds q.scope as a job=~ matcher on ALL FOUR queries, reflected verbatim in the rendered {labels}", async () => {
    const captured: URL[] = [];
    global.fetch = routeFetch((url) => {
      captured.push(url);
      if (metricKind(url) !== "request_rate") return { status: 200, body: vectorBody([]) };
      return { status: 200, body: vectorBody([sample(WINDOW_END_SEC, 7)]) };
    }) as unknown as typeof fetch;

    const res = await prometheusAdapter.query(WS, q({ scope: "checkout-service" }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    for (const url of captured) {
      expect(url.searchParams.get("query")).toContain('job=~"checkout-service"');
    }
    expect(res.raw).toContain('prometheus.http.request_rate{job=~"checkout-service"} window_agg=sum value=7');
  });

  it("combines the scope matcher with error_rate's own fixed matcher: {job=~\"...\",code=~\"5..\"}", async () => {
    const captured: URL[] = [];
    global.fetch = routeFetch((url) => {
      captured.push(url);
      return { status: 200, body: vectorBody([]) };
    }) as unknown as typeof fetch;
    await prometheusAdapter.query(WS, q({ scope: "checkout" }), SECRET);
    const url = captured.find((u) => metricKind(u) === "error_rate")!;
    expect(url.searchParams.get("query")).toContain('{job=~"checkout",code=~"5.."}');
  });

  it("renders a SINGLE returned element AS RETURNED, at ITS OWN timestamp (real data preserved untouched, nothing synthesized)", async () => {
    const atSec = WINDOW_START_MS / 1000 + 3600;
    global.fetch = routeFetch((url) => {
      if (metricKind(url) !== "request_rate") return { status: 200, body: vectorBody([]) };
      return { status: 200, body: vectorBody([sample(atSec, 99.5)]) };
    }) as unknown as typeof fetch;

    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain(`value=99.5 at=${new Date(atSec * 1000).toISOString()}`);
  });

  it("skips an element whose value is NaN/+Inf/-Inf — Prometheus's own 'no meaningful number' signal, never rendered as a fabricated value", async () => {
    global.fetch = routeFetch((url) => {
      if (metricKind(url) !== "p95_duration") return { status: 200, body: vectorBody([]) };
      return { status: 200, body: vectorBody([sample(WINDOW_END_SEC, "NaN")]) };
    }) as unknown as typeof fetch;

    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).not.toContain("prometheus.http.request_duration_seconds");
  });

  it("treats a malformed 200 body (resultType missing / not 'vector') as zero elements for that metric, not an error", async () => {
    global.fetch = routeFetch(() => ({ status: 200, body: { status: "success", data: { resultType: "scalar", result: [1, "1"] } } })) as unknown as typeof fetch;
    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching signals)" });
  });

  it("treats a malformed 200 body (no data key at all) as zero elements, not an error", async () => {
    global.fetch = routeFetch(() => ({ status: 200, body: { status: "error", errorType: "bad_data" } })) as unknown as typeof fetch;
    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching signals)" });
  });
});

describe("prometheusAdapter — signals: honest empty marker + limit cap", () => {
  it("renders '(no matching signals)' when every metric returns zero usable elements", async () => {
    global.fetch = routeFetch() as unknown as typeof fetch;
    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: true, raw: "(no matching signals)" });
  });

  it("the cap is structurally unreachable from this verb — at most 4 real lines regardless of q.limit", async () => {
    global.fetch = routeFetch((url) => {
      const kind = metricKind(url);
      const v = kind === "request_rate" ? 1 : kind === "error_rate" ? 2 : kind === "p95_duration" ? 0.3 : 4;
      return { status: 200, body: vectorBody([sample(WINDOW_END_SEC, v)]) };
    }) as unknown as typeof fetch;
    const res = await prometheusAdapter.query(WS, q({ limit: 50 }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(4);
  });

  it("clamps limit:0 to at least one line", async () => {
    global.fetch = routeFetch((url) => {
      if (metricKind(url) !== "request_rate") return { status: 200, body: vectorBody([]) };
      return { status: 200, body: vectorBody([sample(WINDOW_END_SEC, 1)]) };
    }) as unknown as typeof fetch;
    const res = await prometheusAdapter.query(WS, q({ limit: 0 }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
  });
});

describe("prometheusAdapter — signals: q.query is DELIBERATELY IGNORED (pin)", () => {
  it("a q.query matching nothing textually still returns every signal — proves it is never applied as a client-side filter", async () => {
    global.fetch = routeFetch((url) => {
      const kind = metricKind(url);
      const v = kind === "request_rate" ? 1 : kind === "error_rate" ? 2 : kind === "p95_duration" ? 0.3 : 4;
      return { status: 200, body: vectorBody([sample(WINDOW_END_SEC, v)]) };
    }) as unknown as typeof fetch;

    const res = await prometheusAdapter.query(WS, q({ query: "totally-unrelated-text-xyz" }), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(4);
  });

  it("q.query never rides server-side into any of the four PromQL query strings", async () => {
    const captured: URL[] = [];
    global.fetch = routeFetch((url) => {
      captured.push(url);
      return { status: 200, body: vectorBody([]) };
    }) as unknown as typeof fetch;
    await prometheusAdapter.query(WS, q({ query: "should-never-appear-in-any-query" }), SECRET);
    expect(captured).toHaveLength(4);
    for (const url of captured) {
      expect(url.searchParams.get("query")).not.toContain("should-never-appear-in-any-query");
    }
  });
});

describe("prometheusAdapter — signals: belt — combines >1 surviving element honestly per metric", () => {
  it("sums multiple elements for request_rate (sum for rate/count-shaped metrics)", async () => {
    global.fetch = routeFetch((url) => {
      if (metricKind(url) !== "request_rate") return { status: 200, body: vectorBody([]) };
      return { status: 200, body: vectorBody([sample(WINDOW_END_SEC, 10), sample(WINDOW_END_SEC, 15)]) };
    }) as unknown as typeof fetch;

    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain(`prometheus.http.request_rate window_agg=sum value=25 at=${WINDOW_END}`);
    expect(res.raw).not.toContain("value=10");
    expect(res.raw).not.toContain("value=15");
  });

  it("sums multiple elements for up (a count of how many targets are up)", async () => {
    global.fetch = routeFetch((url) => {
      if (metricKind(url) !== "up") return { status: 200, body: vectorBody([]) };
      return { status: 200, body: vectorBody([sample(WINDOW_END_SEC, 3), sample(WINDOW_END_SEC, 2)]) };
    }) as unknown as typeof fetch;

    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("prometheus.up.count window_agg=sum value=5");
  });

  it("takes the MAX of multiple elements for p95_duration (the task's own pinned belt choice for p95)", async () => {
    global.fetch = routeFetch((url) => {
      if (metricKind(url) !== "p95_duration") return { status: 200, body: vectorBody([]) };
      return { status: 200, body: vectorBody([sample(WINDOW_END_SEC, 0.2), sample(WINDOW_END_SEC, 0.8)]) };
    }) as unknown as typeof fetch;

    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("prometheus.http.request_duration_seconds window_agg=p95 value=0.8");
    expect(res.raw).not.toContain("value=0.2");
  });

  it("stamps the belt-combined value at windowEnd, never a single element's own (now-synthesized-away) timestamp", async () => {
    const earlier = WINDOW_START_MS / 1000 + 60;
    global.fetch = routeFetch((url) => {
      if (metricKind(url) !== "request_rate") return { status: 200, body: vectorBody([]) };
      return { status: 200, body: vectorBody([sample(earlier, 1), sample(earlier + 30, 1)]) };
    }) as unknown as typeof fetch;

    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain(`value=2 at=${WINDOW_END}`);
  });

  it("rounds a synthesized belt sum to 4 decimal places rather than a raw repeating-decimal float", async () => {
    global.fetch = routeFetch((url) => {
      if (metricKind(url) !== "request_rate") return { status: 200, body: vectorBody([]) };
      return { status: 200, body: vectorBody([sample(WINDOW_END_SEC, 0.1), sample(WINDOW_END_SEC, 0.2)]) };
    }) as unknown as typeof fetch;

    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // 0.1 + 0.2 === 0.30000000000000004 in raw float arithmetic.
    expect(res.raw).toContain("value=0.3 ");
  });
});

describe("prometheusAdapter — signals: window sanity — never drops, warns instead (pin)", () => {
  it("renders a sample whose timestamp is far outside the requested instant anyway (never dropped) and warns once", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wayOffSec = WINDOW_END_SEC - 24 * 3600; // 1 day before windowEnd — well outside the 5-minute margin
    global.fetch = routeFetch((url) => {
      if (metricKind(url) !== "request_rate") return { status: 200, body: vectorBody([]) };
      return { status: 200, body: vectorBody([sample(wayOffSec, 42)]) };
    }) as unknown as typeof fetch;

    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain(`value=42 at=${new Date(wayOffSec * 1000).toISOString()}`);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("request_rate");
  });

  it("does NOT warn for a sample exactly at windowEnd (the expected, compliant case)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = routeFetch((url) => {
      if (metricKind(url) !== "request_rate") return { status: 200, body: vectorBody([]) };
      return { status: 200, body: vectorBody([sample(WINDOW_END_SEC, 42)]) };
    }) as unknown as typeof fetch;

    await prometheusAdapter.query(WS, q(), SECRET);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT warn for a sample within the margin but not exactly at windowEnd", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = routeFetch((url) => {
      if (metricKind(url) !== "request_rate") return { status: 200, body: vectorBody([]) };
      return { status: 200, body: vectorBody([sample(WINDOW_END_SEC - 60, 42)]) }; // 1 minute early
    }) as unknown as typeof fetch;

    await prometheusAdapter.query(WS, q(), SECRET);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("prometheusAdapter — signals: per-metric failure isolation", () => {
  it("one metric's fetch 500s: a cap-exempt marker, rendered first; the other three metrics' lines still render, ok:true", async () => {
    global.fetch = routeFetch((url) => {
      const kind = metricKind(url);
      if (kind === "request_rate") return { status: 500, body: {} };
      const v = kind === "error_rate" ? 1 : kind === "p95_duration" ? 0.4 : 2;
      return { status: 200, body: vectorBody([sample(WINDOW_END_SEC, v)]) };
    }) as unknown as typeof fetch;

    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toBe("(signal request_rate: prometheus upstream_error)");
    const realLines = lines.filter((l) => l.startsWith("signal "));
    expect(realLines).toHaveLength(3);
  });

  it("a thrown fetch for one metric renders '(signal {key}: prometheus unreachable)' when its siblings succeed", async () => {
    global.fetch = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname !== "/api/v1/query") throw new Error("unexpected URL");
      if (metricKind(parsed) === "up") throw new Error("network down");
      return httpResponse(200, vectorBody([sample(WINDOW_END_SEC, 1)]));
    }) as unknown as typeof fetch;

    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("(signal up: prometheus unreachable)");
  });

  it("degrades to upstream_error when every metric's fetch fails", async () => {
    global.fetch = routeFetch(() => ({ status: 503, body: {} })) as unknown as typeof fetch;
    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("maps a 401 to unauthorized and a non-2xx/non-401/403 to upstream_error, per metric", async () => {
    global.fetch = routeFetch((url) => {
      const kind = metricKind(url);
      if (kind === "request_rate") return { status: 401, body: {} };
      if (kind === "error_rate") return { status: 403, body: {} };
      if (kind === "p95_duration") return { status: 502, body: {} };
      return { status: 200, body: vectorBody([sample(WINDOW_END_SEC, 1)]) };
    }) as unknown as typeof fetch;

    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("(signal request_rate: prometheus unauthorized)");
    expect(res.raw).toContain("(signal error_rate: prometheus unauthorized)");
    expect(res.raw).toContain("(signal p95_duration: prometheus upstream_error)");
  });
});

describe("prometheusAdapter — signals: request hygiene", () => {
  it("fires all four metric queries concurrently, each with Accept/Authorization/User-Agent headers and an AbortSignal", async () => {
    const fetchMock = routeFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    await prometheusAdapter.query(WS, q(), SECRET);

    expect(fetchMock.mock.calls.length).toBe(4);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(new URL(url as string).pathname).toBe("/api/v1/query");
      expect((init as RequestInit).headers).toMatchObject({
        Accept: "application/json",
        Authorization: `Bearer ${SECRET}`,
        "User-Agent": "agentrail-console",
      });
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });
});

describe("prometheusAdapter — signals: auth heuristic applied to real requests", () => {
  it("sends Authorization: Bearer <token> when the secret has no colon", async () => {
    const fetchMock = routeFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    await prometheusAdapter.query(WS, q(), "plain-bearer-token-no-colon");
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer plain-bearer-token-no-colon",
    });
  });

  it("sends Authorization: Basic base64(user:pass) when the secret contains a colon", async () => {
    const fetchMock = routeFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    await prometheusAdapter.query(WS, q(), "myuser:mypass");
    const [, init] = fetchMock.mock.calls[0];
    const expected = `Basic ${Buffer.from("myuser:mypass").toString("base64")}`;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: expected });
  });

  it("splits on the FIRST colon only — a password containing its own colon is preserved whole (RFC 7617)", async () => {
    const fetchMock = routeFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    await prometheusAdapter.query(WS, q(), "myuser:my:pass:word");
    const [, init] = fetchMock.mock.calls[0];
    const expected = `Basic ${Buffer.from("myuser:my:pass:word").toString("base64")}`;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: expected });
  });
});

describe("resolvePrometheusAuth — parity with verify.ts's own independent duplicate (heuristic sync)", () => {
  it.each([
    ["a plain bearer token (no colon)", "sometoken1234567890"],
    ["a user:pass pair", "myuser:mypass"],
    ["a user:pass pair whose password itself contains a colon", "myuser:my:pass:word"],
    ["a value that is only a colon", ":"],
  ])("%s: the adapter's own heuristic and verify.ts's independent duplicate agree", (_label, secret) => {
    expect(resolvePrometheusAuth(secret)).toEqual(resolvePrometheusAuthForVerify(secret));
  });
});

describe("prometheusAdapter — signals: q.scope escaping round-trips through BOTH layers (pin 3)", () => {
  it.each([
    ["plain text", "checkout-service"],
    ["a regex metacharacter set", "svc.name+v1(prod)|x*y?[z]{1}^$"],
    ["an embedded double quote", 'svc"name'],
    ["an embedded backslash", "svc\\name"],
    ["a mix of backslash, quote, and metacharacters", 'a.b\\c"d(e)'],
  ])(
    "scope with %s: the captured query's job=~ matcher, PromQL-unescaped then compiled as a fully-anchored regex, matches the ORIGINAL scope exactly and nothing more",
    async (_label, scope) => {
      const captured: URL[] = [];
      global.fetch = routeFetch((url) => {
        captured.push(url);
        return { status: 200, body: vectorBody([]) };
      }) as unknown as typeof fetch;

      await prometheusAdapter.query(WS, q({ scope }), SECRET);

      const requestRateUrl = captured.find((u) => metricKind(u) === "request_rate")!;
      const promqlText = requestRateUrl.searchParams.get("query")!;
      const wire = extractQuotedMatcherValue(promqlText, 'job=~"');
      const layer1 = simulatePromQLStringUnescape(wire);

      const re = new RegExp(`^(?:${layer1})$`);
      expect(re.test(scope)).toBe(true);
      expect(re.test(`${scope}x`)).toBe(false);
      expect(re.test(`x${scope}`)).toBe(false);
    }
  );

  it("a literal '.' in scope is treated as a LITERAL character, not the regex any-character wildcard", async () => {
    const captured: URL[] = [];
    global.fetch = routeFetch((url) => {
      captured.push(url);
      return { status: 200, body: vectorBody([]) };
    }) as unknown as typeof fetch;

    await prometheusAdapter.query(WS, q({ scope: "a.b" }), SECRET);

    const url = captured.find((u) => metricKind(u) === "request_rate")!;
    const wire = extractQuotedMatcherValue(url.searchParams.get("query")!, 'job=~"');
    const layer1 = simulatePromQLStringUnescape(wire);
    const re = new RegExp(`^(?:${layer1})$`);

    expect(re.test("a.b")).toBe(true);
    // If "." had been left as a real regex metacharacter, "aXb" would ALSO
    // match — proving it was escaped to a literal dot instead.
    expect(re.test("aXb")).toBe(false);
  });

  it("scope containing a literal newline is embedded via its Go-style \\n escape sequence, not a raw byte that would break the query syntax", async () => {
    const captured: URL[] = [];
    global.fetch = routeFetch((url) => {
      captured.push(url);
      return { status: 200, body: vectorBody([]) };
    }) as unknown as typeof fetch;

    const scope = "line1\nline2";
    await prometheusAdapter.query(WS, q({ scope }), SECRET);

    const url = captured.find((u) => metricKind(u) === "request_rate")!;
    const promqlText = url.searchParams.get("query")!;
    // No raw newline byte anywhere in the query text sent over the wire.
    expect(promqlText).not.toContain("\n");
    const wire = extractQuotedMatcherValue(promqlText, 'job=~"');
    const layer1 = simulatePromQLStringUnescape(wire);
    const re = new RegExp(`^(?:${layer1})$`);
    expect(re.test(scope)).toBe(true);
  });
});

describe("prometheusAdapter — catalog↔adapter↔verify config-key alignment (pin 4)", () => {
  const prometheusEntry = CONNECTOR_CATALOG.find((c) => c.kind === "prometheus")!;
  const catalogFields = prometheusEntry.connect!.extraConfigFields!;

  it("the catalog declares exactly ['prometheusUrl'], required:true — the literal key prometheus.ts's query() and verify.ts's verifyPrometheus both read", () => {
    expect(catalogFields.map((f) => f.key)).toEqual(["prometheusUrl"]);
    for (const field of catalogFields) {
      expect(field.required).toBe(true);
    }
  });

  it("declares NO secretParts/secretPartPatterns — a single, non-composite secret, unlike langfuse/datadog", () => {
    expect(prometheusEntry.connect?.secretParts).toBeUndefined();
    expect(prometheusEntry.connect?.secretPartPatterns).toBeUndefined();
  });

  it("the adapter reads config.<catalog-declared-key> — a connector row built from that key (not this test file's own hardcoded URL_BASE constant's key) reaches a real fetch rather than degrading config_missing", async () => {
    const [urlKey] = catalogFields.map((f) => f.key);
    mockGetConnector.mockResolvedValue({
      provider: "prometheus" as const,
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

    const res = await prometheusAdapter.query(WS, q(), SECRET);
    expect(res).not.toEqual({ ok: false, reason: "config_missing" });
  });

  it("verifyPrometheus reads config using EXACTLY the catalog's declared key too — a config object built from that key reaches Prometheus's buildinfo endpoint rather than failing closed with the URL-missing error", async () => {
    const [urlKey] = catalogFields.map((f) => f.key);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: "success", data: {} }) }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("prometheus", SECRET, undefined, {
      [urlKey]: URL_BASE,
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(res).toEqual({ ok: true });
  });
});
