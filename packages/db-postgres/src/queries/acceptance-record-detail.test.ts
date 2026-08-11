import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readAcceptanceRecordDetail } from "./change_records.js";

describe("Acceptance Record detail input boundary", () => {
  it("accepts only the opaque workspace and Record identities", async () => {
    const base = { workspaceId: randomUUID(), recordId: randomUUID() };
    for (const extra of [
      { headSha: "a".repeat(40) },
      { headCycleId: randomUUID() },
      { acceptanceContract: {} },
      { sourceSnapshotId: randomUUID() },
      { compiledPackId: randomUUID() },
      { timeline: [] },
      { artifactKey: "review/example.png" },
      { gatedIssue: { number: 1 } },
    ]) {
      await expect(readAcceptanceRecordDetail({ ...base, ...extra } as never))
        .rejects.toThrow("requires only workspace and Record");
    }
  });

  it("rejects malformed scope before database access", async () => {
    for (const input of [
      { workspaceId: "not-a-uuid", recordId: randomUUID() },
      { workspaceId: randomUUID(), recordId: "not-a-uuid" },
      { workspaceId: randomUUID() },
      { recordId: randomUUID() },
    ]) {
      await expect(readAcceptanceRecordDetail(input as never))
        .rejects.toThrow("requires only workspace and Record");
    }
  });
});
