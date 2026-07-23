import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * #1388 — `reconcileStaleRuns` keys reclaim on execution-LIVENESS staleness
 * (with the pre-#1388 wall-clock sweep preserved as a backward-compatible
 * fallback), and `recordRunnerLiveness` stamps the in-flight run/entry.
 *
 * Both are raw-SQL query fns, so we mock `../db.js`, capture the exact SQL each
 * emits, and render it with the real PgDialect to assert on its shape — the
 * same approach as `claim-queue-entry-work-item.test.ts`.
 */

const mockState = vi.hoisted(() => ({
  capturedQueries: [] as unknown[],
  // What the FIRST db.execute (the runs UPDATE ... RETURNING) resolves to.
  firstRows: [] as unknown[],
}));

vi.mock("../db.js", () => ({
  db: {
    execute: async (q: unknown) => {
      mockState.capturedQueries.push(q);
      // Only the first execute in each fn is a RETURNING we read; the rest are
      // fire-and-forget UPDATEs whose result is ignored beyond `.length`.
      return mockState.capturedQueries.length === 1 ? mockState.firstRows : [];
    },
  },
}));

import {
  reconcileStaleRuns,
  recordRunnerLiveness,
  LIVENESS_STALENESS_SECONDS,
  STALE_RUN_MINUTES,
} from "../queries/runner.js";

// Lower-cased so assertions are robust to SQL-keyword casing (the template
// literals write UPDATE/WHERE/IS NOT NULL in caps; column names + string
// literals are already lower-case).
const render = (q: unknown) =>
  new PgDialect().sqlToQuery(q as never).sql.toLowerCase();

beforeEach(() => {
  mockState.capturedQueries = [];
  mockState.firstRows = [];
});

describe("reconcileStaleRuns — liveness-aware runs sweep", () => {
  it("reclaims a run on liveness staleness, and falls back to wall-clock when it never pinged", async () => {
    await reconcileStaleRuns("ws-1");
    const runsSql = render(mockState.capturedQueries[0]);
    // Liveness branch: a run that HAS pinged is gated on last_liveness_at.
    expect(runsSql).toContain("last_liveness_at");
    expect(runsSql).toContain("is not null");
    expect(runsSql).toContain("seconds"); // liveness-staleness interval
    // Fallback branch: a run that never pinged uses the wall-clock started_at
    // sweep, exactly as before #1388.
    expect(runsSql).toContain("started_at");
    expect(runsSql).toContain("minutes");
    expect(runsSql).toContain("failed");
  });

  it("mirrors the same liveness-vs-wall-clock split onto the queue_entries sweep", async () => {
    await reconcileStaleRuns("ws-1");
    const queueSql = render(mockState.capturedQueries[1]);
    expect(queueSql).toContain("queue_entries");
    expect(queueSql).toContain("last_liveness_at");
    expect(queueSql).toContain("seconds"); // liveness path
    expect(queueSql).toContain("updated_at"); // wall-clock fallback
    expect(queueSql).toContain("'queued'");
  });

  it("uses distinct windows: liveness seconds and a wall-clock minutes fallback that is larger", async () => {
    // The staleness window (liveness) and fallback (wall-clock) are genuinely
    // different magnitudes — the liveness path reclaims in minutes, the fallback
    // stays at the old 90-min ceiling-exceeding window.
    expect(LIVENESS_STALENESS_SECONDS).toBeLessThan(STALE_RUN_MINUTES * 60);
  });
});

describe("recordRunnerLiveness — stamps in-flight run + entry", () => {
  it("stamps last_liveness_at on runs and queue_entries, only while running", async () => {
    mockState.firstRows = [{ id: "qe-1" }];
    const result = await recordRunnerLiveness({ id: "qe-1", workspaceId: "ws-1" });
    expect(result.updated).toBe(true);

    const runsSql = render(mockState.capturedQueries[0]);
    expect(runsSql).toContain("update");
    expect(runsSql).toContain("runs");
    expect(runsSql).toContain("last_liveness_at");
    expect(runsSql).toContain("'running'");

    const queueSql = render(mockState.capturedQueries[1]);
    expect(queueSql).toContain("queue_entries");
    expect(queueSql).toContain("last_liveness_at");
    expect(queueSql).toContain("'running'");
  });

  it("reports updated=false when no running run matched (already terminal / unknown id)", async () => {
    mockState.firstRows = []; // RETURNING came back empty
    const result = await recordRunnerLiveness({ id: "gone", workspaceId: "ws-1" });
    expect(result.updated).toBe(false);
  });
});
