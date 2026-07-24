import { describe, it, expect, vi, beforeEach } from "vitest";

// getInstallationToken is mocked as a unit — its own mint/mint-failure paths are
// covered by github-app-token.test.ts. This file only exercises
// reconcileRunsCiStatus's own throttle/best-effort logic against a token that's
// either present or null.
vi.mock("../queries/github-app-token.js", () => ({
  getInstallationToken: vi.fn(),
}));

import { getInstallationToken } from "../queries/github-app-token.js";
import {
  parsePrUrl,
  reconcileRunDisplayStatus,
  rollupCheckRuns,
  fetchPrCiConclusion,
  reconcileRunsCiStatus,
  type CiConclusion,
} from "../queries/ci-reconcile.js";

/** A fake `fetch` returning the given JSON for a 200, keyed by URL substring. */
function fakeFetch(
  routes: Array<{ match: string; ok?: boolean; status?: number; json?: unknown }>
) {
  return vi.fn(async (url: string) => {
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: route.ok ?? true,
      status: route.status ?? 200,
      json: async () => route.json,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// parsePrUrl
// ---------------------------------------------------------------------------
describe("parsePrUrl", () => {
  it("parses a canonical PR url into owner/repo/number", () => {
    expect(parsePrUrl("https://github.com/Bensigo/agentrail/pull/906")).toEqual({
      owner: "Bensigo",
      repo: "agentrail",
      number: 906,
    });
  });

  it("tolerates trailing path/query/fragment", () => {
    expect(
      parsePrUrl("https://github.com/o/r/pull/12/files?w=1")
    ).toEqual({ owner: "o", repo: "r", number: 12 });
  });

  it("returns null for empty / non-PR / non-github urls", () => {
    expect(parsePrUrl("")).toBeNull();
    expect(parsePrUrl(null)).toBeNull();
    expect(parsePrUrl(undefined)).toBeNull();
    expect(parsePrUrl("https://github.com/o/r/issues/3")).toBeNull();
    expect(parsePrUrl("https://example.com/o/r/pull/3")).toBeNull();
    expect(parsePrUrl("https://github.com/o/r/pull/0")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reconcileRunDisplayStatus — the PURE AC mapping (issue verification evidence)
// ---------------------------------------------------------------------------
describe("reconcileRunDisplayStatus (pure AC mapping)", () => {
  const PR = "https://github.com/o/r/pull/1";

  it("AC1: failed gate + green CI → success (PR-ready), overriding the red gate", () => {
    expect(
      reconcileRunDisplayStatus({
        gateStatus: "failed",
        prUrl: PR,
        ciConclusion: "green",
      })
    ).toBe("success");
  });

  it("AC2: failed gate + NO PR → still failed (no false green)", () => {
    expect(
      reconcileRunDisplayStatus({
        gateStatus: "failed",
        prUrl: null,
        ciConclusion: "green", // even a green signal can't help: no PR to trust
      })
    ).toBe("failed");
  });

  it("AC2: failed gate + red CI → still failed", () => {
    expect(
      reconcileRunDisplayStatus({
        gateStatus: "failed",
        prUrl: PR,
        ciConclusion: "red",
      })
    ).toBe("failed");
  });

  it("AC2: failed gate + no CI signal (null) → still failed (never invents green)", () => {
    expect(
      reconcileRunDisplayStatus({
        gateStatus: "failed",
        prUrl: PR,
        ciConclusion: null,
      })
    ).toBe("failed");
  });

  it("AC4: failed gate + pending CI → running (in-progress), NOT terminal failed", () => {
    expect(
      reconcileRunDisplayStatus({
        gateStatus: "failed",
        prUrl: PR,
        ciConclusion: "pending",
      })
    ).toBe("running");
  });

  it("never demotes a non-failed run (success/running/queued returned unchanged)", () => {
    for (const s of ["success", "running", "queued"] as const) {
      expect(
        reconcileRunDisplayStatus({
          gateStatus: s,
          prUrl: PR,
          ciConclusion: "red",
        })
      ).toBe(s);
    }
  });
});

// ---------------------------------------------------------------------------
// rollupCheckRuns — check-run list → CiConclusion
// ---------------------------------------------------------------------------
describe("rollupCheckRuns", () => {
  it("zero checks → null (no signal)", () => {
    expect(rollupCheckRuns([])).toBeNull();
  });

  it("all completed+success → green", () => {
    expect(
      rollupCheckRuns([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "skipped" },
        { status: "completed", conclusion: "neutral" },
      ])
    ).toBe("green");
  });

  it("any non-completed check → pending", () => {
    expect(
      rollupCheckRuns([
        { status: "completed", conclusion: "success" },
        { status: "in_progress", conclusion: null },
      ])
    ).toBe("pending");
  });

  it("a hard failure → red, even alongside a still-pending check", () => {
    expect(
      rollupCheckRuns([
        { status: "in_progress", conclusion: null },
        { status: "completed", conclusion: "failure" },
      ])
    ).toBe("red");
  });

  it("treats timed_out/cancelled as red", () => {
    expect(
      rollupCheckRuns([{ status: "completed", conclusion: "timed_out" }])
    ).toBe("red");
  });
});

// ---------------------------------------------------------------------------
// fetchPrCiConclusion — best-effort GitHub fetch (faked)
// ---------------------------------------------------------------------------
describe("fetchPrCiConclusion (faked fetch)", () => {
  const PR = { owner: "o", repo: "r", number: 1 };

  it("green: resolves head sha then rolls up passing check-runs", async () => {
    const f = fakeFetch([
      { match: "/pulls/1", json: { head: { sha: "abc" } } },
      {
        match: "/commits/abc/check-runs",
        json: { check_runs: [{ status: "completed", conclusion: "success" }] },
      },
    ]);
    expect(await fetchPrCiConclusion(PR, "tok", f)).toBe("green");
  });

  it("red: a failed check-run rolls up to red", async () => {
    const f = fakeFetch([
      { match: "/pulls/1", json: { head: { sha: "abc" } } },
      {
        match: "/commits/abc/check-runs",
        json: { check_runs: [{ status: "completed", conclusion: "failure" }] },
      },
    ]);
    expect(await fetchPrCiConclusion(PR, "tok", f)).toBe("red");
  });

  it("pending: an in-progress check rolls up to pending", async () => {
    const f = fakeFetch([
      { match: "/pulls/1", json: { head: { sha: "abc" } } },
      {
        match: "/commits/abc/check-runs",
        json: { check_runs: [{ status: "queued", conclusion: null }] },
      },
    ]);
    expect(await fetchPrCiConclusion(PR, "tok", f)).toBe("pending");
  });

  it("best-effort: a non-2xx PR fetch resolves null, never throws", async () => {
    const f = fakeFetch([{ match: "/pulls/1", ok: false, status: 404 }]);
    await expect(fetchPrCiConclusion(PR, "tok", f)).resolves.toBeNull();
  });

  it("best-effort: a thrown network error resolves null, never throws", async () => {
    const f = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(fetchPrCiConclusion(PR, "tok", f)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reconcileRunsCiStatus — wired read-path enricher (throttle + best-effort)
// ---------------------------------------------------------------------------
describe("reconcileRunsCiStatus (wiring)", () => {
  function withToken(token: string | null) {
    vi.mocked(getInstallationToken).mockResolvedValue(token);
  }

  it("overrides only the failed-with-PR run whose CI is green; leaves others", async () => {
    withToken("ghs_tok");
    const f = fakeFetch([
      { match: "/pulls/7", json: { head: { sha: "s7" } } },
      {
        match: "/commits/s7/check-runs",
        json: { check_runs: [{ status: "completed", conclusion: "success" }] },
      },
    ]);
    const result = await reconcileRunsCiStatus(
      "ws-1",
      [
        { id: "failed-green", status: "failed", prUrl: "https://github.com/o/r/pull/7" },
        { id: "already-success", status: "success", prUrl: "https://github.com/o/r/pull/8" },
        { id: "failed-no-pr", status: "failed", prUrl: null },
      ],
      { fetchImpl: f }
    );
    expect(result.get("failed-green")).toBe("success");
    expect(result.has("already-success")).toBe(false); // skipped — not failed
    expect(result.has("failed-no-pr")).toBe(false); // skipped — no PR
    // Only the one reconcilable run triggered GitHub calls (2: pull + check-runs).
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("makes ZERO github calls when no run needs reconciling", async () => {
    withToken("ghs_tok");
    const f = vi.fn() as unknown as typeof fetch;
    const result = await reconcileRunsCiStatus(
      "ws-1",
      [
        { id: "ok", status: "success", prUrl: "https://github.com/o/r/pull/1" },
        { id: "run", status: "running", prUrl: null },
      ],
      { fetchImpl: f }
    );
    expect(result.size).toBe(0);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("best-effort: no github token → empty override, no fetch", async () => {
    withToken(null);
    const f = vi.fn() as unknown as typeof fetch;
    const result = await reconcileRunsCiStatus(
      "ws-1",
      [{ id: "x", status: "failed", prUrl: "https://github.com/o/r/pull/1" }],
      { fetchImpl: f }
    );
    expect(result.size).toBe(0);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("throttles fetched runs to maxFetches", async () => {
    withToken("ghs_tok");
    let pullCalls = 0;
    const f = vi.fn(async (url: string) => {
      if (url.includes("/pulls/")) pullCalls++;
      const json = url.includes("/pulls/")
        ? { head: { sha: "s" } }
        : { check_runs: [{ status: "completed", conclusion: "failure" }] };
      return { ok: true, status: 200, json: async () => json } as unknown as Response;
    }) as unknown as typeof fetch;

    const runs = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`,
      status: "failed" as const,
      prUrl: `https://github.com/o/r/pull/${i + 1}`,
    }));
    await reconcileRunsCiStatus("ws-1", runs, { fetchImpl: f, maxFetches: 2 });
    expect(pullCalls).toBe(2); // only 2 of 5 candidates were fetched
  });

  it("red CI keeps the run failed (no override emitted)", async () => {
    withToken("ghs_tok");
    const f = fakeFetch([
      { match: "/pulls/1", json: { head: { sha: "s" } } },
      {
        match: "/commits/s/check-runs",
        json: { check_runs: [{ status: "completed", conclusion: "failure" }] },
      },
    ]);
    const result = await reconcileRunsCiStatus(
      "ws-1",
      [{ id: "x", status: "failed", prUrl: "https://github.com/o/r/pull/1" }],
      { fetchImpl: f }
    );
    // failed → failed is unchanged, so nothing is emitted into the override map.
    expect(result.has("x")).toBe(false);
  });

  it("pending CI overrides failed → running (AC4) via the wired path", async () => {
    withToken("ghs_tok");
    const f = fakeFetch([
      { match: "/pulls/1", json: { head: { sha: "s" } } },
      {
        match: "/commits/s/check-runs",
        json: { check_runs: [{ status: "in_progress", conclusion: null }] },
      },
    ]);
    const result = await reconcileRunsCiStatus(
      "ws-1",
      [{ id: "x", status: "failed", prUrl: "https://github.com/o/r/pull/1" }],
      { fetchImpl: f }
    );
    expect(result.get("x")).toBe("running");
  });
});

// Type-only assertion that CiConclusion stays the closed set we map over.
const _exhaustive: CiConclusion[] = ["green", "red", "pending", null];
void _exhaustive;
