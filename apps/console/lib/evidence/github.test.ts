import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors factory.test.ts's mocking idiom (mock the package's named exports
// directly) and github-repos.test.ts's global.fetch idiom (this is the
// existing console fetch-mocking pattern for real GitHub REST calls).
vi.mock("@agentrail/db-postgres", () => ({
  getInstallationToken: vi.fn(),
  getConnector: vi.fn(),
}));

import { getInstallationToken, getConnector } from "@agentrail/db-postgres";
import { githubAdapter } from "./github";
import { adapterFor } from "./registry";
import type { EvidenceQuery, EvidenceVerb } from "./types";

const mockGetToken = vi.mocked(getInstallationToken);
const mockGetConnector = vi.mocked(getConnector);

const WS = "00000000-0000-0000-0000-000000000001";
const TOKEN = "ghs_installation-token-abc";
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

function connectorRow(repos: string[]) {
  return {
    provider: "github" as const,
    enabled: true,
    config: { repos, triggerLabel: "ready-for-agent", pollIntervalSeconds: 60 },
    hasSecret: false,
    updatedAt: null,
  };
}

function pr(overrides: Record<string, unknown> = {}) {
  return {
    number: 212,
    title: "fix pool sizing",
    merged_at: "2026-07-29T14:02:00.000Z",
    user: { login: "bensigo" },
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    name: "deploy.yml",
    conclusion: "success",
    created_at: "2026-07-29T13:00:00.000Z",
    ...overrides,
  };
}

function ghResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function extractRepo(url: string): string {
  const m = /\/repos\/([^/]+\/[^/]+)\//.exec(url);
  if (!m) throw new Error(`could not extract repo from url: ${url}`);
  return m[1]!;
}

interface RepoHandler {
  pulls?: (page: number) => { status: number; body: unknown };
  runs?: () => { status: number; body: unknown };
  throwOnPulls?: boolean;
  throwOnRuns?: boolean;
}

/** Routes a fetch mock by repo (parsed from the URL path) and endpoint kind
 * (`/pulls` vs `/actions/runs`) — lets each test declare per-repo,
 * per-endpoint behavior without a giant if/else chain. Defaults to a bare
 * 200/empty response for anything a test doesn't explicitly configure. */
function routeFetch(handlersByRepo: Record<string, RepoHandler>) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const u = String(url);
    const repo = extractRepo(u);
    const handler = handlersByRepo[repo] ?? {};
    if (u.includes("/pulls")) {
      if (handler.throwOnPulls) throw new Error("network down");
      // `[?&]page=` (not a bare `page=`) — the URL also carries
      // `per_page=100`, which a bare `/page=(\d+)/` would match FIRST
      // (per_**page=100**), always extracting 100 instead of the real page
      // number.
      const pageMatch = /[?&]page=(\d+)/.exec(u);
      const page = pageMatch ? Number(pageMatch[1]) : 1;
      const h = handler.pulls ? handler.pulls(page) : { status: 200, body: [] };
      return ghResponse(h.status, h.body);
    }
    if (u.includes("/actions/runs")) {
      if (handler.throwOnRuns) throw new Error("network down");
      const h = handler.runs ? handler.runs() : { status: 200, body: { workflow_runs: [] } };
      return ghResponse(h.status, h.body);
    }
    throw new Error(`unexpected fetch url: ${u}`);
  });
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetToken.mockResolvedValue(TOKEN);
  mockGetConnector.mockResolvedValue(connectorRow(["acme/widgets"]));
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("githubAdapter — shape", () => {
  it("declares provider 'github' and verbs [changes]", () => {
    expect(githubAdapter.provider).toBe("github");
    expect(githubAdapter.verbs).toEqual(["changes"]);
  });

  it("self-registers into the shared registry on module load", () => {
    expect(adapterFor("github")).toBe(githubAdapter);
  });
});

describe("githubAdapter — bad_request validation", () => {
  it("degrades bad_request on an unparseable windowStart, without ever resolving a token", async () => {
    const res = await githubAdapter.query(WS, q({ windowStart: "not-a-date" }), null);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it("degrades bad_request on an unparseable windowEnd", async () => {
    const res = await githubAdapter.query(WS, q({ windowEnd: "" }), null);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
  });

  it("degrades bad_request for a verb this adapter does not declare", async () => {
    const res = await githubAdapter.query(WS, q({ verb: "search_events" as EvidenceVerb }), null);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
  });
});

describe("githubAdapter — token resolution (unauthorized)", () => {
  it("degrades unauthorized when getInstallationToken resolves null, without ever reading the connector row", async () => {
    mockGetToken.mockResolvedValue(null);
    const res = await githubAdapter.query(WS, q(), null);
    expect(res).toEqual({ ok: false, reason: "unauthorized" });
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("resolves the installation token for the given workspaceId", async () => {
    global.fetch = routeFetch({
      "acme/widgets": { pulls: () => ({ status: 200, body: [] }), runs: () => ({ status: 200, body: { workflow_runs: [] } }) },
    }) as unknown as typeof fetch;
    await githubAdapter.query(WS, q(), null);
    expect(mockGetToken).toHaveBeenCalledWith(WS);
  });

  it("ignores the secret parameter entirely — identical result whether null or a real string", async () => {
    global.fetch = routeFetch({
      "acme/widgets": { pulls: () => ({ status: 200, body: [] }), runs: () => ({ status: 200, body: { workflow_runs: [] } }) },
    }) as unknown as typeof fetch;
    const withNull = await githubAdapter.query(WS, q(), null);
    const withSecret = await githubAdapter.query(WS, q(), "irrelevant-secret-value");
    expect(withNull).toEqual(withSecret);
  });
});

describe("githubAdapter — repo config (config_missing)", () => {
  it("degrades config_missing when the github connector row has zero repos, without ever calling fetch", async () => {
    mockGetConnector.mockResolvedValue(connectorRow([]));
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await githubAdapter.query(WS, q(), null);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("degrades config_missing when there is no github connector row at all", async () => {
    mockGetConnector.mockResolvedValue(null);
    const res = await githubAdapter.query(WS, q(), null);
    expect(res).toEqual({ ok: false, reason: "config_missing" });
  });

  it("reads the connector row for provider 'github' specifically", async () => {
    global.fetch = routeFetch({
      "acme/widgets": { pulls: () => ({ status: 200, body: [] }), runs: () => ({ status: 200, body: { workflow_runs: [] } }) },
    }) as unknown as typeof fetch;
    await githubAdapter.query(WS, q(), null);
    expect(mockGetConnector).toHaveBeenCalledWith(WS, "github");
  });
});

describe("githubAdapter — happy path rendering", () => {
  it("renders both merged PRs and workflow runs, most-recent-first across both kinds", async () => {
    global.fetch = routeFetch({
      "acme/widgets": {
        pulls: (page) =>
          page === 1
            ? {
                status: 200,
                body: [
                  pr({
                    number: 212,
                    title: "fix pool sizing",
                    merged_at: "2026-07-29T14:02:00.000Z",
                    user: { login: "bensigo" },
                  }),
                ],
              }
            : { status: 200, body: [] },
        runs: () => ({
          status: 200,
          body: {
            workflow_runs: [
              run({ name: "deploy.yml", conclusion: "failure", created_at: "2026-07-29T15:00:00.000Z" }),
            ],
          },
        }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q(), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines).toHaveLength(2);
    // actions_run at 15:00 is more recent than merged_pr at 14:02.
    expect(lines[0]).toBe("actions_run acme/widgets deploy.yml conclusion=failure at=2026-07-29T15:00:00.000Z");
    expect(lines[1]).toBe(
      'merged_pr acme/widgets#212 "fix pool sizing" merged_at=2026-07-29T14:02:00.000Z by=bensigo'
    );
  });

  it("renders conclusion=in_progress when a run's conclusion is null", async () => {
    global.fetch = routeFetch({
      "acme/widgets": {
        pulls: () => ({ status: 200, body: [] }),
        runs: () => ({ status: 200, body: { workflow_runs: [run({ conclusion: null })] } }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q(), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("conclusion=in_progress");
  });

  it("caps a PR title at 120 characters, with no other transformation", async () => {
    const longTitle = "x".repeat(200);
    global.fetch = routeFetch({
      "acme/widgets": {
        pulls: (page) => (page === 1 ? { status: 200, body: [pr({ title: longTitle })] } : { status: 200, body: [] }),
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q(), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const titleMatch = /"([^"]*)"/.exec(res.raw);
    expect(titleMatch?.[1]).toHaveLength(120);
    expect(titleMatch?.[1]).toBe("x".repeat(120));
  });

  it("renders '-' for a missing PR author login", async () => {
    global.fetch = routeFetch({
      "acme/widgets": {
        pulls: (page) => (page === 1 ? { status: 200, body: [pr({ user: null })] } : { status: 200, body: [] }),
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q(), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("by=-");
  });
});

describe("githubAdapter — window filtering", () => {
  it("excludes merged PRs outside [windowStart, windowEnd] and one with merged_at:null, keeping inclusive bounds", async () => {
    global.fetch = routeFetch({
      "acme/widgets": {
        pulls: (page) =>
          page === 1
            ? {
                status: 200,
                body: [
                  pr({ number: 101, merged_at: "2026-07-28T23:00:00.000Z", title: "before" }),
                  pr({ number: 102, merged_at: "2026-07-30T00:00:01.000Z", title: "after" }),
                  pr({ number: 103, merged_at: null, title: "not merged" }),
                  pr({ number: 104, merged_at: WINDOW_START, title: "at start" }),
                  pr({ number: 105, merged_at: WINDOW_END, title: "at end" }),
                ],
              }
            : { status: 200, body: [] },
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q(), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines).toHaveLength(2);
    expect(res.raw).toContain("#104");
    expect(res.raw).toContain("#105");
  });
});

describe("githubAdapter — per-repo failure isolation", () => {
  it("a repo whose GitHub call 500s gets one marker line; a sibling repo's real lines still render, ok:true", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(["acme/broken", "acme/widgets"]));
    global.fetch = routeFetch({
      "acme/broken": {
        pulls: () => ({ status: 500, body: {} }),
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
      "acme/widgets": {
        pulls: (page) =>
          page === 1
            ? { status: 200, body: [pr({ number: 9, title: "ok pr", merged_at: "2026-07-29T10:00:00.000Z", user: { login: "eve" } })] }
            : { status: 200, body: [] },
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q(), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("(repo acme/broken: github 500)");
    expect(res.raw).toContain('merged_pr acme/widgets#9 "ok pr"');
  });

  it("a thrown/aborted fetch on one repo renders '(repo {repo}: github unreachable)' when a sibling repo succeeds", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(["acme/flaky", "acme/widgets"]));
    global.fetch = routeFetch({
      "acme/flaky": { throwOnPulls: true },
      "acme/widgets": {
        pulls: () => ({ status: 200, body: [] }),
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q(), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toBe("(repo acme/flaky: github unreachable)");
  });

  it("a failing repo's runs leg (not just pulls) also collapses the whole repo to one marker", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(["acme/broken", "acme/widgets"]));
    global.fetch = routeFetch({
      "acme/broken": {
        pulls: () => ({ status: 200, body: [] }),
        runs: () => ({ status: 503, body: {} }),
      },
      "acme/widgets": {
        pulls: () => ({ status: 200, body: [] }),
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q(), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toBe("(repo acme/broken: github 503)");
  });
});

// FIX ROUND 1, FIX 2: a repo whose 2-page PR fetch might have missed an
// in-window merge (both pages full, and the last-fetched item's updated_at
// is still after windowStart) gets an honest fetch-horizon caveat, folded
// into the SAME cap-exempt marker mechanism as a hard failure — but the
// fetch itself still succeeded, so it rides alongside real lines rather
// than replacing them.
describe("githubAdapter — FIX 2: PR fetch-horizon caveat (factory-style honesty)", () => {
  function fullPrPage(pageNum: number, baseMs: number) {
    return Array.from({ length: 100 }, (_, i) => {
      const globalIndex = (pageNum - 1) * 100 + i;
      return pr({
        number: 9000 + globalIndex,
        merged_at: null, // irrelevant to the caveat check — no real lines needed
        updated_at: new Date(baseMs - globalIndex * 60_000).toISOString(),
      });
    });
  }

  it("appends a caveat when both PR pages are full and the last item's updated_at is still after windowStart", async () => {
    const baseMs = new Date(WINDOW_END).getTime();
    global.fetch = routeFetch({
      "acme/widgets": {
        pulls: (page) =>
          page === 1 || page === 2
            ? { status: 200, body: fullPrPage(page, baseMs) }
            : { status: 200, body: [] },
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q(), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain(
      "(repo acme/widgets: note — only the 200 most recently updated PRs were searched; older in-window merges may be missing)"
    );
  });

  it("no caveat when the pages are not both full (a genuine last page was reached)", async () => {
    global.fetch = routeFetch({
      "acme/widgets": {
        pulls: (page) =>
          page === 1
            ? { status: 200, body: [pr({ merged_at: null, updated_at: "2026-07-29T10:00:00.000Z" })] }
            : { status: 200, body: [] },
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q(), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).not.toContain("note —");
  });

  it("no caveat when both pages are full but the last item's updated_at already reaches back to/past windowStart", async () => {
    // Page 2's last item lands exactly at windowStart minus a hair over —
    // construct so the boundary value is <= windowStart (fully covered).
    const earlyBase = new Date(WINDOW_START).getTime() + 199 * 60_000;
    global.fetch = routeFetch({
      "acme/widgets": {
        pulls: (page) =>
          page === 1 || page === 2
            ? { status: 200, body: fullPrPage(page, earlyBase) }
            : { status: 200, body: [] },
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q(), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).not.toContain("note —");
  });

  it("the caveat is cap-exempt and survives alongside a sibling repo's real lines", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(["acme/uncertain", "acme/normal"]));
    const baseMs = new Date(WINDOW_END).getTime();
    global.fetch = routeFetch({
      "acme/uncertain": {
        pulls: (page) =>
          page === 1 || page === 2
            ? { status: 200, body: fullPrPage(page, baseMs) }
            : { status: 200, body: [] },
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
      "acme/normal": {
        pulls: (page) =>
          page === 1
            ? { status: 200, body: [pr({ number: 1, merged_at: "2026-07-29T10:00:00.000Z" })] }
            : { status: 200, body: [] },
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q(), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("(repo acme/uncertain: note —");
    expect(res.raw).toContain("merged_pr acme/normal#1");
  });
});

describe("githubAdapter — all repos failing", () => {
  it("degrades to upstream_error when every targeted repo's GitHub call fails", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(["acme/a", "acme/b"]));
    global.fetch = routeFetch({
      "acme/a": { pulls: () => ({ status: 503, body: {} }) },
      "acme/b": { throwOnPulls: true },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q(), null);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });

  it("degrades to upstream_error for a single connected repo whose only call fails", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(["acme/only"]));
    global.fetch = routeFetch({
      "acme/only": { throwOnPulls: true },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q(), null);
    expect(res).toEqual({ ok: false, reason: "upstream_error" });
  });
});

describe("githubAdapter — pagination", () => {
  it("fetches at most 2 pages of merged PRs per repo, even when every page is full", async () => {
    const fullPage = () =>
      Array.from({ length: 100 }, (_, i) => pr({ number: 1000 + i, merged_at: "2026-07-29T12:00:00.000Z" }));
    const fetchMock = routeFetch({
      "acme/widgets": {
        pulls: () => ({ status: 200, body: fullPage() }),
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await githubAdapter.query(WS, q(), null);

    const pullsCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/pulls"));
    expect(pullsCalls).toHaveLength(2);
    // `&page=1` (not a bare "page=1") — the URL also carries `per_page=100`,
    // which itself contains the substring "page=1" (as a prefix of
    // "page=100"), so a bare `.toContain("page=1")` would pass even if the
    // real `&page=` parameter were missing entirely.
    expect(String(pullsCalls[0]![0])).toContain("&page=1");
    expect(String(pullsCalls[1]![0])).toContain("&page=2");
  });

  it("stops after a short page (fewer than 100 entries) without fetching a second page", async () => {
    const fetchMock = routeFetch({
      "acme/widgets": {
        pulls: () => ({ status: 200, body: [pr({ number: 1 })] }),
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await githubAdapter.query(WS, q(), null);

    const pullsCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/pulls"));
    expect(pullsCalls).toHaveLength(1);
  });

  it("queries workflow runs exactly once (single page), never paginating", async () => {
    const fetchMock = routeFetch({
      "acme/widgets": {
        pulls: () => ({ status: 200, body: [] }),
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await githubAdapter.query(WS, q(), null);

    const runsCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/actions/runs"));
    expect(runsCalls).toHaveLength(1);
  });
});

describe("githubAdapter — repo cap", () => {
  it("queries at most the first 5 repos from config.repos, in array order", async () => {
    const repos = ["r/1", "r/2", "r/3", "r/4", "r/5", "r/6", "r/7"];
    mockGetConnector.mockResolvedValue(connectorRow(repos));
    const fetchMock = routeFetch(
      Object.fromEntries(
        repos.map((r) => [
          r,
          { pulls: () => ({ status: 200, body: [] }), runs: () => ({ status: 200, body: { workflow_runs: [] } }) },
        ])
      )
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await githubAdapter.query(WS, q(), null);

    const queried = new Set(fetchMock.mock.calls.map(([url]) => extractRepo(String(url))));
    expect(queried).toEqual(new Set(["r/1", "r/2", "r/3", "r/4", "r/5"]));
  });
});

describe("githubAdapter — line cap", () => {
  function manyPrs(count: number) {
    return Array.from({ length: count }, (_, i) =>
      pr({ number: i, merged_at: new Date(new Date(WINDOW_START).getTime() + i * 1000).toISOString() })
    );
  }

  it("caps total lines at limit (default 50), keeping the most recent", async () => {
    global.fetch = routeFetch({
      "acme/widgets": {
        pulls: (page) => (page === 1 ? { status: 200, body: manyPrs(60) } : { status: 200, body: [] }),
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q(), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(50);
  });

  it("respects an explicit smaller limit", async () => {
    global.fetch = routeFetch({
      "acme/widgets": {
        pulls: (page) => (page === 1 ? { status: 200, body: manyPrs(10) } : { status: 200, body: [] }),
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q({ limit: 3 }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(3);
  });

  it("clamps limit:0 to at least one line rather than a bare empty string", async () => {
    global.fetch = routeFetch({
      "acme/widgets": {
        pulls: (page) => (page === 1 ? { status: 200, body: [pr({ number: 1 })] } : { status: 200, body: [] }),
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q({ limit: 0 }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).not.toBe("");
    expect(res.raw.split("\n")).toHaveLength(1);
  });
});

// FIX ROUND 1, FIX 1 (Critical): markers must survive the line cap. Before
// this fix, markers were appended AFTER real lines and the whole combined
// array was sliced to `limit` — a busy repo's real lines could silently
// push a sibling repo's failure marker out of the rendered output.
describe("githubAdapter — FIX 1: failure markers are cap-exempt and rendered first", () => {
  it("a busy repo's real lines never push a sibling repo's failure marker out of the response", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(["acme/busy", "acme/broken"]));
    const many = Array.from({ length: 60 }, (_, i) =>
      pr({ number: i, merged_at: new Date(new Date(WINDOW_START).getTime() + i * 1000).toISOString() })
    );
    global.fetch = routeFetch({
      "acme/busy": {
        pulls: (page) => (page === 1 ? { status: 200, body: many } : { status: 200, body: [] }),
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
      "acme/broken": {
        pulls: () => ({ status: 500, body: {} }),
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q(), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    // Marker first.
    expect(lines[0]).toBe("(repo acme/broken: github 500)");
    // Exactly 50 real lines (the default cap) still present.
    const realLines = lines.filter((l) => l.startsWith("merged_pr") || l.startsWith("actions_run"));
    expect(realLines).toHaveLength(50);
    expect(lines).toHaveLength(51);
  });

  it("the empty-plus-marker case is unchanged: a single marker with zero real lines renders as just that marker", async () => {
    mockGetConnector.mockResolvedValue(connectorRow(["acme/flaky", "acme/widgets"]));
    global.fetch = routeFetch({
      "acme/flaky": { throwOnPulls: true },
      "acme/widgets": {
        pulls: () => ({ status: 200, body: [] }),
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q(), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toBe("(repo acme/flaky: github unreachable)");
  });
});

describe("githubAdapter — honest empty marker", () => {
  it("renders '(no changes in window)' when every repo succeeds but nothing is in window", async () => {
    global.fetch = routeFetch({
      "acme/widgets": {
        pulls: () => ({ status: 200, body: [] }),
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(WS, q(), null);
    expect(res).toEqual({ ok: true, raw: "(no changes in window)" });
  });
});

describe("githubAdapter — request hygiene", () => {
  it("sends Authorization Bearer token, Accept and User-Agent headers, and an AbortSignal", async () => {
    const fetchMock = routeFetch({
      "acme/widgets": {
        pulls: () => ({ status: 200, body: [] }),
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await githubAdapter.query(WS, q(), null);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "agentrail-console",
    });
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  // FIX ROUND 1, FIX 3: GitHub's `created` search qualifier supports full
  // ISO-8601 timestamp precision (`created:2016-03-21T14:11:00Z..*`), not
  // date-only as this adapter's first draft incorrectly assumed — the
  // request now carries the raw windowStart/windowEnd verbatim.
  it("queries workflow runs with created=<full-iso>..<full-iso>, not date-only", async () => {
    const fetchMock = routeFetch({
      "acme/widgets": {
        pulls: () => ({ status: 200, body: [] }),
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await githubAdapter.query(
      WS,
      q({ windowStart: "2026-07-01T08:30:00.000Z", windowEnd: "2026-07-29T23:00:00.000Z" }),
      null
    );

    const runsCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/actions/runs"));
    const url = String(runsCall![0]);
    expect(url).toContain(encodeURIComponent("2026-07-01T08:30:00.000Z..2026-07-29T23:00:00.000Z"));
    // Not the old date-only shape.
    expect(url).not.toContain("created=2026-07-01..2026-07-29");
  });

  it("hits state=closed&sort=updated&direction=desc for the pulls endpoint", async () => {
    const fetchMock = routeFetch({
      "acme/widgets": {
        pulls: () => ({ status: 200, body: [] }),
        runs: () => ({ status: 200, body: { workflow_runs: [] } }),
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await githubAdapter.query(WS, q(), null);

    const pullsCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/pulls"));
    const url = String(pullsCall![0]);
    expect(url).toContain("state=closed");
    expect(url).toContain("sort=updated");
    expect(url).toContain("direction=desc");
  });
});

// FIX ROUND 1, FIX 3: belt-and-braces client-side re-filter on each run's
// own created_at, independent of the (corrected, full-precision) server-side
// `created` filter — this adapter has already been wrong once about
// GitHub's exact filtering behavior, so it does not trust the server alone.
describe("githubAdapter — FIX 3: client-side re-filter on workflow runs", () => {
  it("drops a same-day run outside an intraday window, even though the (mocked) server 'returned' it", async () => {
    global.fetch = routeFetch({
      "acme/widgets": {
        pulls: () => ({ status: 200, body: [] }),
        runs: () => ({
          status: 200,
          body: {
            workflow_runs: [
              // Same calendar date as the window, but outside its precise
              // intraday bounds — simulates the server returning something
              // the client must still filter out itself.
              run({ name: "late-night-job", created_at: "2026-07-29T22:00:00.000Z" }),
              run({ name: "on-time-job", created_at: "2026-07-29T12:00:00.000Z" }),
            ],
          },
        }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(
      WS,
      q({ windowStart: "2026-07-29T08:00:00.000Z", windowEnd: "2026-07-29T18:00:00.000Z" }),
      null
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("on-time-job");
    expect(res.raw).not.toContain("late-night-job");
  });

  it("keeps a run exactly at the intraday window bounds (inclusive)", async () => {
    global.fetch = routeFetch({
      "acme/widgets": {
        pulls: () => ({ status: 200, body: [] }),
        runs: () => ({
          status: 200,
          body: {
            workflow_runs: [
              run({ name: "at-start", created_at: "2026-07-29T08:00:00.000Z" }),
              run({ name: "at-end", created_at: "2026-07-29T18:00:00.000Z" }),
            ],
          },
        }),
      },
    }) as unknown as typeof fetch;

    const res = await githubAdapter.query(
      WS,
      q({ windowStart: "2026-07-29T08:00:00.000Z", windowEnd: "2026-07-29T18:00:00.000Z" }),
      null
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("at-start");
    expect(res.raw).toContain("at-end");
  });
});
