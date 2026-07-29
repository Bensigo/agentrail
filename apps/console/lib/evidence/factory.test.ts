import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors the failure-bundle route test's mocking idiom
// (`apps/console/app/api/v1/runner/failure-bundle/route.test.ts`) — mock the
// two packages' named exports directly rather than reaching for a real
// Postgres/ClickHouse connection.
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceRuns: vi.fn(),
  getWorkspaceQueueEntries: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  getFailuresForRun: vi.fn(),
  getRunEventsByRunId: vi.fn(),
}));

import { getWorkspaceRuns, getWorkspaceQueueEntries } from "@agentrail/db-postgres";
import { getFailuresForRun, getRunEventsByRunId } from "@agentrail/db-clickhouse";
import type { FailureEventRecord, TelemetryEventRecord } from "@agentrail/db-clickhouse";
import { factoryAdapter } from "./factory";
import { adapterFor } from "./registry";
import type { EvidenceQuery, EvidenceVerb } from "./types";

const mockGetRuns = vi.mocked(getWorkspaceRuns);
const mockGetQueueEntries = vi.mocked(getWorkspaceQueueEntries);
const mockGetFailures = vi.mocked(getFailuresForRun);
const mockGetEvents = vi.mocked(getRunEventsByRunId);

const WS = "00000000-0000-0000-0000-000000000001";
const WINDOW_START = "2026-07-29T00:00:00.000Z";
const WINDOW_END = "2026-07-29T01:00:00.000Z";

/**
 * Fix round 1, FIX 1: ClickHouse's `JSONEachRow` HTTP interface returns a
 * `DateTime64` column as a raw, timezone-less string — e.g.
 * `"2026-07-29 00:32:00.000"` — NOT a real `Date` instance, and NOT
 * ISO-8601 (no `T`, no `Z`), even though `FailureEventRecord`/
 * `TelemetryEventRecord` type `occurred_at` as `Date`. This converts a
 * normal ISO string into that exact raw shape (mirrors the fixtures in
 * `packages/db-clickhouse/src/queries.test.ts`, e.g. line 296:
 * `occurred_at: "2026-06-13 08:00:00.000"`) so these tests exercise the
 * SAME runtime shape production code actually sees — a `new Date(...)`
 * fixture here would silently hide the local-time mis-parse bug this fix
 * round addresses.
 */
function chTimestamp(iso: string): string {
  return iso.replace("T", " ").replace("Z", "");
}

function run(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "run-1",
    title: "fix pool sizing",
    status: "success",
    phase: null,
    branch: "fix/pool",
    agent: "claude",
    prUrl: null,
    costUsd: 0.5,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date("2026-07-29T00:30:00.000Z"),
    repositoryId: "repo-1",
    queueEntryId: null,
    updatedAt: null,
    lastLivenessAt: null,
    ...overrides,
  };
}

function queueEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "qe-1",
    externalId: "org/repo#42",
    title: "checkout 500s",
    state: "running",
    tier: 1,
    kind: "issue",
    createdAt: new Date("2026-07-28T00:00:00.000Z"),
    updatedAt: new Date("2026-07-29T00:00:00.000Z"),
    parkReason: null,
    blockedBy: [],
    remainingBudget: 5,
    estimatedBudgetUsd: null,
    ...overrides,
  };
}

// `occurred_at` defaults to the RAW ClickHouse string shape (see
// `chTimestamp`'s own doc-comment) — not a `Date` instance, matching what
// `getFailuresForRun`/`getRunEventsByRunId` actually hand back at runtime.
// `FailureEventRecord.occurred_at` is TYPED `Date` (the same inaccurate
// type declaration this fix round works around in production code) — cast
// through `unknown` so every mock call site can stay typed against the
// real interface without individually re-casting; `overrides` stays loosely
// typed so a test can freely override `occurred_at` with either shape.
function failureEvent(overrides: Partial<Record<string, unknown>> = {}): FailureEventRecord {
  return {
    workspace_id: WS,
    run_id: "run-1",
    repository_id: "repo-1",
    failure_type: "objective_gate",
    message: "AssertionError: expected 3 got 4",
    normalized_error: "",
    fingerprint: "",
    evidence: "",
    phase: "verify",
    severity: "error",
    occurred_at: chTimestamp("2026-07-29T00:32:00.000Z"),
    event_id: "fe-1",
    ...overrides,
  } as unknown as FailureEventRecord;
}

function telemetryEvent(overrides: Partial<Record<string, unknown>> = {}): TelemetryEventRecord {
  return {
    workspace_id: WS,
    repository_id: "repo-1",
    run_id: "run-1",
    agent: "claude",
    phase: "lifecycle",
    event_type: "gate_red",
    severity: "info",
    occurred_at: chTimestamp("2026-07-29T00:33:00.000Z"),
    event_id: "te-1",
    submission_kind: "final",
    payload: "{}",
    session_id: "s-1",
    seq: 1,
    ...overrides,
  } as unknown as TelemetryEventRecord;
}

function q(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return {
    verb: "changes",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    ...overrides,
  };
}

const TZ_ENV_KEY = "TZ";
const ORIGINAL_TZ = process.env[TZ_ENV_KEY];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRuns.mockResolvedValue({ rows: [], truncated: false });
  mockGetQueueEntries.mockResolvedValue({ rows: [], truncated: false });
  mockGetFailures.mockResolvedValue([]);
  mockGetEvents.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_TZ === undefined) delete process.env[TZ_ENV_KEY];
  else process.env[TZ_ENV_KEY] = ORIGINAL_TZ;
});

describe("factoryAdapter — shape", () => {
  it("declares provider 'factory' and verbs [changes, search_events]", () => {
    expect(factoryAdapter.provider).toBe("factory");
    expect(factoryAdapter.verbs).toEqual(["changes", "search_events"]);
  });

  it("self-registers into the shared registry on module load", () => {
    expect(adapterFor("factory")).toBe(factoryAdapter);
  });
});

describe("factoryAdapter — bad_request validation", () => {
  it("degrades bad_request on an unparseable windowStart, without ever touching a query source", async () => {
    const res = await factoryAdapter.query(WS, q({ windowStart: "not-a-date" }), null);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
    expect(mockGetRuns).not.toHaveBeenCalled();
  });

  it("degrades bad_request on an unparseable windowEnd", async () => {
    const res = await factoryAdapter.query(WS, q({ windowEnd: "not-a-date" }), null);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
  });

  it("degrades bad_request on an empty windowStart", async () => {
    const res = await factoryAdapter.query(WS, q({ windowStart: "" }), null);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
  });

  it("degrades bad_request for a verb this adapter does not declare", async () => {
    const res = await factoryAdapter.query(WS, q({ verb: "signals" as EvidenceVerb }), null);
    expect(res).toEqual({ ok: false, reason: "bad_request" });
  });
});

describe("factoryAdapter — secret is ignored (internal)", () => {
  it("produces the identical result whether secret is null or a non-null string", async () => {
    mockGetRuns.mockResolvedValue({ rows: [run()], truncated: false });
    const withNull = await factoryAdapter.query(WS, q(), null);
    const withSecret = await factoryAdapter.query(WS, q(), "some-secret-value");
    expect(withNull).toEqual(withSecret);
  });
});

describe("factoryAdapter — changes", () => {
  it("renders one line per run in window, stable field order, most recent first", async () => {
    mockGetRuns.mockResolvedValue({
      rows: [
        run({
          id: "run-1",
          status: "success",
          startedAt: new Date("2026-07-29T00:31:00.000Z"),
          finishedAt: new Date("2026-07-29T00:45:00.000Z"),
          prUrl: "https://github.com/org/repo/pull/42",
          createdAt: new Date("2026-07-29T00:30:00.000Z"),
          queueEntryId: "qe-1",
        }),
        run({
          id: "run-2",
          status: "failed",
          startedAt: new Date("2026-07-29T00:11:00.000Z"),
          finishedAt: null,
          prUrl: null,
          createdAt: new Date("2026-07-29T00:10:00.000Z"),
          queueEntryId: null,
        }),
      ],
      truncated: false,
    });
    mockGetQueueEntries.mockResolvedValue({ rows: [queueEntry({ id: "qe-1", externalId: "org/repo#42" })], truncated: false });

    const res = await factoryAdapter.query(WS, q({ verb: "changes" }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines).toHaveLength(2);
    // most recent first: run-1 (createdAt 00:30) before run-2 (00:10)
    expect(lines[0]).toBe(
      "run run-1 issue=#42 state=success started=2026-07-29T00:31:00.000Z finished=2026-07-29T00:45:00.000Z pr=https://github.com/org/repo/pull/42"
    );
    expect(lines[1]).toBe(
      "run run-2 issue=- state=failed started=2026-07-29T00:11:00.000Z finished=- pr=-"
    );
  });

  it("excludes a run whose createdAt falls outside [windowStart, windowEnd]", async () => {
    mockGetRuns.mockResolvedValue({
      rows: [
        run({ id: "in-window", createdAt: new Date("2026-07-29T00:30:00.000Z") }),
        run({ id: "before-window", createdAt: new Date("2026-07-28T23:00:00.000Z") }),
        run({ id: "after-window", createdAt: new Date("2026-07-29T02:00:00.000Z") }),
      ],
      truncated: false,
    });

    const res = await factoryAdapter.query(WS, q({ verb: "changes" }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("run in-window");
    expect(res.raw).not.toContain("before-window");
    expect(res.raw).not.toContain("after-window");
  });

  it("treats windowStart/windowEnd as inclusive bounds", async () => {
    mockGetRuns.mockResolvedValue({
      rows: [
        run({ id: "at-start", createdAt: new Date(WINDOW_START) }),
        run({ id: "at-end", createdAt: new Date(WINDOW_END) }),
      ],
      truncated: false,
    });
    const res = await factoryAdapter.query(WS, q({ verb: "changes" }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("run at-start");
    expect(res.raw).toContain("run at-end");
  });

  it("caps output at `limit ?? 50` rows, keeping the most recent", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      run({ id: `run-${i}`, createdAt: new Date(new Date(WINDOW_START).getTime() + i * 60_000) })
    );
    mockGetRuns.mockResolvedValue({ rows, truncated: false });

    const res = await factoryAdapter.query(WS, q({ verb: "changes", limit: 2 }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines).toHaveLength(2);
    // most recent first: run-4 (latest createdAt), then run-3
    expect(lines[0]).toContain("run run-4");
    expect(lines[1]).toContain("run run-3");
  });

  it("defaults the cap to 50 when limit is omitted", async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      run({ id: `run-${i}`, createdAt: new Date(new Date(WINDOW_START).getTime() + i * 1_000) })
    );
    mockGetRuns.mockResolvedValue({ rows, truncated: false });

    const res = await factoryAdapter.query(WS, q({ verb: "changes" }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(50);
  });

  it("resolves issue=#<n> by joining the run's queueEntryId against queue_entries.externalId", async () => {
    mockGetRuns.mockResolvedValue({
      rows: [run({ id: "run-1", queueEntryId: "qe-7" })],
      truncated: false,
    });
    mockGetQueueEntries.mockResolvedValue({
      rows: [queueEntry({ id: "qe-7", externalId: "Bensigo/agentrail#1468" })],
      truncated: false,
    });
    const res = await factoryAdapter.query(WS, q({ verb: "changes" }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toContain("issue=#1468");
  });

  it("renders issue=- when the run has no queueEntryId, or the queue entry can't be found, or its externalId carries no trailing #N", async () => {
    mockGetRuns.mockResolvedValue({
      rows: [
        run({ id: "no-queue-entry", queueEntryId: null }),
        run({ id: "dangling-queue-entry", queueEntryId: "missing-qe" }),
        run({ id: "legacy-cli-entry", queueEntryId: "qe-legacy" }),
      ],
      truncated: false,
    });
    mockGetQueueEntries.mockResolvedValue({
      rows: [queueEntry({ id: "qe-legacy", externalId: "42" })], // no leading owner/repo#
      truncated: false,
    });
    const res = await factoryAdapter.query(WS, q({ verb: "changes" }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    for (const line of res.raw.split("\n")) {
      expect(line).toContain("issue=-");
    }
  });

  it("honest empty marker when zero runs are in window", async () => {
    mockGetRuns.mockResolvedValue({ rows: [], truncated: false });
    const res = await factoryAdapter.query(WS, q({ verb: "changes" }), null);
    expect(res).toEqual({ ok: true, raw: "(no runs in window)" });
    expect(mockGetQueueEntries).not.toHaveBeenCalled();
  });

  it("honest empty marker when runs exist but none fall in window", async () => {
    mockGetRuns.mockResolvedValue({
      rows: [run({ id: "far-away", createdAt: new Date("2020-01-01T00:00:00.000Z") })],
      truncated: false,
    });
    const res = await factoryAdapter.query(WS, q({ verb: "changes" }), null);
    expect(res).toEqual({ ok: true, raw: "(no runs in window)" });
  });

  // Fold-in A: limit clamped to >= 1 so limit:0 (or negative) can't slice a
  // non-empty candidate set down to a bare "" that bypasses the honest-empty
  // marker (searchInvestigations' Math.max(1, ...) clamp, mirrored).
  it("fold-in A: limit:0 still returns at least one line rather than a bare empty string", async () => {
    mockGetRuns.mockResolvedValue({
      rows: [run({ id: "run-1" }), run({ id: "run-2", createdAt: new Date("2026-07-29T00:10:00.000Z") })],
      truncated: false,
    });
    const res = await factoryAdapter.query(WS, q({ verb: "changes", limit: 0 }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).not.toBe("");
    const lines = res.raw.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines).toHaveLength(1);
  });
});

describe("factoryAdapter — changes — horizon caveat on the zero-match marker (Fix round 1, FIX 2)", () => {
  it("appends the horizon caveat when the fetch was truncated AND the oldest fetched run is still newer than windowStart (there may be earlier matches never fetched)", async () => {
    mockGetRuns.mockResolvedValue({
      // The only fetched run is well AFTER the window and AFTER windowStart —
      // even though it's the "oldest" thing this fetch saw, that oldest point
      // never reaches back to windowStart, so the window's true content is
      // unknown, not "empty".
      rows: [run({ id: "recent-only", createdAt: new Date("2026-07-29T05:00:00.000Z") })],
      truncated: true,
    });
    const res = await factoryAdapter.query(WS, q({ verb: "changes" }), null);
    expect(res).toEqual({
      ok: true,
      raw: "(no runs found in window — note: only the 200 most recent runs were searched and the window extends earlier)",
    });
  });

  it("does NOT append the caveat when truncated but the oldest fetched run already reaches back to/past windowStart (the window IS fully covered)", async () => {
    mockGetRuns.mockResolvedValue({
      // Oldest fetched run is BEFORE windowStart — the fetch's horizon
      // already covers the entire requested window, so a plain "not found"
      // is still an accurate, complete claim despite truncated:true.
      rows: [run({ id: "reaches-past-window-start", createdAt: new Date("2026-07-28T00:00:00.000Z") })],
      truncated: true,
    });
    const res = await factoryAdapter.query(WS, q({ verb: "changes" }), null);
    expect(res).toEqual({ ok: true, raw: "(no runs in window)" });
  });

  it("does NOT append the caveat when truncated+horizon-uncertain but matches DO exist (only zero-match paths get the caveat)", async () => {
    mockGetRuns.mockResolvedValue({
      rows: [
        run({ id: "in-window", createdAt: new Date("2026-07-29T00:30:00.000Z") }),
        // This second row is what makes the fetch's horizon "uncertain" (its
        // createdAt is still after windowStart) — but since a genuine match
        // already exists, no caveat should be appended.
        run({ id: "also-recent", createdAt: new Date("2026-07-29T00:40:00.000Z") }),
      ],
      truncated: true,
    });
    const res = await factoryAdapter.query(WS, q({ verb: "changes" }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).not.toContain("note:");
    expect(res.raw).toContain("run in-window");
  });

  it("does NOT append the caveat when not truncated at all, regardless of oldest fetched createdAt", async () => {
    mockGetRuns.mockResolvedValue({
      rows: [run({ id: "only-run", createdAt: new Date("2026-07-29T05:00:00.000Z") })],
      truncated: false,
    });
    const res = await factoryAdapter.query(WS, q({ verb: "changes" }), null);
    expect(res).toEqual({ ok: true, raw: "(no runs in window)" });
  });
});

describe("factoryAdapter — search_events", () => {
  it("merges failure_events + run_events across in-window runs, chronological order", async () => {
    mockGetRuns.mockResolvedValue({
      rows: [
        run({ id: "run-1", createdAt: new Date("2026-07-29T00:30:00.000Z") }),
        run({ id: "run-2", createdAt: new Date("2026-07-29T00:10:00.000Z") }),
      ],
      truncated: false,
    });
    mockGetFailures.mockImplementation(async (_ws, runId) =>
      runId === "run-1"
        ? [failureEvent({ run_id: "run-1", occurred_at: chTimestamp("2026-07-29T00:32:00.000Z") })]
        : []
    );
    mockGetEvents.mockImplementation(async (_ws, runId) =>
      runId === "run-1"
        ? [telemetryEvent({ run_id: "run-1", occurred_at: chTimestamp("2026-07-29T00:33:00.000Z") })]
        : [
            telemetryEvent({
              run_id: "run-2",
              event_type: "claimed",
              phase: "setup",
              occurred_at: chTimestamp("2026-07-29T00:12:00.000Z"),
            }),
          ]
    );

    const res = await factoryAdapter.query(WS, q({ verb: "search_events" }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines).toHaveLength(3);
    // chronological (ascending): run-2 claimed (00:12) < run-1 failure (00:32) < run-1 gate_red (00:33)
    expect(lines[0]).toContain("run=run-2");
    expect(lines[0]).toContain("event_type=claimed");
    expect(lines[1]).toContain("run=run-1");
    expect(lines[1]).toContain("failure_type=objective_gate");
    expect(lines[2]).toContain("run=run-1");
    expect(lines[2]).toContain("event_type=gate_red");
    // timestamp + run id + event text
    expect(lines[0]).toMatch(/^2026-07-29T00:12:00\.000Z run=run-2/);
  });

  it("filters by substring match on q.query, case-insensitively, against the rendered line", async () => {
    mockGetRuns.mockResolvedValue({ rows: [run({ id: "run-1" })], truncated: false });
    mockGetFailures.mockResolvedValue([failureEvent({ message: "AssertionError: expected 3 got 4" })]);
    mockGetEvents.mockResolvedValue([telemetryEvent({ event_type: "gate_red" })]);

    const res = await factoryAdapter.query(WS, q({ verb: "search_events", query: "assertionerror" }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("AssertionError");
  });

  it("honest empty marker when zero runs are in window", async () => {
    mockGetRuns.mockResolvedValue({ rows: [], truncated: false });
    const res = await factoryAdapter.query(WS, q({ verb: "search_events" }), null);
    expect(res).toEqual({ ok: true, raw: "(no matching events)" });
    expect(mockGetFailures).not.toHaveBeenCalled();
  });

  it("honest empty marker when runs are in window but have no events at all", async () => {
    mockGetRuns.mockResolvedValue({ rows: [run({ id: "run-1" })], truncated: false });
    mockGetFailures.mockResolvedValue([]);
    mockGetEvents.mockResolvedValue([]);
    const res = await factoryAdapter.query(WS, q({ verb: "search_events" }), null);
    expect(res).toEqual({ ok: true, raw: "(no matching events)" });
  });

  it("honest empty marker when events exist but none match q.query", async () => {
    mockGetRuns.mockResolvedValue({ rows: [run({ id: "run-1" })], truncated: false });
    mockGetFailures.mockResolvedValue([failureEvent({ message: "pool exhausted" })]);
    mockGetEvents.mockResolvedValue([]);
    const res = await factoryAdapter.query(WS, q({ verb: "search_events", query: "totally-unrelated-term" }), null);
    expect(res).toEqual({ ok: true, raw: "(no matching events)" });
  });

  it("caps output at `limit ?? 200` lines pre-envelope, keeping the most recent, still chronological", async () => {
    mockGetRuns.mockResolvedValue({ rows: [run({ id: "run-1" })], truncated: false });
    mockGetFailures.mockResolvedValue([]);
    mockGetEvents.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) =>
        telemetryEvent({
          event_type: `event-${i}`,
          occurred_at: chTimestamp(new Date(new Date("2026-07-29T00:10:00.000Z").getTime() + i * 60_000).toISOString()),
        })
      )
    );

    const res = await factoryAdapter.query(WS, q({ verb: "search_events", limit: 2 }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines).toHaveLength(2);
    // still chronological, but only the two MOST RECENT survive the cap
    expect(lines[0]).toContain("event_type=event-3");
    expect(lines[1]).toContain("event_type=event-4");
  });

  it("defaults the cap to 200 when limit is omitted", async () => {
    mockGetRuns.mockResolvedValue({ rows: [run({ id: "run-1" })], truncated: false });
    mockGetFailures.mockResolvedValue([]);
    mockGetEvents.mockResolvedValue(
      Array.from({ length: 210 }, (_, i) =>
        telemetryEvent({
          event_type: `event-${i}`,
          occurred_at: chTimestamp(new Date(new Date("2026-07-29T00:00:00.000Z").getTime() + i * 1_000).toISOString()),
        })
      )
    );
    const res = await factoryAdapter.query(WS, q({ verb: "search_events" }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(200);
  });

  it("collapses an embedded newline in a free-text field so 'one event per line' always holds", async () => {
    mockGetRuns.mockResolvedValue({ rows: [run({ id: "run-1" })], truncated: false });
    mockGetFailures.mockResolvedValue([failureEvent({ message: "line one\nline two" })]);
    mockGetEvents.mockResolvedValue([]);
    const res = await factoryAdapter.query(WS, q({ verb: "search_events" }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw.split("\n")).toHaveLength(1);
    expect(res.raw).toContain("line one line two");
  });

  // Fold-in A: same clamp as `changes` — see that describe block's identical test.
  it("fold-in A: limit:0 still returns at least one line rather than a bare empty string", async () => {
    mockGetRuns.mockResolvedValue({ rows: [run({ id: "run-1" })], truncated: false });
    mockGetFailures.mockResolvedValue([]);
    mockGetEvents.mockResolvedValue([
      telemetryEvent({ event_type: "a", occurred_at: chTimestamp("2026-07-29T00:10:00.000Z") }),
      telemetryEvent({ event_type: "b", occurred_at: chTimestamp("2026-07-29T00:20:00.000Z") }),
    ]);
    const res = await factoryAdapter.query(WS, q({ verb: "search_events", limit: 0 }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).not.toBe("");
    const lines = res.raw.split("\n");
    expect(lines).toHaveLength(1);
    // clamped to 1, keeping the most recent per the tail-keeping cap rule
    expect(lines[0]).toContain("event_type=b");
  });

  // Fold-in B: bounding the fan-in to batches of 10 must not drop, duplicate,
  // or reorder events — 25 runs forces 3 batches (10 + 10 + 5).
  it("fold-in B: batching the per-run fan-out (25 runs, 3 batches of <=10) preserves every event and chronological order", async () => {
    const runCount = 25;
    mockGetRuns.mockResolvedValue({
      rows: Array.from({ length: runCount }, (_, i) =>
        run({ id: `run-${i}`, createdAt: new Date(new Date(WINDOW_START).getTime() + i * 1_000) })
      ),
      truncated: false,
    });
    mockGetFailures.mockResolvedValue([]);
    mockGetEvents.mockImplementation(async (_ws, runId) => {
      const i = Number((runId as string).replace("run-", ""));
      return [
        telemetryEvent({
          run_id: runId,
          event_type: `event-${i}`,
          occurred_at: chTimestamp(new Date(new Date(WINDOW_START).getTime() + i * 1_000).toISOString()),
        }),
      ];
    });

    const res = await factoryAdapter.query(WS, q({ verb: "search_events", limit: runCount }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines).toHaveLength(runCount);
    // Chronological end-to-end across the batch boundary (batch 1: runs
    // 0-9, batch 2: runs 10-19, batch 3: runs 20-24) — event-0 first,
    // event-24 last, nothing dropped or reordered.
    expect(lines[0]).toContain("event_type=event-0");
    expect(lines[runCount - 1]).toContain("event_type=event-24");
    for (let i = 0; i < runCount; i++) {
      expect(lines[i]).toContain(`event_type=event-${i}`);
    }
  });
});

describe("factoryAdapter — search_events — horizon caveat on the zero-match marker (Fix round 1, FIX 2)", () => {
  it("appends the horizon caveat when the fetch was truncated AND the oldest fetched run is still newer than windowStart", async () => {
    mockGetRuns.mockResolvedValue({
      rows: [run({ id: "recent-only", createdAt: new Date("2026-07-29T05:00:00.000Z") })],
      truncated: true,
    });
    const res = await factoryAdapter.query(WS, q({ verb: "search_events" }), null);
    expect(res).toEqual({
      ok: true,
      raw: "(no matching events — note: only the 200 most recent runs were searched and the window extends earlier)",
    });
    expect(mockGetFailures).not.toHaveBeenCalled();
  });

  it("does NOT append the caveat when truncated but the oldest fetched run already reaches back to/past windowStart", async () => {
    mockGetRuns.mockResolvedValue({
      rows: [run({ id: "reaches-past-window-start", createdAt: new Date("2026-07-28T00:00:00.000Z") })],
      truncated: true,
    });
    const res = await factoryAdapter.query(WS, q({ verb: "search_events" }), null);
    expect(res).toEqual({ ok: true, raw: "(no matching events)" });
  });

  it("appends the caveat even when runs ARE in window but their events don't match — the fetch horizon, not the run match, drives it", async () => {
    mockGetRuns.mockResolvedValue({
      rows: [
        run({ id: "in-window", createdAt: new Date("2026-07-29T00:30:00.000Z") }),
        run({ id: "also-recent", createdAt: new Date("2026-07-29T00:40:00.000Z") }),
      ],
      truncated: true,
    });
    mockGetFailures.mockResolvedValue([]);
    mockGetEvents.mockResolvedValue([]);
    const res = await factoryAdapter.query(WS, q({ verb: "search_events" }), null);
    expect(res).toEqual({
      ok: true,
      raw: "(no matching events — note: only the 200 most recent runs were searched and the window extends earlier)",
    });
  });
});

describe("factoryAdapter — search_events — ClickHouse raw-string timestamp normalization (Fix round 1, FIX 1)", () => {
  it("parses ClickHouse's raw, timezone-less occurred_at as UTC, not local time — forced under TZ=America/New_York to prove it's TZ-independent", async () => {
    process.env[TZ_ENV_KEY] = "America/New_York";
    mockGetRuns.mockResolvedValue({ rows: [run({ id: "run-1" })], truncated: false });
    // Raw ClickHouse shape: no "T", no "Z" — exactly what result.json<T>()
    // hands back for a DateTime64 column.
    mockGetFailures.mockResolvedValue([failureEvent({ occurred_at: "2026-07-29 00:32:00.000" })]);
    mockGetEvents.mockResolvedValue([]);

    const res = await factoryAdapter.query(WS, q({ verb: "search_events" }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const lines = res.raw.split("\n");
    expect(lines).toHaveLength(1);
    // Must render as the exact UTC instant — a pre-fix build parses this as
    // LOCAL time under a non-UTC TZ and would render 2026-07-29T04:32:00.000Z
    // (America/New_York is UTC-4 in July) instead.
    expect(lines[0]).toMatch(/^2026-07-29T00:32:00\.000Z run=run-1/);
  });

  it("also renders correctly for a run_event's raw occurred_at (same normalization path)", async () => {
    process.env[TZ_ENV_KEY] = "America/New_York";
    mockGetRuns.mockResolvedValue({ rows: [run({ id: "run-1" })], truncated: false });
    mockGetFailures.mockResolvedValue([]);
    mockGetEvents.mockResolvedValue([telemetryEvent({ occurred_at: "2026-07-29 00:33:00.000" })]);

    const res = await factoryAdapter.query(WS, q({ verb: "search_events" }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toMatch(/^2026-07-29T00:33:00\.000Z run=run-1/);
  });

  it("passes through a real Date instance unchanged (defensive — not the runtime shape, but the type contract allows it)", async () => {
    mockGetRuns.mockResolvedValue({ rows: [run({ id: "run-1" })], truncated: false });
    mockGetFailures.mockResolvedValue([failureEvent({ occurred_at: new Date("2026-07-29T00:32:00.000Z") })]);
    mockGetEvents.mockResolvedValue([]);

    const res = await factoryAdapter.query(WS, q({ verb: "search_events" }), null);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.raw).toMatch(/^2026-07-29T00:32:00\.000Z run=run-1/);
  });
});
