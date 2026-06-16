import { describe, it, expect } from "vitest";
import {
  computeHealthRates,
  ACCEPT_RATE_HEALTH_LINE,
  type IssueOutcome,
} from "./health-metrics";

// ---------------------------------------------------------------------------
// AC1 — accept rate (green ÷ attempted), falsifiable: can display below 50%
// AC2 — escalation rate (escalated ÷ attempted)
//
// "Attempted" is every issue that reached a Run Outcome terminal (Green or
// Escalated-to-human). Blocked / still-in-flight issues are not attempts: they
// have not been graded yet, so counting them would dilute the rate.
// ---------------------------------------------------------------------------

function issues(...os: IssueOutcome[]): IssueOutcome[] {
  return os;
}

describe("computeHealthRates (AC1 accept rate, AC2 escalation rate)", () => {
  it("accept rate = green ÷ attempted; escalation rate = escalated ÷ attempted", () => {
    const result = computeHealthRates(
      issues("green", "green", "green", "escalated-to-human")
    );
    expect(result.attempted).toBe(4);
    expect(result.green).toBe(3);
    expect(result.escalated).toBe(1);
    expect(result.acceptRate).toBeCloseTo(0.75);
    expect(result.escalationRate).toBeCloseTo(0.25);
  });

  it("accept rate CAN come back below the 50% health line (falsifiable)", () => {
    // A losing loop: most attempts escalate to a human rather than reaching Green.
    const result = computeHealthRates(
      issues(
        "green",
        "escalated-to-human",
        "escalated-to-human",
        "escalated-to-human"
      )
    );
    expect(result.acceptRate).toBeCloseTo(0.25);
    expect(result.acceptRate).toBeLessThan(ACCEPT_RATE_HEALTH_LINE);
    expect(result.escalationRate).toBeCloseTo(0.75);
    expect(result.belowHealthLine).toBe(true);
  });

  it("accept rate at/above 50% is not flagged below the health line", () => {
    const result = computeHealthRates(issues("green", "escalated-to-human"));
    expect(result.acceptRate).toBeCloseTo(0.5);
    expect(result.belowHealthLine).toBe(false);
  });

  it("excludes blocked and in-flight issues from the attempted denominator", () => {
    const result = computeHealthRates(
      issues(
        "green",
        "escalated-to-human",
        "blocked", // unmet dependency — never attempted
        "in-flight" // queued/running — not yet graded
      )
    );
    expect(result.attempted).toBe(2);
    expect(result.acceptRate).toBeCloseTo(0.5);
    expect(result.escalationRate).toBeCloseTo(0.5);
  });

  it("rates are null (not NaN) when no issue has been attempted", () => {
    const result = computeHealthRates(issues("blocked", "in-flight"));
    expect(result.attempted).toBe(0);
    expect(result.green).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.acceptRate).toBeNull();
    expect(result.escalationRate).toBeNull();
    expect(result.belowHealthLine).toBe(false);
  });

  it("rates are null for empty input", () => {
    const result = computeHealthRates([]);
    expect(result.attempted).toBe(0);
    expect(result.acceptRate).toBeNull();
    expect(result.escalationRate).toBeNull();
  });

  it("accept and escalation rates sum to 1 across attempted issues", () => {
    const result = computeHealthRates(
      issues("green", "green", "escalated-to-human", "escalated-to-human", "escalated-to-human")
    );
    expect((result.acceptRate ?? 0) + (result.escalationRate ?? 0)).toBeCloseTo(1);
  });
});
