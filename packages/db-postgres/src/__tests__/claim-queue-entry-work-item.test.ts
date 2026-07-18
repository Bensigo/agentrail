import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * #1275 (estimate→enforcement threading, PR②): `claimQueueEntry`'s RETURNING
 * clause and the WorkItem it builds from that row must carry
 * `estimated_budget_usd` / `model_override` through — dormant (null) on every
 * entry today, but the wire contract has to exist before #1274's
 * brief-generation lane can start writing values.
 *
 * `claimQueueEntry` makes several db calls in sequence:
 *   1-2. `reconcileStaleRuns`'s two best-effort sweep UPDATEs (result unused
 *        beyond `.length`, so an empty array satisfies both).
 *   3. The claim's own `UPDATE ... RETURNING` — the one this suite cares about.
 *   4. `deriveRepoSlug`'s `connectors` lookup (`db.select`) — only reached
 *      because the crafted `external_id` below has no parseable owner/name
 *      slug, so it falls through to the connector-config lookup.
 *   5. The unconditional `runs` upsert (`db.insert(...).onConflictDoUpdate`)
 *      — `findOrCreateRepository`'s OWN insert is skipped entirely because
 *      the resolved slug is "" (empty), which is what keeps this mock small.
 */

const mockState = vi.hoisted(() => ({
  executeCalls: 0,
  // What the 3rd `db.execute` call (the claim UPDATE...RETURNING) resolves
  // to. Undefined by default (nothing claimable); set per-test.
  claimRow: undefined as Record<string, unknown> | undefined,
  capturedQueries: [] as unknown[],
}));

vi.mock("../db.js", () => ({
  db: {
    execute: async (q: unknown) => {
      mockState.executeCalls += 1;
      mockState.capturedQueries.push(q);
      if (mockState.executeCalls <= 2) return []; // reconcileStaleRuns sweeps
      return mockState.claimRow ? [mockState.claimRow] : [];
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [], // no GitHub connector configured
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: async () => undefined,
      }),
    }),
  },
}));

import { claimQueueEntry } from "../queries/runner.js";

const render = (q: unknown) => new PgDialect().sqlToQuery(q as never).sql;

const BASE_ROW = {
  id: "qe-1",
  workspace_id: "ws-1",
  source: "cli",
  kind: "issue",
  // No owner/name slug and no URL — deriveRepoSlug falls through to the
  // (mocked, empty) connectors lookup rather than touching `repositories`.
  external_id: "cli-local-42",
  title: "Fix it",
  body: "body",
  tier: 0,
};

beforeEach(() => {
  mockState.executeCalls = 0;
  mockState.claimRow = undefined;
  mockState.capturedQueries = [];
});

describe("claimQueueEntry — RETURNING clause carries the #1275 columns", () => {
  it("selects estimated_budget_usd and model_override in the RETURNING list", async () => {
    mockState.claimRow = { ...BASE_ROW, estimated_budget_usd: null, model_override: null };
    await claimQueueEntry("ws-1");
    // The 3rd captured query is the claim's own UPDATE ... RETURNING.
    const sql = render(mockState.capturedQueries[2]);
    expect(sql).toContain("estimated_budget_usd");
    expect(sql).toContain("model_override");
  });
});

describe("claimQueueEntry — WorkItem carries estimated_budget_usd / model_override (#1275)", () => {
  it("parses a present estimate + override onto the returned WorkItem", async () => {
    mockState.claimRow = {
      ...BASE_ROW,
      estimated_budget_usd: "12.50", // raw pg numeric-as-string
      model_override: "anthropic/claude-opus-4-8",
    };
    const item = await claimQueueEntry("ws-1");
    expect(item?.estimated_budget_usd).toBe(12.5);
    expect(item?.model_override).toBe("anthropic/claude-opus-4-8");
  });

  it("defaults both to null when the row carries null (dormant — every entry today)", async () => {
    mockState.claimRow = { ...BASE_ROW, estimated_budget_usd: null, model_override: null };
    const item = await claimQueueEntry("ws-1");
    expect(item?.estimated_budget_usd).toBeNull();
    expect(item?.model_override).toBeNull();
  });

  it("defaults both to null when the row omits the fields entirely (pre-migration row shape)", async () => {
    mockState.claimRow = { ...BASE_ROW };
    const item = await claimQueueEntry("ws-1");
    expect(item?.estimated_budget_usd).toBeNull();
    expect(item?.model_override).toBeNull();
  });

  it("never forwards NaN for a malformed estimate — falls back to null, not 0", async () => {
    mockState.claimRow = { ...BASE_ROW, estimated_budget_usd: "not-a-number", model_override: null };
    const item = await claimQueueEntry("ws-1");
    expect(item?.estimated_budget_usd).toBeNull();
    expect(Number.isNaN(item?.estimated_budget_usd)).toBe(false);
  });

  it("returns null (not empty string) when model_override is an empty string", async () => {
    mockState.claimRow = { ...BASE_ROW, estimated_budget_usd: null, model_override: "" };
    const item = await claimQueueEntry("ws-1");
    expect(item?.model_override).toBeNull();
  });
});
