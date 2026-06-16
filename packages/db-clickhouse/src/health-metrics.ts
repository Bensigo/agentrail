// ---------------------------------------------------------------------------
// System-Health Metrics — accept rate + escalation rate (M034)
//
// The two falsifiable health metrics the Agent Operations Console shows under
// the console display rule (CONTEXT.md / ADR 0009): both can come back below
// target, unlike the removed one-sided "savings" number.
//
// - Accept rate    = green ÷ attempted. The health line is > 50%; a losing loop
//                    shows a value below it (this is what makes it falsifiable).
// - Escalation rate = escalated-to-human ÷ attempted.
//
// "Attempted" is every issue that reached a Run Outcome terminal — Green or
// Escalated-to-human (see queue_state.py terminals). Blocked issues (an unmet
// blocked-by dependency) and still-in-flight issues (queued/running) are not
// attempts: they have not been graded by the Objective Gate yet, so counting
// them would dilute the rate. The denominator is consistent with how #776's
// Cost-per-Issue-to-Green groups runs into issues.
// ---------------------------------------------------------------------------

/**
 * The terminal Run Outcome of one issue, projected from its runs' statuses.
 * `in-flight` covers queued/running issues that have not reached a terminal yet.
 */
export type IssueOutcome =
  | "green"
  | "escalated-to-human"
  | "blocked"
  | "in-flight";

/** The accept-rate health line: above this the loop is winning, below it is losing. */
export const ACCEPT_RATE_HEALTH_LINE = 0.5;

export interface HealthRates {
  /** Issues that reached a terminal grade (green + escalated). The denominator. */
  attempted: number;
  /** Issues that reached the Green terminal (Objective Gate + Independent Verification pass). */
  green: number;
  /** Issues that reached the Escalated-to-human terminal (a hard stop fired). */
  escalated: number;
  /**
   * green ÷ attempted, or `null` when nothing has been attempted (undefined,
   * not NaN). Falsifiable: a bad system shows a value below
   * {@link ACCEPT_RATE_HEALTH_LINE}.
   */
  acceptRate: number | null;
  /** escalated ÷ attempted, or `null` when nothing has been attempted. */
  escalationRate: number | null;
  /**
   * True when the accept rate is below the 50% health line. False when there is
   * no attempt yet (no claim either way) or when the rate is at/above the line.
   */
  belowHealthLine: boolean;
}

/**
 * Pure computation of accept rate and escalation rate over per-issue terminal
 * outcomes. Only Green and Escalated-to-human count toward the attempted
 * denominator; Blocked and in-flight issues are excluded.
 */
export function computeHealthRates(outcomes: IssueOutcome[]): HealthRates {
  let green = 0;
  let escalated = 0;
  for (const outcome of outcomes) {
    if (outcome === "green") green += 1;
    else if (outcome === "escalated-to-human") escalated += 1;
  }
  const attempted = green + escalated;
  const acceptRate = attempted > 0 ? green / attempted : null;
  const escalationRate = attempted > 0 ? escalated / attempted : null;
  return {
    attempted,
    green,
    escalated,
    acceptRate,
    escalationRate,
    belowHealthLine: acceptRate !== null && acceptRate < ACCEPT_RATE_HEALTH_LINE,
  };
}
