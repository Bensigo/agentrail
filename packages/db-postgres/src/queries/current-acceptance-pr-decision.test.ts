import { describe, expect, it } from "vitest";
import {
  readCurrentAcceptancePrDecision,
  recordAcceptancePrDecision,
} from "./change_records.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const RECORD_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const BINDING_ID = "44444444-4444-4444-8444-444444444444";

describe("current Acceptance PR decision input boundary", () => {
  it("accepts only workspace and Record on the read boundary", async () => {
    await expect(readCurrentAcceptancePrDecision({
      workspaceId: "not-a-uuid",
      recordId: RECORD_ID,
    })).rejects.toThrow("only workspace and Record");
    await expect(readCurrentAcceptancePrDecision({
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      headSha: "a".repeat(40),
    } as never)).rejects.toThrow("only workspace and Record");
  });

  it("rejects caller-supplied target, role, time, and arbitrary actor fields", async () => {
    const valid = {
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      bindingId: BINDING_ID,
      decision: "approved" as const,
      decidedBy: `user:${USER_ID}`,
    };
    for (const extra of [
      { headSha: "a".repeat(40) },
      { headCycleId: RECORD_ID },
      { reviewJobId: RECORD_ID },
      { acceptanceContractId: RECORD_ID },
      { decidedRole: "owner" },
      { decidedAt: new Date() },
    ]) {
      await expect(recordAcceptancePrDecision({ ...valid, ...extra } as never))
        .rejects.toThrow("Invalid Acceptance Record PR decision input");
    }
    await expect(recordAcceptancePrDecision({
      ...valid,
      decidedBy: "console_user:anything",
    })).rejects.toThrow("Invalid Acceptance Record PR decision input");
    const { bindingId: _bindingId, ...missingBinding } = valid;
    await expect(recordAcceptancePrDecision(missingBinding as never))
      .rejects.toThrow("Invalid Acceptance Record PR decision input");
    await expect(recordAcceptancePrDecision({
      ...valid,
      bindingId: "not-a-uuid",
    })).rejects.toThrow("Invalid Acceptance Record PR decision input");
  });

  it("keeps the choice and rationale grammar closed", async () => {
    const base = {
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      bindingId: BINDING_ID,
      decidedBy: `user:${USER_ID}`,
    };
    await expect(recordAcceptancePrDecision({
      ...base,
      decision: "maybe" as never,
    })).rejects.toThrow("Invalid Acceptance Record PR decision input");
    await expect(recordAcceptancePrDecision({
      ...base,
      decision: "approved_with_exception",
    })).rejects.toThrow("Invalid Acceptance Record PR decision input");
    await expect(recordAcceptancePrDecision({
      ...base,
      decision: "approved_with_exception",
      rationale: " \n\t ",
    })).rejects.toThrow("Invalid Acceptance Record PR decision input");
    await expect(recordAcceptancePrDecision({
      ...base,
      decision: "rejected",
      rationale: `unsafe\u0000control`,
    })).rejects.toThrow("Invalid Acceptance Record PR decision input");
    await expect(recordAcceptancePrDecision({
      ...base,
      decision: "changes_requested",
      rationale: "x".repeat(4_001),
    })).rejects.toThrow("Invalid Acceptance Record PR decision input");
  });
});
