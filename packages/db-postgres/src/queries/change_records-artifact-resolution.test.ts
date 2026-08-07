import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  selectReturns: [] as unknown[][],
  whereCalls: [] as unknown[],
}));

vi.mock("../db.js", () => {
  const select = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.innerJoin = () => chain;
    chain.where = (query: unknown) => {
      state.whereCalls.push(query);
      return chain;
    };
    chain.limit = async () => state.selectReturns.shift() ?? [];
    return chain;
  });
  return { db: { select } };
});

import { PgDialect } from "drizzle-orm/pg-core";
import { resolveEvidenceVerificationPlanForArtifact } from "./change_records.js";

const input = { workspaceId: "ws", recordId: "record", prRevisionId: "revision", verificationPlanId: "plan" };
const row = {
  plan: { id: "plan", modality: "api", environmentId: "preview" },
  attachment: { workspaceId: "ws", repositoryFullName: "ada/widgets", prNumber: 42 },
  revision: { headSha: "abcdef0123456789" },
};
const compiledSql = (query: unknown) => new PgDialect().sqlToQuery(query as never);

describe("resolveEvidenceVerificationPlanForArtifact", () => {
  beforeEach(() => {
    state.selectReturns = [];
    state.whereCalls = [];
  });

  it("returns an API plan only with its exact ready preview URL", async () => {
    state.selectReturns = [[row], [{ url: "https://preview.example.test" }]];
    await expect(resolveEvidenceVerificationPlanForArtifact({ ...input, modality: "api" })).resolves.toEqual({
      plan: row.plan,
      repositoryFullName: "ada/widgets",
      prNumber: 42,
      headSha: "abcdef0123456789",
      previewUrl: "https://preview.example.test",
    });
    const previewWhere = compiledSql(state.whereCalls[1]);
    expect(previewWhere.sql).toContain("workspace_id");
    expect(previewWhere.sql).toContain("head_sha");
    expect(previewWhere.params).toContain("ready");
  });

  it("fails closed for API when no exact ready preview URL is returned", async () => {
    for (const previewRows of [[], [{ url: null }]]) {
      state.selectReturns = [[row], previewRows];
      await expect(resolveEvidenceVerificationPlanForArtifact({ ...input, modality: "api" })).resolves.toBeNull();
    }
  });

  it("preserves UI artifact resolution without a live preview lookup", async () => {
    state.selectReturns = [[{ ...row, plan: { ...row.plan, modality: "ui", environmentId: null } }]];
    await expect(resolveEvidenceVerificationPlanForArtifact({ ...input, modality: "ui" })).resolves.toEqual({
      plan: { ...row.plan, modality: "ui", environmentId: null },
      repositoryFullName: "ada/widgets",
      prNumber: 42,
      headSha: "abcdef0123456789",
    });
    expect(state.whereCalls).toHaveLength(1);
  });

  it("can require an exact ready preview for a UI artifact upload", async () => {
    state.selectReturns = [[{ ...row, plan: { ...row.plan, modality: "ui" } }], [{ url: "https://preview.example.test" }]];
    await expect(resolveEvidenceVerificationPlanForArtifact({ ...input, modality: "ui", requireReadyPreview: true })).resolves.toMatchObject({
      plan: { modality: "ui" }, previewUrl: "https://preview.example.test",
    });
    expect(state.whereCalls).toHaveLength(2);
  });
});
