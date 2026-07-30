import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors langfuse.test.ts's/railway.test.ts's mocking idiom (mock the
// package's named export directly) and its global.fetch idiom for the real
// HTTP calls.
vi.mock("@agentrail/db-postgres", () => ({
  getConnector: vi.fn(),
}));

import { getConnector } from "@agentrail/db-postgres";
import { sentryAdapter } from "./sentry";
import { adapterFor } from "./registry";
import type { EvidenceQuery, EvidenceVerb } from "./types";
// Fix Round 1, FOLD 2: the ONLY place this test file imports the catalog
// (and verify.ts) — the adapter itself (sentry.ts) never does, mirroring
// langfuse.test.ts's identical "cross-check only from the test" precedent.
// Used exclusively by the drift-protection describe block at the bottom of
// this file.
import { CONNECTOR_CATALOG } from "../../app/(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers";
import { verifyConnectorCredential } from "../../app/api/v1/workspaces/[workspaceId]/connectors/secret/verify";

const mockGetConnector = vi.mocked(getConnector);

const WS = "00000000-0000-0000-0000-000000000001";
const TOKEN = "sntrys_abc123";
const ORG = "acme";
const PROJECT = "web";
const WINDOW_START = "2026-07-29T00:00:00.000Z";
const WINDOW_END = "2026-07-29T23:59:59.000Z";
// Computed (never hand-typed magic numbers — a wrong guess here would
// silently fall outside the belt-and-braces window filter under test).
const WINDOW_START_SEC = Math.floor(new Date(WINDOW_START).getTime() / 1000);
const WINDOW_START_PLUS_12H_SEC = WINDOW_START_SEC + 12 * 3600;

function q(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return {
    verb: "search_events",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    ...overrides,
  };
}

/** `null` for either arg means "omit that key from config entirely". */
function connectorRow(sentryOrg: string | null = ORG, sentryProject: string | null = PROJECT) {
  return {
    provider: "sentry" as const,
    enabled: true,
    config: {
      repos: [],
      triggerLabel: "ready-for-agent",
      pollIntervalSeconds: 60,
      ...(sentryOrg !== null ? { sentryOrg } : {}),
      ...(sentryProject !== null ? { sentryProject } : {}),
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

function issueEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "1234567890",
    shortId: "WEB-1",
    level: "error",
    title: "TypeError: Cannot read property 'foo' of undefined",
    count: "42",
    lastSeen: "2026-07-29T14:02:00.000Z",
    ...overrides,
  };
}

interface RouteHandlers {
  issues?: (url: URL) => { status: number; body: unknown };
  stats?: (url: URL) => { status: number; body: unknown };
}

/** Routes a fetch mock by inspecting the requested URL's pathname — mirrors
 * langfuse.test.ts's `routeFetch`. Declares the (unused) `init` param
 * explicitly so `fetchMock.mock.calls[n]` types as a real 2-tuple for the
 * request-hygiene tests below, which inspect it. */
function routeFetch(handlers: RouteHandlers) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    void _init;
    const parsed = new URL(url);
    if (parsed.pathname === `/api/0/organizations/${ORG}/issues/`) {
      const h = handlers.issues ? handlers.issues(parsed) : { status: 200, body: [] };
      return httpResponse(h.status, h.body);
    }
    if (parsed.pathname === `/api/0/organizations/${ORG}/events/stats/`) {
      const h = handlers.stats ? handlers.stats(parsed) : { status: 200, body: { data: [] } };
      return httpResponse(h.status, h.body);
    }
    throw new Error(`unexpected URL: ${url}`);
  });
}

/** Identifies which of the three fixed metric specs a captured events/stats
 * request belongs to, by its yAxis/query shape. */
function metricKind(url: URL): "count" | "errors" | "p95_duration" {
  const yAxis = url.searchParams.get("yAxis");
  if (yAxis === "p95(transaction.duration)") return "p95_duration";
  const query = url.searchParams.get("query") ?? "";
  return query.includes("level:error") ? "errors" : "count";
}

function statsPoint(value: number | null, unixSeconds: number, key = "count") {
  return [unixSeconds, [{ [key]: value }]];
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConnector.mockResolvedValue(connectorRow());
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("sentryAdapter — shape", () => {
  it("declares provider 'sentry' and verbs [search_events, signals]", () => {
    expect(sentryAdapter.provider).toBe("sentry");
    expect(sentryAdapter.verbs).toEqual(["search_events", "signals"]);
  });

  it("self-registers into the shared registry on module load", () => {
    expect(adapterFor("sentry")).toBe(sentryAdapter);
  });
});

describe("sentryAdapter — bad_request validation", () => {
  it("degrades bad_request on an unparseable windowStart, without ever reading the connector row", async () => {
    const res = await sentryAdapter.query(WS, q({ windowStart: "not-a-date" }), TOKEN);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades bad_request on an unparseable windowEnd", async () => {
    const res = await sentryAdapter.query(WS, q({ windowEnd: "" }), TOKEN);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
  });

  it("degrades bad_request for a verb this adapter does not declare", async () => {
    const res = await sentryAdapter.query(WS, q({ verb: "changes" as EvidenceVerb }), TOKEN);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });
});

describe("sentryAdapter — config_missing", () => {
  it("degrades config_missing when secret is null, without ever reading the connector row", async () => {
    const res = await sentryAdapter.query(WS, q(), null);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades config_missing when there is no sentry connector row at all", async () => {
    mockGetConnector.mockResolvedValue(null);
    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("degrades config_missing when the row exists but sentryOrg is absent", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(null, PROJECT));
    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("degrades config_missing when sentryOrg is present but sentryProject is absent", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(ORG, null));
    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("reads the connector row for provider 'sentry' specifically", async () => {
    global.fetch = routeFetch({}) as unknown as typeof fetch;
    await sentryAdapter.query(WS, q(), TOKEN);
    expect(mockGetConnector).toHaveBeenCalledWith(WS, "sentry");
  });
});

// ---------------------------------------------------------------------------
// search_events
// ---------------------------------------------------------------------------

describe("sentryAdapter — search_events: happy path rendering", () => {
  it("renders a single issue: shortId preferred over id, level, quoted title, count, iso lastSeen", async () => {
    global.fetch = routeFetch({
      issues: () => ({ status: 200, body: [issueEntry()] }),
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({
      ok: true,
      raw: 'event WEB-1 level=error "TypeError: Cannot read property \'foo\' of undefined" count=42 at=2026-07-29T14:02:00.000Z',
    });
  });

  it("falls back to id when shortId is absent", async () => {
    global.fetch = routeFetch({
      issues: () => ({ status: 200, body: [issueEntry({ shortId: undefined })] }),
    }) as unknown as typeof fetch;
    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("event 1234567890 ");
  });

  it("falls back to level=- when level is absent", async () => {
    global.fetch = routeFetch({
      issues: () => ({ status: 200, body: [issueEntry({ level: null })] }),
    }) as unknown as typeof fetch;
    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("level=- ");
  });

  it("falls back to count=- when count is neither a string nor a number", async () => {
    global.fetch = routeFetch({
      issues: () => ({ status: 200, body: [issueEntry({ count: null })] }),
    }) as unknown as typeof fetch;
    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("count=-");
  });

  it("accepts a numeric count too (defensive — docs show it as a string)", async () => {
    global.fetch = routeFetch({
      issues: () => ({ status: 200, body: [issueEntry({ count: 7 })] }),
    }) as unknown as typeof fetch;
    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("count=7 ");
  });

  it("renders multiple issues chronologically (ascending), not trusting server ordering", async () => {
    global.fetch = routeFetch({
      issues: () => ({
        status: 200,
        body: [
          issueEntry({ shortId: "WEB-NEW", lastSeen: "2026-07-29T18:00:00.000Z" }),
          issueEntry({ shortId: "WEB-OLD", lastSeen: "2026-07-29T10:00:00.000Z" }),
        ],
      }),
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toContain("WEB-OLD");
    expect(lines[1]).toContain("WEB-NEW");
  });

  it("skips an entry missing both shortId and id, or with an unparseable lastSeen, rather than throwing", async () => {
    global.fetch = routeFetch({
      issues: () => ({
        status: 200,
        body: [
          issueEntry({ shortId: undefined, id: undefined }),
          issueEntry({ shortId: "WEB-BAD-TS", lastSeen: "not-a-date" }),
          issueEntry({ shortId: "WEB-GOOD" }),
        ],
      }),
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("WEB-GOOD");
    expect(res.raw.split("\n")).toHaveLength(1);
  });

  it("treats a malformed 200 body (not an array) as zero entries, not an error", async () => {
    global.fetch = routeFetch({
      issues: () => ({ status: 200, body: { not: "an array" } }),
    }) as unknown as typeof fetch;
    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: true, raw: "(no matching events)" });
  });
});

describe("sentryAdapter — search_events: window filtering (belt-and-braces client-side re-filter)", () => {
  it("excludes issues outside [windowStart, windowEnd] by lastSeen, keeping inclusive bounds", async () => {
    global.fetch = routeFetch({
      issues: () => ({
        status: 200,
        body: [
          issueEntry({ shortId: "before", lastSeen: "2026-07-28T23:00:00.000Z" }),
          issueEntry({ shortId: "after", lastSeen: "2026-07-30T00:00:01.000Z" }),
          issueEntry({ shortId: "at-start", lastSeen: WINDOW_START }),
          issueEntry({ shortId: "at-end", lastSeen: WINDOW_END }),
        ],
      }),
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("at-start");
    expect(res.raw).toContain("at-end");
    expect(res.raw).not.toContain("before");
    expect(res.raw).not.toContain("after");
  });

  it("drops an issue whose lastSeen falls outside the window even though the mock 'returns' it regardless of the server-side start/end it was sent", async () => {
    global.fetch = routeFetch({
      issues: () => ({
        status: 200,
        body: [
          issueEntry({ shortId: "in-window", lastSeen: "2026-07-29T12:00:00.000Z" }),
          issueEntry({ shortId: "leaked", lastSeen: "2026-08-01T00:00:00.000Z" }),
        ],
      }),
    }) as unknown as typeof fetch;
    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("in-window");
    expect(res.raw).not.toContain("leaked");
  });
});

describe("sentryAdapter — search_events: honest empty marker + limit cap", () => {
  it("renders '(no matching events)' when nothing is in window", async () => {
    global.fetch = routeFetch({ issues: () => ({ status: 200, body: [] }) }) as unknown as typeof fetch;
    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: true, raw: "(no matching events)" });
  });

  it("caps total lines at limit (default 200)", async () => {
    const body = Array.from({ length: 250 }, (_, i) =>
      issueEntry({
        shortId: `WEB-${i}`,
        lastSeen: new Date(new Date(WINDOW_START).getTime() + i * 1000).toISOString(),
      })
    );
    global.fetch = routeFetch({ issues: () => ({ status: 200, body }) }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // A single page (SEARCH_EVENTS_PAGE_SIZE=100 requested) — the mock
    // returns everything regardless, but only 200 of the (up to 250) fetched
    // candidates render, per the default limit.
    expect(res.raw.split("\n")).toHaveLength(200);
  });

  it("respects an explicit smaller limit, keeping the MOST RECENT entries (tail of the ascending sort)", async () => {
    const body = Array.from({ length: 10 }, (_, i) =>
      issueEntry({
        shortId: `WEB-${i}`,
        lastSeen: new Date(new Date(WINDOW_START).getTime() + i * 1000).toISOString(),
      })
    );
    global.fetch = routeFetch({ issues: () => ({ status: 200, body }) }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, q({ limit: 3 }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("WEB-7");
    expect(lines[2]).toContain("WEB-9");
  });

  it("clamps limit:0 to at least one line rather than a bare empty string", async () => {
    global.fetch = routeFetch({ issues: () => ({ status: 200, body: [issueEntry()] }) }) as unknown as typeof fetch;
    const res = await sentryAdapter.query(WS, q({ limit: 0 }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).not.toBe("");
    expect(res.raw.split("\n")).toHaveLength(1);
  });
});

describe("sentryAdapter — search_events: upstream failure taxonomy", () => {
  it("degrades unauthorized on HTTP 401", async () => {
    global.fetch = routeFetch({ issues: () => ({ status: 401, body: [] }) }) as unknown as typeof fetch;
    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("degrades unauthorized on HTTP 403", async () => {
    global.fetch = routeFetch({ issues: () => ({ status: 403, body: [] }) }) as unknown as typeof fetch;
    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("degrades upstream_error on HTTP 500", async () => {
    global.fetch = routeFetch({ issues: () => ({ status: 500, body: [] }) }) as unknown as typeof fetch;
    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("degrades upstream_error on a 429 (rate limited) — no special-casing, no retry", async () => {
    global.fetch = routeFetch({ issues: () => ({ status: 429, body: [] }) }) as unknown as typeof fetch;
    const res = await sentryAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("a thrown/aborted fetch propagates uncaught (the route's job to convert to unreachable — see this module's own doc-comment)", async () => {
    global.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(sentryAdapter.query(WS, q(), TOKEN)).rejects.toThrow("network down");
  });
});

describe("sentryAdapter — search_events: q.query dual filter (server-side param AND client-side title match)", () => {
  it("sends a PLAIN word q.query wrapped in quotes — quoted ALWAYS, not conditionally (Fix Round 1, FOLD 1: uniformity over special-casing)", async () => {
    let captured: URL | null = null;
    global.fetch = routeFetch({
      issues: (url) => {
        captured = url;
        return { status: 200, body: [] };
      },
    }) as unknown as typeof fetch;

    await sentryAdapter.query(WS, q({ query: "TypeError" }), TOKEN);
    expect(captured!.searchParams.get("query")).toBe('"TypeError"');
    expect(captured!.searchParams.get("project")).toBe(PROJECT);
  });

  it("quotes a q.query containing a colon — the adapter's own core use case (a real error title, 'TypeError: x is undefined') — so Sentry's parser cannot misread it as a key:value token", async () => {
    let captured: URL | null = null;
    global.fetch = routeFetch({
      issues: (url) => {
        captured = url;
        return { status: 200, body: [] };
      },
    }) as unknown as typeof fetch;

    await sentryAdapter.query(WS, q({ query: "TypeError: x is undefined" }), TOKEN);
    expect(captured!.searchParams.get("query")).toBe('"TypeError: x is undefined"');
  });

  it("escapes an embedded double quote in q.query as \\\" (Sentry's own documented quoted-value escape unit)", async () => {
    let captured: URL | null = null;
    global.fetch = routeFetch({
      issues: (url) => {
        captured = url;
        return { status: 200, body: [] };
      },
    }) as unknown as typeof fetch;

    await sentryAdapter.query(WS, q({ query: 'say "hi"' }), TOKEN);
    expect(captured!.searchParams.get("query")).toBe('"say \\"hi\\""');
  });

  it("leaves an embedded backslash in q.query UNTOUCHED — never doubled (Fix Round 1 CODA: Sentry's unescape has no \\\\-to-\\ production, so doubling would corrupt real paths/messages after the server unescapes)", async () => {
    let captured: URL | null = null;
    global.fetch = routeFetch({
      issues: (url) => {
        captured = url;
        return { status: 200, body: [] };
      },
    }) as unknown as typeof fetch;

    await sentryAdapter.query(WS, q({ query: "C:\\path\\to\\file" }), TOKEN);
    // Only quote-wrapped — no backslash escaping at all.
    expect(captured!.searchParams.get("query")).toBe('"C:\\path\\to\\file"');
  });

  it("sends an explicit empty query string when q.query is absent (never omitted — overrides Sentry's own is:unresolved default; NOT quoted — there is no free text to quote)", async () => {
    let captured: URL | null = null;
    global.fetch = routeFetch({
      issues: (url) => {
        captured = url;
        return { status: 200, body: [] };
      },
    }) as unknown as typeof fetch;

    await sentryAdapter.query(WS, q(), TOKEN);
    expect(captured!.searchParams.get("query")).toBe("");
  });

  it("filters by title, case-insensitive substring, client-side", async () => {
    global.fetch = routeFetch({
      issues: () => ({
        status: 200,
        body: [
          issueEntry({ shortId: "t1", title: "checkout flow crashed" }),
          issueEntry({ shortId: "t2", title: "billing sync failed" }),
        ],
      }),
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, q({ query: "CHECKOUT" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
    expect(res.raw).toContain("t1");
  });

  it("does NOT match on the issue id or the iso timestamp text — title only", async () => {
    global.fetch = routeFetch({
      issues: () => ({
        status: 200,
        body: [issueEntry({ shortId: "special-id-999", title: "ordinary error" })],
      }),
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, q({ query: "special-id-999" }), TOKEN);
    expect(res).toEqual({ ok: true, raw: "(no matching events)" });
  });

  it("renders the empty marker when the client-side re-filter matches nothing, even though the (mocked) server 'returned' something", async () => {
    global.fetch = routeFetch({
      issues: () => ({ status: 200, body: [issueEntry({ title: "ordinary error" })] }),
    }) as unknown as typeof fetch;
    const res = await sentryAdapter.query(WS, q({ query: "nonexistent-term" }), TOKEN);
    expect(res).toEqual({ ok: true, raw: "(no matching events)" });
  });
});

/**
 * Fix Round 1 CODA (confirm-pass regression): the FOLD 1 review round only
 * asserted quoteSearchText's OWN output shape (`.toBe('"...quoted..."')`)
 * — it never decoded that output back through Sentry's own grammar, so a
 * wrong escaping algorithm (backslash-doubling, which Sentry's grammar
 * does not define) passed the first review round anyway, because a
 * doubled-backslash STRING is still a well-formed-LOOKING quoted value —
 * it just silently means something different once the server unescapes
 * it. This describe block pins the SEMANTICS instead: a small
 * `simulateSentryUnescape` mirrors what Sentry's own parser does to a
 * matched `quoted_value` (confirmed grammar, `src/sentry/api/
 * event_search.py`: strip every `\"` pair back to a literal `"`; nothing
 * else has any special meaning — a bare backslash passes through
 * untouched) and asserts `quoteSearchText`'s wire output, run back through
 * THAT decoder, recovers the exact original text — for every category the
 * coordinator named: colon text, embedded quotes, a backslash path, and a
 * mixed case.
 */
describe("sentryAdapter — search_events: quoteSearchText round-trips through Sentry's OWN documented unescape (Fix Round 1 CODA)", () => {
  /** Mirrors Sentry's own confirmed unescape rule exactly — strips every
   * `\"` pair back to `"`, globally (a quoted_value's grammar repeats the
   * escape unit zero-or-more times, so more than one embedded quote needs
   * a global replace — the coordinator's own single-replace illustration
   * would silently under-test any input with more than one). Takes the
   * WIRE value with its outer wrapping quotes still attached (exactly
   * what the `query` search param actually contains) and strips those
   * outer delimiters the same way the grammar's own `'"' ... '"'` rule
   * does — they are never part of the decoded value itself. */
  function simulateSentryUnescape(wireValue: string): string {
    const inner = wireValue.slice(1, -1);
    return inner.replace(/\\"/g, '"');
  }

  async function wireQueryFor(query: string): Promise<string> {
    let captured: URL | null = null;
    global.fetch = routeFetch({
      issues: (url) => {
        captured = url;
        return { status: 200, body: [] };
      },
    }) as unknown as typeof fetch;
    await sentryAdapter.query(WS, q({ query }), TOKEN);
    return captured!.searchParams.get("query")!;
  }

  it.each([
    ["colon text", "TypeError: x is undefined"],
    ["embedded quotes", 'say "hi"'],
    ["backslash path", "C:\\path\\to\\file"],
    ["mixed backslash + quote", 'C:\\path\\to "file.txt"'],
  ])("round-trips %s unchanged: original → quoteSearchText → wire → simulateSentryUnescape → original", async (_label, original) => {
    const wire = await wireQueryFor(original);
    expect(simulateSentryUnescape(wire)).toBe(original);
  });
});

describe("sentryAdapter — search_events: request hygiene", () => {
  it("GETs the issues endpoint with Bearer auth, User-Agent, an AbortSignal, and the confirmed query params", async () => {
    const fetchMock = routeFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await sentryAdapter.query(WS, q(), TOKEN);

    expect(fetchMock.mock.calls.length).toBe(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    const parsed = new URL(url as string);
    expect(parsed.origin + parsed.pathname).toBe(`https://sentry.io/api/0/organizations/${ORG}/issues/`);
    expect(parsed.searchParams.get("project")).toBe(PROJECT);
    expect(parsed.searchParams.get("start")).toBe(WINDOW_START);
    expect(parsed.searchParams.get("end")).toBe(WINDOW_END);
    expect(parsed.searchParams.get("sort")).toBe("date");
    expect(parsed.searchParams.get("limit")).toBe("100");
    // No statsPeriod sent — confirmed Sentry behavior means an explicit
    // start/end pair is only honored when statsPeriod is entirely absent.
    expect(parsed.searchParams.has("statsPeriod")).toBe(false);
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      "User-Agent": "agentrail-console",
    });
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("never requests a second page — single page per endpoint (this task's own pinned rate-limit discipline)", async () => {
    const fetchMock = routeFetch({ issues: () => ({ status: 200, body: [issueEntry()] }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    await sentryAdapter.query(WS, q(), TOKEN);
    expect(fetchMock.mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// signals
// ---------------------------------------------------------------------------

function signalsQuery(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return q({ verb: "signals", ...overrides });
}

describe("sentryAdapter — signals: happy path rendering", () => {
  it("renders all three fixed metrics: count, errors (labeled), p95 duration", async () => {
    global.fetch = routeFetch({
      stats: (url) => {
        const kind = metricKind(url);
        if (kind === "count") return { status: 200, body: { data: [statsPoint(42, WINDOW_START_SEC)] } };
        if (kind === "errors") return { status: 200, body: { data: [statsPoint(3, WINDOW_START_SEC)] } };
        return { status: 200, body: { data: [[WINDOW_START_SEC, [{ "p95(transaction.duration)": 128.5 }]]] } };
      },
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, signalsQuery(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n").sort();
    expect(lines).toEqual(
      [
        "signal sentry.events.count window_agg=count value=42 at=2026-07-29T00:00:00.000Z",
        'signal sentry.events.count{level="error"} window_agg=count value=3 at=2026-07-29T00:00:00.000Z',
        "signal sentry.events.p95_duration window_agg=p95 value=128.5 at=2026-07-29T00:00:00.000Z",
      ].sort()
    );
  });

  it("sends the confirmed events/stats params: yAxis, start/end, interval sized to the window, project:<slug> embedded in query (not the dedicated project param) — and omits statsPeriod", async () => {
    const captured: URL[] = [];
    global.fetch = routeFetch({
      stats: (url) => {
        captured.push(url);
        return { status: 200, body: { data: [] } };
      },
    }) as unknown as typeof fetch;

    await sentryAdapter.query(WS, signalsQuery(), TOKEN);

    expect(captured).toHaveLength(3);
    for (const url of captured) {
      expect(url.searchParams.get("query")).toContain(`project:${PROJECT}`);
      expect(url.searchParams.has("project")).toBe(false);
      expect(url.searchParams.get("start")).toBe(WINDOW_START);
      expect(url.searchParams.get("end")).toBe(WINDOW_END);
      expect(url.searchParams.has("statsPeriod")).toBe(false);
      // The window is 24h - 1s; interval is sized to cover it in one bucket.
      expect(url.searchParams.get("interval")).toMatch(/^\d+m$/);
    }
    const errorsUrl = captured.find((u) => (u.searchParams.get("query") ?? "").includes("level:error"))!;
    expect(errorsUrl.searchParams.get("query")).toBe(`project:${PROJECT} level:error`);
  });

  it("renders one line PER DATA POINT when a metric query returns multiple buckets, each stamped with its own timestamp", async () => {
    global.fetch = routeFetch({
      stats: (url) => {
        if (metricKind(url) !== "count") return { status: 200, body: { data: [] } };
        return {
          status: 200,
          body: { data: [statsPoint(10, WINDOW_START_SEC), statsPoint(15, WINDOW_START_PLUS_12H_SEC)] },
        };
      },
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, signalsQuery(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("value=10 at=2026-07-29T00:00:00.000Z");
    expect(res.raw).toContain("value=15 at=2026-07-29T12:00:00.000Z");
  });

  it("skips a data point whose value is null — Sentry's own 'no data' signal, never rendered as a fabricated value", async () => {
    global.fetch = routeFetch({
      stats: (url) => {
        if (metricKind(url) !== "count") return { status: 200, body: { data: [] } };
        return { status: 200, body: { data: [statsPoint(null, WINDOW_START_SEC)] } };
      },
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, signalsQuery(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).not.toContain("sentry.events.count value=");
  });

  it("reads the value regardless of the inner object's key name (VALUE KEY — deliberately name-agnostic)", async () => {
    global.fetch = routeFetch({
      stats: (url) => {
        if (metricKind(url) !== "p95_duration") return { status: 200, body: { data: [] } };
        return { status: 200, body: { data: [[WINDOW_START_SEC, [{ "some-unexpected-key": 99 }]]] } };
      },
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, signalsQuery(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("sentry.events.p95_duration window_agg=p95 value=99");
  });
});

describe("sentryAdapter — signals: belt-and-braces window re-filter on each point's own timestamp", () => {
  it("drops a point whose timestamp falls after windowEnd", async () => {
    global.fetch = routeFetch({
      stats: (url) => {
        if (metricKind(url) !== "count") return { status: 200, body: { data: [] } };
        return {
          status: 200,
          body: {
            data: [statsPoint(10, Math.floor(new Date(WINDOW_START).getTime() / 1000) + 3600), statsPoint(999, Math.floor(new Date("2026-08-01T00:00:00.000Z").getTime() / 1000))],
          },
        };
      },
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, signalsQuery(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("value=10");
    expect(res.raw).not.toContain("value=999");
  });

  it("drops a point whose timestamp falls before windowStart too (inclusive-bounds re-filter, not just an upper check)", async () => {
    global.fetch = routeFetch({
      stats: (url) => {
        if (metricKind(url) !== "count") return { status: 200, body: { data: [] } };
        return {
          status: 200,
          body: {
            data: [
              statsPoint(888, Math.floor(new Date("2026-07-20T00:00:00.000Z").getTime() / 1000)),
              statsPoint(5, Math.floor(new Date(WINDOW_START).getTime() / 1000) + 3600),
            ],
          },
        };
      },
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, signalsQuery(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("value=5");
    expect(res.raw).not.toContain("value=888");
  });

  it("keeps a point whose timestamp is exactly at the window bounds (inclusive)", async () => {
    const startSec = Math.floor(new Date(WINDOW_START).getTime() / 1000);
    const endSec = Math.floor(new Date(WINDOW_END).getTime() / 1000);
    global.fetch = routeFetch({
      stats: (url) => {
        if (metricKind(url) !== "count") return { status: 200, body: { data: [] } };
        return { status: 200, body: { data: [statsPoint(1, startSec), statsPoint(2, endSec)] } };
      },
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, signalsQuery(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain(`value=1 at=${new Date(startSec * 1000).toISOString()}`);
    expect(res.raw).toContain(`value=2 at=${new Date(endSec * 1000).toISOString()}`);
  });
});

describe("sentryAdapter — signals: honest empty marker + limit cap", () => {
  it("renders '(no matching signals)' when every metric returns zero usable points", async () => {
    global.fetch = routeFetch({ stats: () => ({ status: 200, body: { data: [] } }) }) as unknown as typeof fetch;
    const res = await sentryAdapter.query(WS, signalsQuery(), TOKEN);
    expect(res).toEqual({ ok: true, raw: "(no matching signals)" });
  });

  it("caps total lines at limit (default 50) across all three metrics combined", async () => {
    global.fetch = routeFetch({
      stats: (url) => {
        const kind = metricKind(url);
        const points = Array.from({ length: 30 }, (_, i) =>
          statsPoint(i, Math.floor(new Date(WINDOW_START).getTime() / 1000) + i, kind === "p95_duration" ? "p95(transaction.duration)" : "count")
        );
        return { status: 200, body: { data: points } };
      },
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, signalsQuery(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(50);
  });

  it("clamps limit:0 to at least one line", async () => {
    global.fetch = routeFetch({
      stats: (url) => {
        if (metricKind(url) !== "count") return { status: 200, body: { data: [] } };
        return { status: 200, body: { data: [statsPoint(1, Math.floor(new Date(WINDOW_START).getTime() / 1000))] } };
      },
    }) as unknown as typeof fetch;
    const res = await sentryAdapter.query(WS, signalsQuery({ limit: 0 }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
  });
});

describe("sentryAdapter — signals: q.query matches the signal's name+labels identifier, not the whole line", () => {
  it('matches the error-labeled signal by its {level="error"} label text', async () => {
    global.fetch = routeFetch({
      stats: (url) => {
        const kind = metricKind(url);
        const ts = Math.floor(new Date(WINDOW_START).getTime() / 1000);
        if (kind === "count") return { status: 200, body: { data: [statsPoint(42, ts)] } };
        if (kind === "errors") return { status: 200, body: { data: [statsPoint(3, ts)] } };
        return { status: 200, body: { data: [[ts, [{ "p95(transaction.duration)": 1.5 }]]] } };
      },
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, signalsQuery({ query: "error" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
    expect(res.raw).toContain('level="error"');
  });

  it("does not match on the numeric value text", async () => {
    global.fetch = routeFetch({
      stats: (url) => {
        if (metricKind(url) !== "count") return { status: 200, body: { data: [] } };
        return { status: 200, body: { data: [statsPoint(4242, Math.floor(new Date(WINDOW_START).getTime() / 1000))] } };
      },
    }) as unknown as typeof fetch;
    const res = await sentryAdapter.query(WS, signalsQuery({ query: "4242" }), TOKEN);
    expect(res).toEqual({ ok: true, raw: "(no matching signals)" });
  });
});

describe("sentryAdapter — signals: per-metric failure isolation", () => {
  it("one metric's fetch 500s: a cap-exempt marker, rendered first; the other two metrics' lines still render, ok:true", async () => {
    global.fetch = routeFetch({
      stats: (url) => {
        const kind = metricKind(url);
        const ts = Math.floor(new Date(WINDOW_START).getTime() / 1000);
        if (kind === "count") return { status: 500, body: {} };
        if (kind === "errors") return { status: 200, body: { data: [statsPoint(1, ts)] } };
        return { status: 200, body: { data: [[ts, [{ "p95(transaction.duration)": 0.5 }]]] } };
      },
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, signalsQuery(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toBe("(signal count: sentry upstream_error)");
    expect(res.raw).toContain('sentry.events.count{level="error"}');
    expect(res.raw).toContain("sentry.events.p95_duration");
  });

  it("a thrown fetch for one metric renders '(signal {key}: sentry unreachable)' when its siblings succeed", async () => {
    global.fetch = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (!parsed.pathname.endsWith("/events/stats/")) throw new Error("unexpected URL");
      if (metricKind(parsed) === "p95_duration") throw new Error("network down");
      return httpResponse(200, { data: [statsPoint(1, Math.floor(new Date(WINDOW_START).getTime() / 1000))] });
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, signalsQuery(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("(signal p95_duration: sentry unreachable)");
  });

  it("degrades to upstream_error when every metric's fetch fails", async () => {
    global.fetch = routeFetch({ stats: () => ({ status: 503, body: {} }) }) as unknown as typeof fetch;
    const res = await sentryAdapter.query(WS, signalsQuery(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("markers are cap-exempt — survive alongside a busy sibling metric's capped real lines", async () => {
    global.fetch = routeFetch({
      stats: (url) => {
        const kind = metricKind(url);
        if (kind === "count") return { status: 401, body: {} };
        const points = Array.from({ length: 5 }, (_, i) =>
          statsPoint(i, Math.floor(new Date(WINDOW_START).getTime() / 1000) + i, kind === "p95_duration" ? "p95(transaction.duration)" : "count")
        );
        return { status: 200, body: { data: points } };
      },
    }) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, signalsQuery({ limit: 2 }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toBe("(signal count: sentry unauthorized)");
    const realLines = lines.filter((l) => l.startsWith("signal "));
    expect(realLines).toHaveLength(2);
  });
});

describe("sentryAdapter — signals: request hygiene", () => {
  it("fires all three metric queries concurrently, each with Bearer auth, User-Agent, and an AbortSignal", async () => {
    const fetchMock = routeFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await sentryAdapter.query(WS, signalsQuery(), TOKEN);

    expect(fetchMock.mock.calls.length).toBe(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(new URL(url as string).pathname).toBe(`/api/0/organizations/${ORG}/events/stats/`);
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        "User-Agent": "agentrail-console",
      });
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix Round 1, FOLD 2 (coordinator review): catalog↔adapter↔verify
// config-key drift protection. Neither the adapter (this module) nor
// verify.ts's own verifySentry declares an exported, shared "these are the
// keys" spec the way langfuse.ts's LANGFUSE_SECRET_SPEC does (a single
// secret has no split shape to declare) — so a bare equality assertion
// against a HARDCODED ["sentryOrg","sentryProject"] literal here would only
// prove the CATALOG's own shape, never catch a rename that touched the
// catalog's extraConfigFields key but left sentry.ts's/verify.ts's own
// separately-hardcoded `row.config.sentryOrg` / `config?.sentryProject`
// reads un-synced. The two behavioral tests below close that gap WITHOUT
// any production-code change: each builds its fixture's config object
// DYNAMICALLY off the catalog's OWN declared keys (never off this test
// file's own hardcoded ORG/PROJECT-keyed literals used everywhere else in
// this file) — if a future rename changes what the catalog declares
// without updating the adapter/verify's own reads, the dynamically-keyed
// fixture would use the NEW name, the unchanged runtime code would look
// for the OLD name, and the assertion below (which expects success) would
// fail in CI, exactly the protection the coordinator asked for.
// ---------------------------------------------------------------------------
describe("sentryAdapter — catalog↔adapter↔verify config-key alignment (Fix Round 1, FOLD 2)", () => {
  const sentryEntry = CONNECTOR_CATALOG.find((c) => c.kind === "sentry")!;
  const catalogFields = sentryEntry.connect!.extraConfigFields!;

  it("the catalog declares exactly ['sentryOrg','sentryProject'], both required:true — the literal keys sentry.ts's query() and verify.ts's verifySentry both read", () => {
    expect(catalogFields.map((f) => f.key)).toEqual(["sentryOrg", "sentryProject"]);
    for (const field of catalogFields) {
      expect(field.required).toBe(true);
    }
  });

  it("the adapter reads config.org/config.project using EXACTLY the catalog's declared keys — a connector row built from those keys (not this test file's own hardcoded literals) reaches a real fetch rather than degrading config_missing", async () => {
    const [orgKey, projectKey] = catalogFields.map((f) => f.key);
    mockGetConnector.mockResolvedValue({
      provider: "sentry" as const,
      enabled: true,
      config: {
        repos: [],
        triggerLabel: "ready-for-agent",
        pollIntervalSeconds: 60,
        [orgKey]: ORG,
        [projectKey]: PROJECT,
      },
      hasSecret: true,
      updatedAt: null,
    } as never);
    global.fetch = routeFetch({}) as unknown as typeof fetch;

    const res = await sentryAdapter.query(WS, q(), TOKEN);
    // Reaching an actual (mocked) fetch response rather than degrading
    // config_missing proves the adapter successfully read org+project off
    // exactly these catalog-derived key names.
    expect(res).not.toEqual({ ok: false, reason: "config_missing" });
  });

  it("verifySentry reads config using EXACTLY the catalog's declared keys too — a config object built from those keys reaches Sentry's verify endpoint rather than failing closed with the org/project-missing errors", async () => {
    const [orgKey, projectKey] = catalogFields.map((f) => f.key);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("sentry", TOKEN, undefined, {
      [orgKey]: ORG,
      [projectKey]: PROJECT,
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(res).toEqual({ ok: true });
  });
});
