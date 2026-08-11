import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readAcceptanceOutcomeHistory } from "./change_records.js";

describe("Acceptance outcome history input boundary", () => {
  it("accepts only a bounded finite Date cohort and observation cutoff", async () => {
    const workspaceId = randomUUID();
    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-01-02T00:00:00.000Z");
    const observedUntil = new Date("2026-01-03T00:00:00.000Z");
    const invalid = [
      { workspaceId, from, to, observedUntil, recordId: randomUUID() },
      { workspaceId, from: "2026-01-01", to, observedUntil },
      { workspaceId, from: new Date("invalid"), to, observedUntil },
      { workspaceId, from: to, to, observedUntil },
      { workspaceId, from: to, to: from, observedUntil },
      { workspaceId, from, to: new Date("2027-01-03T00:00:00.001Z"), observedUntil: new Date("2027-01-03T00:00:00.001Z") },
      { workspaceId, from, to, observedUntil: new Date("2027-01-03T00:00:00.001Z") },
    ];
    for (const input of invalid) {
      await expect(readAcceptanceOutcomeHistory(input as never))
        .rejects.toThrow("Acceptance outcome history requires a workspace and bounded UTC Date window");
    }
  });
});
