import { describe, it, expect } from "vitest";
import {
  formatRate,
  resolveHealthState,
  ACCEPT_RATE_HEALTH_LINE,
  type HealthData,
} from "./health-panel-helpers";

function data(rates: Partial<HealthData["rates"]>): HealthData {
  return {
    rates: {
      attempted: 0,
      green: 0,
      escalated: 0,
      acceptRate: null,
      escalationRate: null,
      belowHealthLine: false,
      ...rates,
    },
  };
}

describe("formatRate", () => {
  it("renders a fraction as a whole-number percentage", () => {
    expect(formatRate(0.75)).toBe("75%");
    expect(formatRate(0.5)).toBe("50%");
    expect(formatRate(0)).toBe("0%");
    expect(formatRate(1)).toBe("100%");
  });

  it("renders null (no attempts yet) as an em dash", () => {
    expect(formatRate(null)).toBe("—");
  });
});

describe("ACCEPT_RATE_HEALTH_LINE", () => {
  it("is the 50% health line from CONTEXT.md", () => {
    expect(ACCEPT_RATE_HEALTH_LINE).toBeCloseTo(0.5);
  });
});

describe("resolveHealthState", () => {
  it("loading takes precedence", () => {
    expect(
      resolveHealthState({ loading: true, error: null, data: null })
    ).toBe("loading");
  });

  it("error when an error is present", () => {
    expect(
      resolveHealthState({ loading: false, error: "boom", data: null })
    ).toBe("error");
  });

  it("empty when no issue has been attempted", () => {
    expect(
      resolveHealthState({ loading: false, error: null, data: data({ attempted: 0 }) })
    ).toBe("empty");
  });

  it("data when at least one issue has been attempted", () => {
    expect(
      resolveHealthState({
        loading: false,
        error: null,
        data: data({ attempted: 2, green: 1, escalated: 1, acceptRate: 0.5, escalationRate: 0.5 }),
      })
    ).toBe("data");
  });
});
