import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  readAcceptancePrReviewMetrics,
  recordAcceptancePrReviewEffort,
} from "./change_records.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const RECORD_ID = "22222222-2222-4222-8222-222222222222";
const BINDING_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";

describe("Acceptance PR review metrics input boundaries", () => {
  it("accepts only workspace and Record on the metrics read", async () => {
    await expect(readAcceptancePrReviewMetrics({
      workspaceId: "not-a-uuid",
      recordId: RECORD_ID,
    })).rejects.toThrow("only workspace and Record");
    await expect(readAcceptancePrReviewMetrics({
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      headSha: "a".repeat(40),
    } as never)).rejects.toThrow("only workspace and Record");
  });

  it("keeps review effort exact, explicit, and bounded to 1..1440 minutes", async () => {
    const valid = {
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      bindingId: BINDING_ID,
      minutes: 45,
      recordedBy: `user:${USER_ID}`,
    };
    for (const value of [0, -1, 1.5, 1_441, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(recordAcceptancePrReviewEffort({ ...valid, minutes: value }))
        .rejects.toThrow("Invalid Acceptance Record PR review effort input");
    }
    for (const extra of [
      { source: "human_input" },
      { headSha: "a".repeat(40) },
      { recordedRole: "owner" },
      { recordedAt: new Date() },
    ]) {
      await expect(recordAcceptancePrReviewEffort({ ...valid, ...extra } as never))
        .rejects.toThrow("Invalid Acceptance Record PR review effort input");
    }
    await expect(recordAcceptancePrReviewEffort({
      ...valid,
      recordedBy: "server:elapsed-time-inference",
    })).rejects.toThrow("Invalid Acceptance Record PR review effort input");
  });

  it("does not read the legacy generic review_events ledger", async () => {
    const source = await readFile(new URL("./change_records.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/review_events|reviewEvents/);
  });
});
