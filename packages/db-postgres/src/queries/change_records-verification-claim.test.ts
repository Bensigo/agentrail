import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  executeCalls: [] as unknown[],
  executeReturns: [] as unknown[][],
}));

vi.mock("../db.js", () => {
  const execute = vi.fn(async (query: unknown) => {
    state.executeCalls.push(query);
    return state.executeReturns.shift() ?? [];
  });
  const select = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.innerJoin = () => chain;
    chain.where = () => chain;
    chain.limit = async () => [];
    return chain;
  });
  const update = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.set = () => chain;
    chain.where = async () => [];
    return chain;
  });
  return { db: { execute, select, update } };
});

import { PgDialect } from "drizzle-orm/pg-core";
import { claimEvidenceVerificationExecution } from "./change_records.js";

function sqlText(query: unknown): string {
  return new PgDialect().sqlToQuery(query as never).sql;
}

describe("claimEvidenceVerificationExecution", () => {
  beforeEach(() => {
    state.executeCalls = [];
    state.executeReturns = [[], []];
  });

  it("re-runs unavailable-preview cleanup after a claim finds no id", async () => {
    await expect(claimEvidenceVerificationExecution({ workerId: "worker-1" })).resolves.toBeNull();
    expect(state.executeCalls).toHaveLength(3);
    const cleanup = sqlText(state.executeCalls[0]);
    const claim = sqlText(state.executeCalls[1]);
    const retryCleanup = sqlText(state.executeCalls[2]);
    expect(retryCleanup).toBe(cleanup);

    // Missing, mismatched, superseded, and terminal previews are immutable
    // safety failures. Pending/claimed/booting previews stay queued because
    // they may still become ready.
    expect(cleanup).toContain("'not_testable'");
    expect(cleanup).toContain("revision.superseded_at IS NOT NULL");
    expect(cleanup).toContain("preview.id IS NULL");
    expect(cleanup).toContain("preview.workspace_id <> attachment.workspace_id");
    expect(cleanup).toContain("'torn_down'");
    expect(cleanup).toContain("'failed'");
    expect(cleanup).not.toContain("'pending'");
    expect(cleanup).not.toContain("'claimed'");
    expect(cleanup).not.toContain("'booting'");
    expect(claim).toContain("'ready'");
    expect(claim).toContain("preview_boots");
    expect(claim).toContain("head_sha");
    expect(claim).toContain("plan.modality IN ('ui', 'api')");
  });
});
