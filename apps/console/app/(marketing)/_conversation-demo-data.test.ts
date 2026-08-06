import { describe, expect, it } from "vitest";
import { DEMO_CONTRACT, getDemoFollowUpMessage } from "./_conversation-demo-data";

describe("conversation demo contract", () => {
  it("contains a goal, boundary, and checkable criteria", () => {
    expect(DEMO_CONTRACT.goal).toBeTruthy();
    expect(DEMO_CONTRACT.boundary).toContain("external builder");
    expect(DEMO_CONTRACT.acceptanceCriteria.length).toBeGreaterThanOrEqual(3);
    expect(DEMO_CONTRACT.acceptanceCriteria.every(Boolean)).toBe(true);
  });

  it("hands confirmed work to a bounded Context Pack for the external builder", () => {
    expect(getDemoFollowUpMessage()).toBe(
      "Jace prepares a bounded Context Pack for the selected external builder."
    );
  });
});
