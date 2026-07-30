import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors railway.test.ts's/grafana.test.ts's mocking idiom (mock the
// package's named export directly) and its global.fetch idiom for the real
// HTTP calls.
vi.mock("@agentrail/db-postgres", () => ({
  getConnector: vi.fn(),
}));

import { getConnector } from "@agentrail/db-postgres";
import { vercelAdapter } from "./vercel";
import { adapterFor } from "./registry";
import type { EvidenceQuery, EvidenceVerb } from "./types";
// The ONLY place this test file imports the catalog and verify.ts — the
// adapter itself (vercel.ts) never does (leaf-independence precedent,
// established by every prior Wave-2 provider's own test file). Used by the
// drift-protection describe block near the bottom of this file.
import { CONNECTOR_CATALOG } from "../../app/(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers";
import { verifyConnectorCredential } from "../../app/api/v1/workspaces/[workspaceId]/connectors/secret/verify";

const mockGetConnector = vi.mocked(getConnector);

const WS = "00000000-0000-0000-0000-000000000001";
// FIXTURE, deliberately non-realistic — Vercel documents no fixed token
// shape (see vercel.ts's own doc-comment), so this is just a plausible-
// looking opaque string, not a real-token-shaped literal that could trip a
// secret scanner.
const TOKEN = "TESTFIXTURE_vercel_token_0000000000000000";
const PROJECT_ID = "prj_abc123";
const TEAM_ID = "team_abc123";
const WINDOW_START = "2026-07-29T00:00:00.000Z";
const WINDOW_END = "2026-07-29T23:59:59.000Z";
const WINDOW_START_MS = new Date(WINDOW_START).getTime();
const WINDOW_END_MS = new Date(WINDOW_END).getTime();

function q(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return {
    verb: "changes",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    ...overrides,
  };
}

// `null` means "omit the field from config entirely" — NOT the same as an
// omitted argument (a default parameter also fires on explicit `undefined`).
function connectorRow(vercelProjectId: string | null = PROJECT_ID, vercelTeamId: string | null = TEAM_ID) {
  return {
    provider: "vercel" as const,
    enabled: true,
    config: {
      repos: [],
      triggerLabel: "ready-for-agent",
      pollIntervalSeconds: 60,
      ...(vercelProjectId !== null ? { vercelProjectId } : {}),
      ...(vercelTeamId !== null ? { vercelTeamId } : {}),
    },
    hasSecret: true,
    updatedAt: null,
  };
}

function deploymentNode(overrides: Record<string, unknown> = {}) {
  return {
    uid: "dpl_1",
    readyState: "READY",
    createdAt: WINDOW_START_MS + 1000,
    meta: { commitSha: "abc1234567", commitMessage: "fix pool sizing" },
    ...overrides,
  };
}

function httpResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** Routes a fetch mock by inspecting the request URL's pathname — mirrors
 * grafana.test.ts's single-path router, extended to two paths (a plain REST
 * API, unlike railway's single GraphQL endpoint). */
interface RouteHandlers {
  deployments?: (url: URL) => { status: number; body: unknown };
  events?: (deploymentId: string, url: URL) => { status: number; body: unknown };
}
function routeFetch(handlers: RouteHandlers) {
  return vi.fn(async (rawUrl: string, _init?: RequestInit) => {
    void _init;
    const url = new URL(rawUrl);
    if (url.pathname === "/v7/deployments") {
      const h = handlers.deployments
        ? handlers.deployments(url)
        : { status: 200, body: { deployments: [] } };
      return httpResponse(h.status, h.body);
    }
    const eventsMatch = url.pathname.match(/^\/v3\/deployments\/([^/]+)\/events$/);
    if (eventsMatch) {
      const h = handlers.events
        ? handlers.events(eventsMatch[1], url)
        : { status: 200, body: [] };
      return httpResponse(h.status, h.body);
    }
    throw new Error(`unexpected URL: ${rawUrl}`);
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

describe("vercelAdapter — shape", () => {
  it("declares provider 'vercel' and verbs [changes, search_events]", () => {
    expect(vercelAdapter.provider).toBe("vercel");
    expect(vercelAdapter.verbs).toEqual(["changes", "search_events"]);
  });

  it("self-registers into the shared registry on module load", () => {
    expect(adapterFor("vercel")).toBe(vercelAdapter);
  });
});

describe("vercelAdapter — bad_request validation", () => {
  it("degrades bad_request on an unparseable windowStart, without ever reading the connector row", async () => {
    const res = await vercelAdapter.query(WS, q({ windowStart: "not-a-date" }), TOKEN);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades bad_request on an unparseable windowEnd", async () => {
    const res = await vercelAdapter.query(WS, q({ windowEnd: "" }), TOKEN);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
  });

  it("degrades bad_request for a verb this adapter does not declare", async () => {
    const res = await vercelAdapter.query(WS, q({ verb: "signals" as EvidenceVerb }), TOKEN);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });
});

describe("vercelAdapter — config_missing", () => {
  it("degrades config_missing when secret is null, without ever reading the connector row", async () => {
    const res = await vercelAdapter.query(WS, q(), null);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("degrades config_missing when there is no vercel connector row at all", async () => {
    mockGetConnector.mockResolvedValue(null);
    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("degrades config_missing when the row exists but vercelProjectId is absent", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(null));
    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("does NOT degrade when vercelTeamId is absent — teamId is optional (personal scope)", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(PROJECT_ID, null));
    global.fetch = routeFetch({}) as unknown as typeof fetch;
    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res).not.toEqual({ ok: false, reason: "config_missing" });
  });

  it("reads the connector row for provider 'vercel' specifically", async () => {
    global.fetch = routeFetch({}) as unknown as typeof fetch;
    await vercelAdapter.query(WS, q(), TOKEN);
    expect(mockGetConnector).toHaveBeenCalledWith(WS, "vercel");
  });
});

describe("vercelAdapter — changes: happy path rendering", () => {
  it("renders a single deployment: uid, state from readyState, iso timestamp, commit sha7, quoted message-80", async () => {
    global.fetch = routeFetch({
      deployments: () => ({ status: 200, body: { deployments: [deploymentNode()] } }),
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({
      ok: true,
      raw: `deployment dpl_1 state=READY at=${new Date(WINDOW_START_MS + 1000).toISOString()} commit=abc1234 "fix pool sizing"`,
    });
  });

  it("truncates the commit sha to 7 characters", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: { deployments: [deploymentNode({ meta: { commitSha: "abcdef0123456789" } })] },
      }),
    }) as unknown as typeof fetch;
    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("commit=abcdef0 ");
  });

  it("truncates a long commit message to 80 characters and collapses embedded newlines", async () => {
    const longMessage = "a".repeat(90) + "\nsecond line";
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: { deployments: [deploymentNode({ meta: { commitSha: "abc1234", commitMessage: longMessage } })] },
      }),
    }) as unknown as typeof fetch;
    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const quoted = res.raw.match(/"([^"]*)"/)![1];
    expect(quoted.length).toBeLessThanOrEqual(80);
    expect(quoted).not.toContain("\n");
  });

  it("falls back to state=- and commit=-/message=- when readyState/state/meta are all absent", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: {
          deployments: [
            { uid: "dpl_bare", createdAt: WINDOW_START_MS + 1000 },
          ],
        },
      }),
    }) as unknown as typeof fetch;
    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("state=-");
    expect(res.raw).toContain('commit=- "-"');
  });

  it("falls back to the legacy state field when readyState is absent", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: {
          deployments: [deploymentNode({ readyState: undefined, state: "ERROR" })],
        },
      }),
    }) as unknown as typeof fetch;
    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("state=ERROR");
  });

  it("falls back to the legacy created field when createdAt is absent", async () => {
    const createdMs = WINDOW_START_MS + 2000;
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: {
          deployments: [deploymentNode({ createdAt: undefined, created: createdMs })],
        },
      }),
    }) as unknown as typeof fetch;
    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain(`at=${new Date(createdMs).toISOString()}`);
  });

  it("reads bare meta.commitSha/commitMessage in preference to provider-prefixed keys when both are present", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: {
          deployments: [
            deploymentNode({
              meta: {
                commitSha: "bare0001",
                commitMessage: "bare message",
                githubCommitSha: "gh00001",
                githubCommitMessage: "github message",
              },
            }),
          ],
        },
      }),
    }) as unknown as typeof fetch;
    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("commit=bare000");
    expect(res.raw).toContain('"bare message"');
  });

  it("falls back to githubCommitSha/githubCommitMessage when the bare keys are absent", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: {
          deployments: [
            deploymentNode({ meta: { githubCommitSha: "gh12345", githubCommitMessage: "github msg" } }),
          ],
        },
      }),
    }) as unknown as typeof fetch;
    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("commit=gh12345");
    expect(res.raw).toContain('"github msg"');
  });

  it("falls back to commit=- when meta is null", async () => {
    global.fetch = routeFetch({
      deployments: () => ({ status: 200, body: { deployments: [deploymentNode({ meta: null })] } }),
    }) as unknown as typeof fetch;
    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain('commit=- "-"');
  });

  it("renders multiple deployments most-recent-first", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: {
          deployments: [
            deploymentNode({ uid: "dpl-old", createdAt: WINDOW_START_MS + 1000 }),
            deploymentNode({ uid: "dpl-new", createdAt: WINDOW_START_MS + 5000 }),
          ],
        },
      }),
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toContain("dpl-new");
    expect(lines[1]).toContain("dpl-old");
  });

  it("does not trust server list ordering — sorts descending even when the server returns oldest-first", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: {
          deployments: [
            deploymentNode({ uid: "dpl-a", createdAt: WINDOW_START_MS + 1000 }),
            deploymentNode({ uid: "dpl-b", createdAt: WINDOW_START_MS + 9000 }),
            deploymentNode({ uid: "dpl-c", createdAt: WINDOW_START_MS + 5000 }),
          ],
        },
      }),
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const ids = res.raw.split("\n").map((l) => l.split(" ")[1]);
    expect(ids).toEqual(["dpl-b", "dpl-c", "dpl-a"]);
  });
});

describe("vercelAdapter — changes: window filtering", () => {
  it("excludes deployments outside [windowStart, windowEnd], keeping inclusive bounds", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: {
          deployments: [
            deploymentNode({ uid: "before", createdAt: WINDOW_START_MS - 1000 }),
            deploymentNode({ uid: "after", createdAt: WINDOW_END_MS + 1000 }),
            deploymentNode({ uid: "at-start", createdAt: WINDOW_START_MS }),
            deploymentNode({ uid: "at-end", createdAt: WINDOW_END_MS }),
          ],
        },
      }),
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("at-start");
    expect(res.raw).toContain("at-end");
    expect(res.raw).not.toContain("before");
    expect(res.raw).not.toContain("after");
  });

  it("skips a node with an unparseable/missing uid or createdAt rather than throwing", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: {
          deployments: [
            deploymentNode({ uid: "bad", createdAt: "not-a-number" }),
            { readyState: "READY", createdAt: WINDOW_START_MS + 1000 }, // no uid
            deploymentNode({ uid: "good" }),
          ],
        },
      }),
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("good");
    expect(res.raw.split("\n")).toHaveLength(1);
  });
});

describe("vercelAdapter — changes: honest empty marker + limit cap", () => {
  it("renders '(no deployments in window)' when nothing is in window", async () => {
    global.fetch = routeFetch({
      deployments: () => ({ status: 200, body: { deployments: [] } }),
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: true, raw: "(no deployments in window)" });
  });

  it("treats a malformed 200 body (no deployments array) as zero elements, not an error", async () => {
    global.fetch = routeFetch({
      deployments: () => ({ status: 200, body: { unexpected: true } }),
    }) as unknown as typeof fetch;
    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: true, raw: "(no deployments in window)" });
  });

  it("caps total lines at limit (default 50)", async () => {
    const deployments = Array.from({ length: 60 }, (_, i) =>
      deploymentNode({ uid: `dpl-${i}`, createdAt: WINDOW_START_MS + i * 1000 })
    );
    global.fetch = routeFetch({
      deployments: () => ({ status: 200, body: { deployments } }),
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(50);
  });

  it("respects an explicit smaller limit", async () => {
    const deployments = Array.from({ length: 10 }, (_, i) =>
      deploymentNode({ uid: `dpl-${i}`, createdAt: WINDOW_START_MS + i * 1000 })
    );
    global.fetch = routeFetch({
      deployments: () => ({ status: 200, body: { deployments } }),
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ limit: 3 }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(3);
  });

  it("clamps limit:0 to at least one line rather than a bare empty string", async () => {
    global.fetch = routeFetch({
      deployments: () => ({ status: 200, body: { deployments: [deploymentNode()] } }),
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ limit: 0 }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).not.toBe("");
    expect(res.raw.split("\n")).toHaveLength(1);
  });
});

describe("vercelAdapter — changes: upstream failure taxonomy", () => {
  it("degrades unauthorized on HTTP 401", async () => {
    global.fetch = routeFetch({ deployments: () => ({ status: 401, body: {} }) }) as unknown as typeof fetch;
    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("degrades unauthorized on HTTP 403", async () => {
    global.fetch = routeFetch({ deployments: () => ({ status: 403, body: {} }) }) as unknown as typeof fetch;
    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("degrades upstream_error on HTTP 500", async () => {
    global.fetch = routeFetch({ deployments: () => ({ status: 500, body: {} }) }) as unknown as typeof fetch;
    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("degrades upstream_error on HTTP 400 (invalid query value)", async () => {
    global.fetch = routeFetch({ deployments: () => ({ status: 400, body: {} }) }) as unknown as typeof fetch;
    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("ADJUDICATION (pinned): a 404 on the deployments-list call degrades to config_missing, not upstream_error — a stale/wrong vercelProjectId is an operator configuration mistake, not a rejected credential", async () => {
    global.fetch = routeFetch({ deployments: () => ({ status: 404, body: {} }) }) as unknown as typeof fetch;
    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("the same 404-as-config_missing adjudication applies to search_events too (same shared deployments-list call)", async () => {
    global.fetch = routeFetch({ deployments: () => ({ status: 404, body: {} }) }) as unknown as typeof fetch;
    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("a thrown/aborted fetch propagates uncaught (the route's job to convert to unreachable — see this module's own doc-comment)", async () => {
    global.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(vercelAdapter.query(WS, q(), TOKEN)).rejects.toThrow("network down");
  });
});

describe("vercelAdapter — changes: request hygiene + team scoping", () => {
  it("GETs /v7/deployments with Bearer auth, Accept, User-Agent, and an AbortSignal", async () => {
    const fetchMock = routeFetch({});
    global.fetch = fetchMock as unknown as typeof fetch;

    await vercelAdapter.query(WS, q(), TOKEN);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(url as string).pathname).toBe("/v7/deployments");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
      "User-Agent": "agentrail-console",
    });
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("sends projectId and until (windowEnd, epoch ms) as query params", async () => {
    let captured: URL | null = null;
    global.fetch = routeFetch({
      deployments: (url) => {
        captured = url;
        return { status: 200, body: { deployments: [] } };
      },
    }) as unknown as typeof fetch;

    await vercelAdapter.query(WS, q(), TOKEN);

    expect(captured).not.toBeNull();
    expect(captured!.searchParams.get("projectId")).toBe(PROJECT_ID);
    expect(captured!.searchParams.get("until")).toBe(String(WINDOW_END_MS));
  });

  it("does NOT send a since param on the shared deployments fetch — would silently exclude the serving-at-start deployment (see module doc-comment)", async () => {
    let captured: URL | null = null;
    global.fetch = routeFetch({
      deployments: (url) => {
        captured = url;
        return { status: 200, body: { deployments: [] } };
      },
    }) as unknown as typeof fetch;

    await vercelAdapter.query(WS, q(), TOKEN);
    expect(captured!.searchParams.has("since")).toBe(false);
  });

  it("sends teamId when configured", async () => {
    let captured: URL | null = null;
    global.fetch = routeFetch({
      deployments: (url) => {
        captured = url;
        return { status: 200, body: { deployments: [] } };
      },
    }) as unknown as typeof fetch;

    await vercelAdapter.query(WS, q(), TOKEN);
    expect(captured!.searchParams.get("teamId")).toBe(TEAM_ID);
  });

  it("omits teamId entirely when not configured (personal scope) — not sent as an empty string", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(PROJECT_ID, null));
    let captured: URL | null = null;
    global.fetch = routeFetch({
      deployments: (url) => {
        captured = url;
        return { status: 200, body: { deployments: [] } };
      },
    }) as unknown as typeof fetch;

    await vercelAdapter.query(WS, q(), TOKEN);
    expect(captured!.searchParams.has("teamId")).toBe(false);
  });
});

describe("vercelAdapter — search_events: happy path rendering", () => {
  function withOneDeploymentInWindow(events: Array<Record<string, unknown>>) {
    return routeFetch({
      deployments: () => ({ status: 200, body: { deployments: [deploymentNode({ uid: "dpl_1" })] } }),
      events: () => ({ status: 200, body: events }),
    });
  }

  it("renders log lines: type, quoted text, iso timestamp — from the flat (top-level text) response branch", async () => {
    global.fetch = withOneDeploymentInWindow([
      { type: "stdout", created: WINDOW_START_MS + 3000, text: "listening on port 3000" },
    ]) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res).toEqual({
      ok: true,
      raw: `log stdout "listening on port 3000" at=${new Date(WINDOW_START_MS + 3000).toISOString()}`,
    });
  });

  it("reads text from the nested payload.text shape (the wrapped response branch)", async () => {
    global.fetch = withOneDeploymentInWindow([
      { type: "stdout", created: WINDOW_START_MS + 3000, payload: { text: "wrapped payload text" } },
    ]) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain('"wrapped payload text"');
  });

  it("prefers top-level text over payload.text when both are present", async () => {
    global.fetch = withOneDeploymentInWindow([
      { type: "stdout", created: WINDOW_START_MS + 3000, text: "top-level", payload: { text: "nested" } },
    ]) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain('"top-level"');
  });

  it("renders an empty quoted string when text is absent from both shapes (e.g. a delimiter/exit event)", async () => {
    global.fetch = withOneDeploymentInWindow([
      { type: "exit", created: WINDOW_START_MS + 3000 },
    ]) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res).toEqual({
      ok: true,
      raw: `log exit "" at=${new Date(WINDOW_START_MS + 3000).toISOString()}`,
    });
  });

  it("falls back to type=- when type is absent (defensive, undocumented shape)", async () => {
    global.fetch = withOneDeploymentInWindow([
      { created: WINDOW_START_MS + 3000, text: "no type here" },
    ]) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("log - ");
  });

  it("collapses embedded newlines and truncates text to 120 characters", async () => {
    const longText = "a\nb ".repeat(50);
    global.fetch = withOneDeploymentInWindow([
      { type: "stdout", created: WINDOW_START_MS + 3000, text: longText },
    ]) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const quoted = res.raw.match(/"([^"]*)"/)![1];
    expect(quoted.length).toBeLessThanOrEqual(120);
    expect(quoted).not.toContain("\n");
  });

  it("treats a `null` events response as zero events, not an error (Vercel's own confirmed nullable-array shape)", async () => {
    global.fetch = routeFetch({
      deployments: () => ({ status: 200, body: { deployments: [deploymentNode({ uid: "dpl_1" })] } }),
      events: () => ({ status: 200, body: null }),
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res).toEqual({ ok: true, raw: "(no matching log lines)" });
  });

  it("skips a null/non-object entry within the array rather than throwing", async () => {
    global.fetch = withOneDeploymentInWindow([
      null as unknown as Record<string, unknown>,
      { type: "stdout", created: WINDOW_START_MS + 3000, text: "fine" },
    ]) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
    expect(res.raw).toContain("fine");
  });

  it("orders lines chronologically (ascending), not by arrival order", async () => {
    global.fetch = withOneDeploymentInWindow([
      { type: "stdout", created: WINDOW_START_MS + 5000, text: "second" },
      { type: "stdout", created: WINDOW_START_MS + 1000, text: "first" },
    ]) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("second");
  });

  it("renders '(no matching log lines)' when there are zero deployments in window", async () => {
    global.fetch = routeFetch({
      deployments: () => ({ status: 200, body: { deployments: [] } }),
    }) as unknown as typeof fetch;
    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res).toEqual({ ok: true, raw: "(no matching log lines)" });
  });

  it("caps total lines at limit (default 200), keeping the most recent", async () => {
    const events = Array.from({ length: 250 }, (_, i) => ({
      type: "stdout",
      created: WINDOW_START_MS + i * 1000,
      text: `line-${i}`,
    }));
    global.fetch = withOneDeploymentInWindow(events) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines).toHaveLength(200);
    expect(lines[0]).toContain("line-50");
    expect(lines[lines.length - 1]).toContain("line-249");
  });

  it("clamps limit:0 to at least one line", async () => {
    global.fetch = withOneDeploymentInWindow([
      { type: "stdout", created: WINDOW_START_MS + 1000, text: "only" },
    ]) as unknown as typeof fetch;
    const res = await vercelAdapter.query(WS, q({ verb: "search_events", limit: 0 }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
  });
});

describe("vercelAdapter — search_events: q.query client-side filter (no server-side home)", () => {
  it("filters by q.query, case-insensitive substring, against the SAME rendered text the caller receives", async () => {
    global.fetch = routeFetch({
      deployments: () => ({ status: 200, body: { deployments: [deploymentNode({ uid: "dpl_1" })] } }),
      events: () => ({
        status: 200,
        body: [
          { type: "stdout", created: WINDOW_START_MS + 1000, text: "checkout succeeded" },
          { type: "stderr", created: WINDOW_START_MS + 2000, text: "POOL EXHAUSTED for db" },
        ],
      }),
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events", query: "pool exhausted" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
    expect(res.raw).toContain("POOL EXHAUSTED");
  });

  it("a q.query matching nothing renders the honest empty marker", async () => {
    global.fetch = routeFetch({
      deployments: () => ({ status: 200, body: { deployments: [deploymentNode({ uid: "dpl_1" })] } }),
      events: () => ({ status: 200, body: [{ type: "stdout", created: WINDOW_START_MS + 1000, text: "some text" }] }),
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events", query: "totally-unrelated-xyz" }), TOKEN);
    expect(res).toEqual({ ok: true, raw: "(no matching log lines)" });
  });

  it("q.query never rides server-side into either request URL at all", async () => {
    let deploymentsUrl: URL | null = null;
    let eventsUrl: URL | null = null;
    global.fetch = routeFetch({
      deployments: (url) => {
        deploymentsUrl = url;
        return { status: 200, body: { deployments: [deploymentNode({ uid: "dpl_1" })] } };
      },
      events: (_id, url) => {
        eventsUrl = url;
        return { status: 200, body: [] };
      },
    }) as unknown as typeof fetch;

    await vercelAdapter.query(WS, q({ verb: "search_events", query: "should-never-appear" }), TOKEN);

    expect(deploymentsUrl!.toString()).not.toContain("should-never-appear");
    expect(eventsUrl!.toString()).not.toContain("should-never-appear");
    expect(deploymentsUrl!.searchParams.has("query")).toBe(false);
    expect(eventsUrl!.searchParams.has("query")).toBe(false);
  });
});

describe("vercelAdapter — search_events: per-deployment failure isolation", () => {
  it("a deployment whose events fetch 500s gets one cap-exempt marker; a sibling deployment's real lines still render, ok:true", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: { deployments: [deploymentNode({ uid: "dpl-broken" }), deploymentNode({ uid: "dpl-ok" })] },
      }),
      events: (deploymentId) =>
        deploymentId === "dpl-broken"
          ? { status: 500, body: {} }
          : { status: 200, body: [{ type: "stdout", created: WINDOW_START_MS + 1000, text: "ok line" }] },
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("(deployment dpl-broken: vercel upstream_error)");
    expect(res.raw).toContain("ok line");
  });

  it("a thrown fetch for one deployment's events renders '(deployment {id}: vercel unreachable)' when a sibling succeeds", async () => {
    global.fetch = vi.fn(async (rawUrl: string) => {
      const url = new URL(rawUrl);
      if (url.pathname === "/v7/deployments") {
        return httpResponse(200, {
          deployments: [deploymentNode({ uid: "dpl-flaky" }), deploymentNode({ uid: "dpl-ok" })],
        });
      }
      if (url.pathname === "/v3/deployments/dpl-flaky/events") {
        throw new Error("network down");
      }
      return httpResponse(200, [{ type: "stdout", created: WINDOW_START_MS + 1000, text: "ok line" }]);
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("(deployment dpl-flaky: vercel unreachable)");
    expect(res.raw).toContain("ok line");
  });

  it("markers are cap-exempt and rendered first, surviving alongside a busy sibling deployment's capped real lines", async () => {
    const manyEvents = Array.from({ length: 10 }, (_, i) => ({
      type: "stdout",
      created: WINDOW_START_MS + i * 1000,
      text: `line-${i}`,
    }));
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: { deployments: [deploymentNode({ uid: "dpl-broken" }), deploymentNode({ uid: "dpl-busy" })] },
      }),
      events: (deploymentId) =>
        deploymentId === "dpl-broken" ? { status: 401, body: {} } : { status: 200, body: manyEvents },
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events", limit: 3 }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines[0]).toBe("(deployment dpl-broken: vercel unauthorized)");
    const realLines = lines.filter((l) => l.startsWith("log "));
    expect(realLines).toHaveLength(3);
  });

  it("a 404 on a PER-DEPLOYMENT events fetch is NOT remapped to config_missing (unlike the shared deployments-list call) — a specific deployment id 404ing is a transient/upstream case, not an operator mistake", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: { deployments: [deploymentNode({ uid: "dpl-vanished" }), deploymentNode({ uid: "dpl-ok" })] },
      }),
      events: (deploymentId) =>
        deploymentId === "dpl-vanished"
          ? { status: 404, body: {} }
          : { status: 200, body: [{ type: "stdout", created: WINDOW_START_MS + 1000, text: "ok line" }] },
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("(deployment dpl-vanished: vercel upstream_error)");
    expect(res.raw).toContain("ok line");
  });

  it("degrades to upstream_error when every targeted deployment's events fetch fails", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: { deployments: [deploymentNode({ uid: "dpl-a" }), deploymentNode({ uid: "dpl-b" })] },
      }),
      events: () => ({ status: 503, body: {} }),
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("bounds the fan-out to SEARCH_EVENTS_MAX_DEPLOYMENTS (10), never querying events for more than that many deployments — EXPLICIT PIN, unlike railway's 20", async () => {
    const deployments = Array.from({ length: 30 }, (_, i) =>
      deploymentNode({ uid: `dpl-${i}`, createdAt: WINDOW_START_MS + i * 1000 })
    );
    const queriedDeploymentIds = new Set<string>();
    global.fetch = vi.fn(async (rawUrl: string) => {
      const url = new URL(rawUrl);
      if (url.pathname === "/v7/deployments") {
        return httpResponse(200, { deployments });
      }
      const match = url.pathname.match(/^\/v3\/deployments\/([^/]+)\/events$/);
      if (match) {
        queriedDeploymentIds.add(match[1]);
        return httpResponse(200, []);
      }
      throw new Error(`unexpected URL: ${rawUrl}`);
    }) as unknown as typeof fetch;

    await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(queriedDeploymentIds.size).toBe(10);
  });
});

describe("vercelAdapter — search_events: request hygiene + team scoping on the events fetch", () => {
  it("sends since/until as epoch-ms strings and teamId (when configured) on the per-deployment events fetch", async () => {
    let eventsUrl: URL | null = null;
    global.fetch = routeFetch({
      deployments: () => ({ status: 200, body: { deployments: [deploymentNode({ uid: "dpl_1" })] } }),
      events: (_id, url) => {
        eventsUrl = url;
        return { status: 200, body: [] };
      },
    }) as unknown as typeof fetch;

    await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);

    expect(eventsUrl!.searchParams.get("since")).toBe(String(WINDOW_START_MS));
    expect(eventsUrl!.searchParams.get("until")).toBe(String(WINDOW_END_MS));
    expect(eventsUrl!.searchParams.get("teamId")).toBe(TEAM_ID);
  });

  it("omits teamId on the events fetch too when not configured", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(PROJECT_ID, null));
    let eventsUrl: URL | null = null;
    global.fetch = routeFetch({
      deployments: () => ({ status: 200, body: { deployments: [deploymentNode({ uid: "dpl_1" })] } }),
      events: (_id, url) => {
        eventsUrl = url;
        return { status: 200, body: [] };
      },
    }) as unknown as typeof fetch;

    await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(eventsUrl!.searchParams.has("teamId")).toBe(false);
  });
});

// -----------------------------------------------------------------------
// SEARCH_EVENTS CANDIDATE SELECTION — cited verbatim from railway.ts's own
// Fix Round 1 FIX 1c: candidate selection must include the deployment
// serving at window start, not just ones CREATED inside the window.
// -----------------------------------------------------------------------
describe("vercelAdapter — search_events includes the deployment serving at window start (railway FIX 1c, cited)", () => {
  it("a deployment created well BEFORE windowStart, still serving through the window, has its in-window events returned", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: { deployments: [deploymentNode({ uid: "long-lived", createdAt: WINDOW_START_MS - 9 * 24 * 3600_000 })] },
      }),
      events: () => ({
        status: 200,
        body: [{ type: "stdout", created: WINDOW_START_MS + 1000, text: "still serving" }],
      }),
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res).toEqual({
      ok: true,
      raw: `log stdout "still serving" at=${new Date(WINDOW_START_MS + 1000).toISOString()}`,
    });
  });

  it("changes does NOT include that same long-lived pre-window deployment — the special inclusion is search_events-only", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: { deployments: [deploymentNode({ uid: "long-lived", createdAt: WINDOW_START_MS - 9 * 24 * 3600_000 })] },
      }),
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "changes" }), TOKEN);
    expect(res).toEqual({ ok: true, raw: "(no deployments in window)" });
  });

  it("includes only the SINGLE most recent pre-window deployment, not every deployment created before windowStart", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: {
          deployments: [
            deploymentNode({ uid: "older", createdAt: WINDOW_START_MS - 20 * 24 * 3600_000 }),
            deploymentNode({ uid: "most-recent-before-start", createdAt: WINDOW_START_MS - 1000 }),
          ],
        },
      }),
      events: (deploymentId) => ({
        status: 200,
        body: [{ type: "stdout", created: WINDOW_START_MS + 1000, text: `from ${deploymentId}` }],
      }),
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("from most-recent-before-start");
    expect(res.raw).not.toContain("from older");
  });

  it("a deployment created exactly AT windowStart is not double-counted (already in-window; not also treated as the separate serving-at-start pick)", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: { deployments: [deploymentNode({ uid: "at-start", createdAt: WINDOW_START_MS })] },
      }),
      events: () => ({
        status: 200,
        body: [{ type: "stdout", created: WINDOW_START_MS + 1000, text: "one line" }],
      }),
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // Exactly one log line — the deployment was queried once, not twice.
    expect(res.raw.split("\n")).toHaveLength(1);
  });

  it("no pre-window deployment exists at all — search_events falls back to in-window candidates alone (empty here)", async () => {
    global.fetch = routeFetch({
      deployments: () => ({
        status: 200,
        body: { deployments: [deploymentNode({ uid: "after", createdAt: WINDOW_END_MS + 1000 })] },
      }),
    }) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q({ verb: "search_events" }), TOKEN);
    expect(res).toEqual({ ok: true, raw: "(no matching log lines)" });
  });
});

// -----------------------------------------------------------------------
// pin 4: catalog↔adapter↔verify config-key alignment.
// -----------------------------------------------------------------------
describe("vercelAdapter — catalog↔adapter↔verify config-key alignment (pin 4)", () => {
  const vercelEntry = CONNECTOR_CATALOG.find((c) => c.kind === "vercel")!;
  const catalogFields = vercelEntry.connect!.extraConfigFields!;

  it("the catalog declares exactly ['vercelProjectId','vercelTeamId'], required [true,false] — the literal keys vercel.ts's query() and verify.ts's verifyVercel both read", () => {
    expect(catalogFields.map((f) => f.key)).toEqual(["vercelProjectId", "vercelTeamId"]);
    expect(catalogFields[0].required).toBe(true);
    expect(catalogFields[1].required).toBe(false);
  });

  it("declares NO secretParts/secretPartPatterns — a single, non-composite secret, like sentry/prometheus/grafana", () => {
    expect(vercelEntry.connect?.secretParts).toBeUndefined();
    expect(vercelEntry.connect?.secretPartPatterns).toBeUndefined();
  });

  it("declares evidence capabilities [changes, search_events]", () => {
    expect(vercelEntry.capabilities).toEqual({
      ingest: false,
      postResult: false,
      notify: false,
      evidence: ["changes", "search_events"],
    });
  });

  it("the adapter reads config.<catalog-declared-keys> — a connector row built from those keys (not this test file's own hardcoded literals) reaches a real fetch rather than degrading config_missing", async () => {
    const [projectKey, teamKey] = catalogFields.map((f) => f.key);
    mockGetConnector.mockResolvedValue({
      provider: "vercel" as const,
      enabled: true,
      config: {
        repos: [],
        triggerLabel: "ready-for-agent",
        pollIntervalSeconds: 60,
        [projectKey]: PROJECT_ID,
        [teamKey]: TEAM_ID,
      },
      hasSecret: true,
      updatedAt: null,
    } as never);
    global.fetch = routeFetch({}) as unknown as typeof fetch;

    const res = await vercelAdapter.query(WS, q(), TOKEN);
    expect(res).not.toEqual({ ok: false, reason: "config_missing" });
  });

  it("verifyVercel reads config using EXACTLY the catalog's declared keys too — a config object built from those keys reaches Vercel's project-visibility check rather than skipping it", async () => {
    const [projectKey, teamKey] = catalogFields.map((f) => f.key);
    const calledUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calledUrls.push(url);
      if (String(url).includes("/v9/projects/")) {
        return { ok: true, status: 200, json: async () => ({ id: PROJECT_ID }) };
      }
      return { ok: true, status: 200, json: async () => ({ user: { id: "u1" } }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await verifyConnectorCredential("vercel", TOKEN, undefined, {
      [projectKey]: PROJECT_ID,
      [teamKey]: TEAM_ID,
    });

    expect(res).toEqual({ ok: true });
    expect(calledUrls.some((u) => u.includes(`/v9/projects/${PROJECT_ID}`))).toBe(true);
    expect(calledUrls.some((u) => u.includes(`teamId=${TEAM_ID}`))).toBe(true);
  });
});
