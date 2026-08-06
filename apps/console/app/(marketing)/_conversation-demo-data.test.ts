import { describe, expect, it } from "vitest";
import { DEMO_CONTRACT, getDemoFollowUpMessage } from "./_conversation-demo-data";

describe("conversation demo contract", () => {
  it("contains a compact goal and three checkable acceptance criteria", () => {
    expect(DEMO_CONTRACT.goal).toBe("Retry failed webhooks safely.");
    expect(DEMO_CONTRACT.acceptanceCriteria).toEqual([
      "Try up to 3 times with backoff.",
      "Stop when a retry succeeds.",
      "Show retries that still fail.",
    ]);
  });

  it("hands confirmed work back to the user's coding agent", () => {
    expect(getDemoFollowUpMessage()).toBe(
      "Confirmed. I’ll prepare the context for your coding agent."
    );
  });
});
