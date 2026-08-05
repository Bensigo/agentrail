import { describe, expect, it } from "vitest";
import {
  formatHumanFalseGreenRate,
  humanFalseGreenWindow,
  unknownHumanFalseGreenCount,
} from "./human-false-green-panel-helpers";

describe("human false-green panel helpers", () => {
  it("creates one fixed, dated 30-day evidence window", () => {
    expect(humanFalseGreenWindow(new Date("2026-08-05T12:00:00.000Z"))).toEqual({
      from: "2026-07-06T12:00:00.000Z",
      to: "2026-08-05T12:00:00.000Z",
      observedUntil: "2026-08-05T12:00:00.000Z",
    });
  });

  it("preserves an unknown rate and totals every exclusion reason", () => {
    expect(formatHumanFalseGreenRate(null)).toBe("unknown");
    expect(formatHumanFalseGreenRate(0.125)).toBe("12.5%");
    expect(
      unknownHumanFalseGreenCount({
        missingPrIdentity: 2,
        missingPublishedHead: 3,
        noMatchingHumanOutcome: 5,
      })
    ).toBe(10);
  });
});
