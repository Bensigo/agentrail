import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readAcceptanceRecordSummaries } from "./change_records.js";

describe("Acceptance Record summary input boundary", () => {
  it("accepts only workspace, optional repository, and bounded limit", async () => {
    const workspaceId = randomUUID();
    for (const extra of [
      { recordId: randomUUID() },
      { headSha: "a".repeat(40) },
      { acceptanceContract: {} },
      { compiledPackId: randomUUID() },
      { timeline: [] },
    ]) {
      await expect(readAcceptanceRecordSummaries({ workspaceId, ...extra } as never))
        .rejects.toThrow("only workspace, optional repository, and bounded limit");
    }
  });

  it("rejects malformed tenant, repository, and limit values before database access", async () => {
    const workspaceId = randomUUID();
    for (const input of [
      { workspaceId: "not-a-uuid" },
      { workspaceId, repo: "../unsafe" },
      { workspaceId, repo: "owner/.." },
      { workspaceId, repo: "owner/repo/extra" },
      { workspaceId, limit: 0 },
      { workspaceId, limit: 201 },
      { workspaceId, limit: 1.5 },
    ]) {
      await expect(readAcceptanceRecordSummaries(input as never))
        .rejects.toThrow("only workspace, optional repository, and bounded limit");
    }
  });
});
