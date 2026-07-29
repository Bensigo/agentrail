import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors github.test.ts's mocking idiom (mock the package's named export
// directly) and its global.fetch idiom for the real HTTP calls.
vi.mock("@agentrail/db-postgres", () => ({
  getConnector: vi.fn(),
}));

import { getConnector } from "@agentrail/db-postgres";
import { railwayAdapter } from "./railway";
import { adapterFor } from "./registry";
import type { EvidenceQuery, EvidenceVerb } from "./types";

const mockGetConnector = vi.mocked(getConnector);

const WS = "00000000-0000-0000-0000-000000000001";
const TOKEN = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const PROJECT_ID = "proj-abc";
const WINDOW_START = "2026-07-29T00:00:00.000Z";
const WINDOW_END = "2026-07-29T23:59:59.000Z";

function q(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return {
    verb: "changes",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    ...overrides,
  };
}

// `null` means "omit railwayProjectId from config entirely" — NOT the same
// as an omitted argument: a default parameter also fires on an explicit
// `undefined`, so `undefined` can't be used as the "omit" sentinel here.
function connectorRow(railwayProjectId: string | null = PROJECT_ID) {
  return {
    provider: "railway" as const,
    enabled: true,
    config: {
      repos: [],
      triggerLabel: "ready-for-agent",
      pollIntervalSeconds: 60,
      ...(railwayProjectId !== null ? { railwayProjectId } : {}),
    },
    hasSecret: true,
    updatedAt: null,
  };
}

function deploymentNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "dep-1",
    status: "SUCCESS",
    createdAt: "2026-07-29T14:02:00.000Z",
    meta: { commitHash: "abc1234", commitMessage: "fix pool sizing" },
    ...overrides,
  };
}

function railwayHttpResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** Parses a captured fetch call's JSON body into { query, variables }. */
function parseBody(init: RequestInit | undefined): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
}

interface RouteHandlers {
  deployments?: (variables: Record<string, unknown>) => { status: number; body: unknown };
  deploymentLogs?: (deploymentId: string, variables: Record<string, unknown>) => { status: number; body: unknown };
}

/** Routes a fetch mock by inspecting the POSTed GraphQL query text — the
 * house pattern (github.test.ts's routeFetch) adapted for a single GraphQL
 * endpoint instead of per-repo REST paths. */
function routeFetch(handlers: RouteHandlers) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const { query, variables } = parseBody(init);
    if (query.includes("deploymentLogs")) {
      const deploymentId = String(variables.deploymentId);
      const h = handlers.deploymentLogs
        ? handlers.deploymentLogs(deploymentId, variables)
        : { status: 200, body: { data: { deploymentLogs: [] } } };
      return railwayHttpResponse(h.status, h.body);
    }
    if (query.includes("deployments")) {
      const h = handlers.deployments
        ? handlers.deployments(variables)
        : { status: 200, body: { data: { deployments: { edges: [] } } } };
      return railwayHttpResponse(h.status, h.body);
    }
    throw new Error(`unexpected GraphQL query: ${query}`);
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

describe("railwayAdapter — shape", () => {
  it("declares provider 'railway' and verbs [changes, search_events]", () => {
    expect(railwayAdapter.provider).toBe("railway");
    expect(railwayAdapter.verbs).toEqual(["changes", "search_events"]);
  });

  it("self-registers into the shared registry on module load", () => {
    expect(adapterFor("railway")).toBe(railwayAdapter);
  });
});

describe("railwayAdapter — bad_request validation", () => {
  it("degrades bad_request on an unparseable windowStart, without ever reading the connector row", async () => {
    const res = await railwayAdapter.query(WS, q({ windowStart: "not-a-date" }), TOKEN);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades bad_request on an unparseable windowEnd", async () => {
    const res = await railwayAdapter.query(WS, q({ windowEnd: "" }), TOKEN);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
  });

  it("degrades bad_request for a verb this adapter does not declare", async () => {
    const res = await railwayAdapter.query(WS, q({ verb: "signals" as EvidenceVerb }), TOKEN);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });
});

describe("railwayAdapter — config_missing", () => {
  it("degrades config_missing when secret is null, without ever reading the connector row", async () => {
    const res = await railwayAdapter.query(WS, q(), null);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades config_missing when there is no railway connector row at all", async () => {
    mockGetConnector.mockResolvedValue(null);
    const res = await railwayAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("degrades config_missing when the row exists but railwayProjectId is absent", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(null));
    const res = await railwayAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("reads the connector row for provider 'railway' specifically", async () => {
    global.fetch = routeFetch({}) as unknown as typeof fetch;
    await railwayAdapter.query(WS, q(), TOKEN);
    expect(mockGetConnector).toHaveBeenCalledWith(WS, "railway");
  });
});

describe("railwayAdapter — changes: happy path rendering", () => {
  it("renders a single deployment: id, status, iso timestamp, commit sha from meta.commitHash, env=-", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: { data: { deployments: { edges: [{ node: deploymentNode() }] } } },
      }),
    }) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({
      ok: true,
      raw: "deployment dep-1 status=SUCCESS at=2026-07-29T14:02:00.000Z commit=abc1234 env=-",
    });
  });

  it("falls back to commit=- when meta has no commitHash", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: { data: { deployments: { edges: [{ node: deploymentNode({ meta: {} }) }] } } },
      }),
    }) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("commit=-");
  });

  it("falls back to commit=- when meta is null", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: { data: { deployments: { edges: [{ node: deploymentNode({ meta: null }) }] } } },
      }),
    }) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("commit=-");
  });

  it("renders multiple deployments most-recent-first", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: {
          data: {
            deployments: {
              edges: [
                { node: deploymentNode({ id: "dep-old", createdAt: "2026-07-29T10:00:00.000Z" }) },
                { node: deploymentNode({ id: "dep-new", createdAt: "2026-07-29T18:00:00.000Z" }) },
              ],
            },
          },
        },
      }),
    }) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toContain("dep-new");
    expect(lines[1]).toContain("dep-old");
  });

  it("does not trust server edge ordering — sorts descending even when the server returns oldest-first", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: {
          data: {
            deployments: {
              edges: [
                { node: deploymentNode({ id: "dep-a", createdAt: "2026-07-29T09:00:00.000Z" }) },
                { node: deploymentNode({ id: "dep-b", createdAt: "2026-07-29T20:00:00.000Z" }) },
                { node: deploymentNode({ id: "dep-c", createdAt: "2026-07-29T12:00:00.000Z" }) },
              ],
            },
          },
        },
      }),
    }) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const ids = res.raw.split("\n").map((l) => l.split(" ")[1]);
    expect(ids).toEqual(["dep-b", "dep-c", "dep-a"]);
  });
});

describe("railwayAdapter — changes: window filtering", () => {
  it("excludes deployments outside [windowStart, windowEnd], keeping inclusive bounds", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: {
          data: {
            deployments: {
              edges: [
                { node: deploymentNode({ id: "before", createdAt: "2026-07-28T23:00:00.000Z" }) },
                { node: deploymentNode({ id: "after", createdAt: "2026-07-30T00:00:01.000Z" }) },
                { node: deploymentNode({ id: "at-start", createdAt: WINDOW_START }) },
                { node: deploymentNode({ id: "at-end", createdAt: WINDOW_END }) },
              ],
            },
          },
        },
      }),
    }) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("at-start");
    expect(res.raw).toContain("at-end");
    expect(res.raw).not.toContain("before");
    expect(res.raw).not.toContain("after");
  });

  it("skips a node with an unparseable/missing createdAt rather than throwing", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: {
          data: {
            deployments: {
              edges: [
                { node: deploymentNode({ id: "bad", createdAt: "not-a-date" }) },
                { node: deploymentNode({ id: "good" }) },
              ],
            },
          },
        },
      }),
    }) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("good");
    expect(res.raw).not.toContain("bad ");
  });
});

describe("railwayAdapter — changes: honest empty marker + limit cap", () => {
  it("renders '(no deployments in window)' when nothing is in window", async () => {
    global.fetch = routeFetch({
      deployments: () => ({ status: 200, body: { data: { deployments: { edges: [] } } } }),
    }) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: true, raw: "(no deployments in window)" });
  });

  it("caps total lines at limit (default 50)", async () => {
    const edges = Array.from({ length: 60 }, (_, i) => ({
      node: deploymentNode({
        id: `dep-${i}`,
        createdAt: new Date(new Date(WINDOW_START).getTime() + i * 1000).toISOString(),
      }),
    }));
    global.fetch = routeFetch({
      deployments: () => ({ status: 200, body: { data: { deployments: { edges } } } }),
    }) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(50);
  });

  it("respects an explicit smaller limit", async () => {
    const edges = Array.from({ length: 10 }, (_, i) => ({
      node: deploymentNode({
        id: `dep-${i}`,
        createdAt: new Date(new Date(WINDOW_START).getTime() + i * 1000).toISOString(),
      }),
    }));
    global.fetch = routeFetch({
      deployments: () => ({ status: 200, body: { data: { deployments: { edges } } } }),
    }) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q({ limit: 3 }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(3);
  });

  it("clamps limit:0 to at least one line rather than a bare empty string", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: { data: { deployments: { edges: [{ node: deploymentNode() }] } } },
      }),
    }) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q({ limit: 0 }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).not.toBe("");
    expect(res.raw.split("\n")).toHaveLength(1);
  });
});

describe("railwayAdapter — changes: upstream failure taxonomy", () => {
  it("degrades unauthorized on HTTP 401", async () => {
    global.fetch = routeFetch({
      deployments: () => ({ status: 401, body: {} }),
    }) as unknown as typeof fetch;
    const res = await railwayAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("degrades unauthorized on HTTP 403", async () => {
    global.fetch = routeFetch({
      deployments: () => ({ status: 403, body: {} }),
    }) as unknown as typeof fetch;
    const res = await railwayAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("degrades upstream_error on HTTP 500", async () => {
    global.fetch = routeFetch({
      deployments: () => ({ status: 500, body: {} }),
    }) as unknown as typeof fetch;
    const res = await railwayAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("degrades upstream_error on a 200 body carrying a GraphQL errors array", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: { errors: [{ message: "Project not found" }] },
      }),
    }) as unknown as typeof fetch;
    const res = await railwayAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("a thrown/aborted fetch propagates uncaught (the route's job to convert to unreachable — see this module's own doc-comment)", async () => {
    global.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(railwayAdapter.query(WS, q(), TOKEN)).rejects.toThrow("network down");
  });
});

describe("railwayAdapter — request hygiene", () => {
  it("POSTs to the Railway GraphQL endpoint with Bearer auth, JSON content-type, User-Agent, and an AbortSignal", async () => {
    const fetchMock = routeFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await railwayAdapter.query(WS, q(), TOKEN);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://backboard.railway.com/graphql/v2");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "agentrail-console",
    });
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("sends the connector row's railwayProjectId as DeploymentListInput.projectId", async () => {
    mockGetConnector.mockResolvedValue(connectorRow("a-specific-project"));
    const fetchMock = routeFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await railwayAdapter.query(WS, q(), TOKEN);

    const [, init] = fetchMock.mock.calls[0]!;
    const { variables } = parseBody(init as RequestInit);
    expect(variables.input).toEqual({ projectId: "a-specific-project" });
  });
});

describe("railwayAdapter — search_events: happy path, filtering, ordering", () => {
  function withOneDeploymentInWindow(logs: Array<Record<string, unknown>>) {
    return routeFetch({
      deployments: () => ({
        status: 200,
        body: { data: { deployments: { edges: [{ node: deploymentNode({ id: "dep-1" }) }] } } },
      }),
      deploymentLogs: () => ({ status: 200, body: { data: { deploymentLogs: logs } } }),
    });
  }

  it("renders log lines: deployment id, iso timestamp, severity, message", async () => {
    global.fetch = withOneDeploymentInWindow([
      { timestamp: "2026-07-29T14:05:00.000Z", severity: "error", message: "connection pool exhausted" },
    ]) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res).toEqual({
      ok: true,
      raw: "deployment_log deployment=dep-1 at=2026-07-29T14:05:00.000Z severity=error message=connection pool exhausted",
    });
  });

  it("falls back to severity=- when absent", async () => {
    global.fetch = withOneDeploymentInWindow([
      { timestamp: "2026-07-29T14:05:00.000Z", message: "hello" },
    ]) as unknown as typeof fetch;
    const res = await railwayAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("severity=-");
  });

  it("collapses embedded newlines in message so one record stays one line", async () => {
    global.fetch = withOneDeploymentInWindow([
      { timestamp: "2026-07-29T14:05:00.000Z", severity: "info", message: "line one\nline two" },
    ]) as unknown as typeof fetch;
    const res = await railwayAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
    expect(res.raw).toContain("line one line two");
  });

  it("filters by q.query, case-insensitive substring, against the SAME rendered text the caller receives", async () => {
    global.fetch = withOneDeploymentInWindow([
      { timestamp: "2026-07-29T14:00:00.000Z", severity: "info", message: "checkout succeeded" },
      { timestamp: "2026-07-29T14:01:00.000Z", severity: "error", message: "POOL EXHAUSTED for db" },
    ]) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q({ verb: "search_events", query: "pool exhausted" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
    expect(res.raw).toContain("POOL EXHAUSTED");
  });

  it("orders lines chronologically (ascending), not by deployment or arrival order", async () => {
    global.fetch = withOneDeploymentInWindow([
      { timestamp: "2026-07-29T14:05:00.000Z", severity: "info", message: "second" },
      { timestamp: "2026-07-29T14:00:00.000Z", severity: "info", message: "first" },
    ]) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("second");
  });

  it("renders '(no matching log lines)' when there are zero deployments in window", async () => {
    global.fetch = routeFetch({
      deployments: () => ({ status: 200, body: { data: { deployments: { edges: [] } } } }),
    }) as unknown as typeof fetch;
    const res = await railwayAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res).toEqual({ ok: true, raw: "(no matching log lines)" });
  });

  it("renders '(no matching log lines)' when deployments exist but zero log lines match q.query", async () => {
    global.fetch = withOneDeploymentInWindow([
      { timestamp: "2026-07-29T14:00:00.000Z", severity: "info", message: "checkout succeeded" },
    ]) as unknown as typeof fetch;
    const res = await railwayAdapter.query(WS, q({ verb: "search_events", query: "nonexistent-term" }), TOKEN);
    expect(res).toEqual({ ok: true, raw: "(no matching log lines)" });
  });

  it("caps total lines at limit (default 200), keeping the most recent", async () => {
    const logs = Array.from({ length: 250 }, (_, i) => ({
      timestamp: new Date(new Date(WINDOW_START).getTime() + i * 1000).toISOString(),
      severity: "info",
      message: `line-${i}`,
    }));
    global.fetch = withOneDeploymentInWindow(logs) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines).toHaveLength(200);
    // Most recent kept, chronological order preserved.
    expect(lines[0]).toContain("line-50");
    expect(lines[lines.length - 1]).toContain("line-249");
  });

  it("clamps limit:0 to at least one line", async () => {
    global.fetch = withOneDeploymentInWindow([
      { timestamp: "2026-07-29T14:00:00.000Z", severity: "info", message: "only" },
    ]) as unknown as typeof fetch;
    const res = await railwayAdapter.query(WS, q({ verb: "search_events", limit: 0 }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
  });
});

describe("railwayAdapter — search_events: per-deployment failure isolation", () => {
  it("a deployment whose log fetch 500s gets one cap-exempt marker; a sibling deployment's real lines still render, ok:true", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: {
          data: {
            deployments: {
              edges: [
                { node: deploymentNode({ id: "dep-broken" }) },
                { node: deploymentNode({ id: "dep-ok" }) },
              ],
            },
          },
        },
      }),
      deploymentLogs: (deploymentId) =>
        deploymentId === "dep-broken"
          ? { status: 500, body: {} }
          : {
              status: 200,
              body: {
                data: {
                  deploymentLogs: [
                    { timestamp: "2026-07-29T14:00:00.000Z", severity: "info", message: "ok line" },
                  ],
                },
              },
            },
    }) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("(deployment dep-broken: railway upstream_error)");
    expect(res.raw).toContain("ok line");
  });

  it("a thrown fetch for one deployment's logs renders '(deployment {id}: railway unreachable)' when a sibling succeeds", async () => {
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const { query, variables } = parseBody(init);
      if (query.includes("deployments") && !query.includes("deploymentLogs")) {
        return railwayHttpResponse(200, {
          data: {
            deployments: {
              edges: [
                { node: deploymentNode({ id: "dep-flaky" }) },
                { node: deploymentNode({ id: "dep-ok" }) },
              ],
            },
          },
        });
      }
      if (String(variables.deploymentId) === "dep-flaky") {
        throw new Error("network down");
      }
      return railwayHttpResponse(200, {
        data: {
          deploymentLogs: [{ timestamp: "2026-07-29T14:00:00.000Z", severity: "info", message: "ok line" }],
        },
      });
    }) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("(deployment dep-flaky: railway unreachable)");
    expect(res.raw).toContain("ok line");
  });

  it("markers are cap-exempt and rendered first, surviving alongside a busy sibling deployment's capped real lines", async () => {
    const manyLogs = Array.from({ length: 10 }, (_, i) => ({
      timestamp: new Date(new Date(WINDOW_START).getTime() + i * 1000).toISOString(),
      severity: "info",
      message: `line-${i}`,
    }));
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: {
          data: {
            deployments: {
              edges: [
                { node: deploymentNode({ id: "dep-broken" }) },
                { node: deploymentNode({ id: "dep-busy" }) },
              ],
            },
          },
        },
      }),
      deploymentLogs: (deploymentId) =>
        deploymentId === "dep-broken"
          ? { status: 401, body: {} }
          : { status: 200, body: { data: { deploymentLogs: manyLogs } } },
    }) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q({ verb: "search_events", limit: 3 }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toBe("(deployment dep-broken: railway unauthorized)");
    const realLines = lines.filter((l) => l.startsWith("deployment_log"));
    expect(realLines).toHaveLength(3);
  });

  it("degrades to upstream_error when every targeted deployment's log fetch fails", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: {
          data: {
            deployments: {
              edges: [
                { node: deploymentNode({ id: "dep-a" }) },
                { node: deploymentNode({ id: "dep-b" }) },
              ],
            },
          },
        },
      }),
      deploymentLogs: () => ({ status: 503, body: {} }),
    }) as unknown as typeof fetch;

    const res = await railwayAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("bounds the fan-out to SEARCH_EVENTS_MAX_DEPLOYMENTS (20), never querying logs for more than that many deployments", async () => {
    const edges = Array.from({ length: 30 }, (_, i) => ({
      node: deploymentNode({
        id: `dep-${i}`,
        createdAt: new Date(new Date(WINDOW_START).getTime() + i * 1000).toISOString(),
      }),
    }));
    const queriedDeploymentIds = new Set<string>();
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const { query, variables } = parseBody(init);
      if (query.includes("deploymentLogs")) {
        queriedDeploymentIds.add(String(variables.deploymentId));
        return railwayHttpResponse(200, { data: { deploymentLogs: [] } });
      }
      return railwayHttpResponse(200, { data: { deployments: { edges } } });
    }) as unknown as typeof fetch;

    await railwayAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(queriedDeploymentIds.size).toBe(20);
  });
});
