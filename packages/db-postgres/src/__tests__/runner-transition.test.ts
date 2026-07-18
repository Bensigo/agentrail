import { describe, it, expect, vi } from "vitest";

// The db module is mocked so importing the query module is side-effect free; the
// transition under test is pure and never touches it.
vi.mock("../db.js", () => ({ db: {} }));

import {
  nextQueueTransition,
  MAX_TIER,
  HOSTED_REFUSAL_PREFIX,
} from "../queries/runner.js";

/**
 * nextQueueTransition is the PURE result→queue-state decision extracted from
 * recordRunnerResult (BUG 2). It must:
 *  - terminate on green; heartbeat on running (budget/tier untouched);
 *  - on red OR error: spend one budget, bump tier (capped), re-queue;
 *  - escalate-to-human terminally once the budget is exhausted.
 */
describe("nextQueueTransition", () => {
  it("green is terminal and leaves budget/tier untouched", () => {
    expect(
      nextQueueTransition({ status: "green", remainingBudget: 3, tier: 1 })
    ).toEqual({ state: "green", remainingBudget: 3, tier: 1 });
  });

  it("running is a heartbeat and leaves budget/tier untouched", () => {
    expect(
      nextQueueTransition({ status: "running", remainingBudget: 3, tier: 1 })
    ).toEqual({ state: "running", remainingBudget: 3, tier: 1 });
  });

  it("red decrements budget, bumps tier, and re-queues for another attempt", () => {
    expect(
      nextQueueTransition({ status: "red", remainingBudget: 5, tier: 0 })
    ).toEqual({ state: "queued", remainingBudget: 4, tier: 1 });
  });

  it("error is retryable (#890) but does NOT bump tier (infra/timeout, not a gate failure)", () => {
    expect(
      nextQueueTransition({ status: "error", remainingBudget: 5, tier: 0 })
    ).toEqual({ state: "queued", remainingBudget: 4, tier: 0 });
    // even at a higher tier, an error keeps the tier where it is
    expect(
      nextQueueTransition({ status: "error", remainingBudget: 5, tier: 2 })
    ).toEqual({ state: "queued", remainingBudget: 4, tier: 2 });
  });

  it("escalates-to-human terminally when the last attempt's budget is exhausted", () => {
    // remainingBudget === 1 means this red/error is the final attempt.
    expect(
      nextQueueTransition({ status: "red", remainingBudget: 1, tier: 2 })
    ).toEqual({ state: "escalated-to-human", remainingBudget: 0, tier: 2 });
    // error escalates too, but its tier is unchanged (stays 1, not bumped to 2)
    expect(
      nextQueueTransition({ status: "error", remainingBudget: 1, tier: 1 })
    ).toEqual({ state: "escalated-to-human", remainingBudget: 0, tier: 1 });
  });

  it("caps tier at MAX_TIER so escalation stays bounded", () => {
    const out = nextQueueTransition({
      status: "red",
      remainingBudget: 5,
      tier: MAX_TIER,
    });
    expect(out.tier).toBe(MAX_TIER);
  });

  it("models a full red sequence: 5 attempts then escalate", () => {
    // Seed of 5 (the enqueue budget) ⇒ four re-queues then escalate on the 5th.
    let budget = 5;
    let tier = 0;
    const states: string[] = [];
    for (let i = 0; i < 5; i++) {
      const out = nextQueueTransition({
        status: "red",
        remainingBudget: budget,
        tier,
      });
      states.push(out.state);
      budget = out.remainingBudget;
      tier = out.tier;
    }
    expect(states).toEqual([
      "queued",
      "queued",
      "queued",
      "queued",
      "escalated-to-human",
    ]);
    expect(budget).toBe(0);
    expect(tier).toBe(MAX_TIER);
  });

  // ---------------------------------------------------------------------------
  // #1267 PR③ — a hosted startup refusal (a static per-repo config gap, e.g. no
  // Independent Reviewer configured, #1270) must jump straight to a human,
  // spending NEITHER budget NOR tier — no retry or stronger model fixes it.
  // ---------------------------------------------------------------------------
  describe("hosted refusal (#1267 PR③)", () => {
    it("an error whose gateReason carries the hosted-refusal prefix escalates immediately, budget/tier untouched", () => {
      expect(
        nextQueueTransition({
          status: "error",
          remainingBudget: 5,
          tier: 0,
          gateReason: `${HOSTED_REFUSAL_PREFIX}no Independent Reviewer configured`,
        })
      ).toEqual({ state: "escalated-to-human", remainingBudget: 5, tier: 0 });
    });

    it("escalates on the FIRST attempt, not just when budget is nearly exhausted", () => {
      // A fresh entry (full budget, tier 0) still escalates immediately — this
      // is the whole point: no retries burned before a human hears.
      const out = nextQueueTransition({
        status: "error",
        remainingBudget: 5,
        tier: 0,
        gateReason: `${HOSTED_REFUSAL_PREFIX}x`,
      });
      expect(out.state).toBe("escalated-to-human");
      expect(out.remainingBudget).toBe(5);
      expect(out.tier).toBe(0);
    });

    it("never bumps tier, even at tier 0", () => {
      const out = nextQueueTransition({
        status: "error",
        remainingBudget: 3,
        tier: 0,
        gateReason: `${HOSTED_REFUSAL_PREFIX}x`,
      });
      expect(out.tier).toBe(0);
    });

    it("a `red` status is NEVER treated as a hosted refusal, even with the prefix in gateReason", () => {
      // The prefix is only meaningful on `error` — a gate failure (`red`) is a
      // genuinely different outcome kind and must keep its ordinary handling.
      expect(
        nextQueueTransition({
          status: "red",
          remainingBudget: 5,
          tier: 0,
          gateReason: `${HOSTED_REFUSAL_PREFIX}x`,
        })
      ).toEqual({ state: "queued", remainingBudget: 4, tier: 1 });
    });

    it("an ordinary error (no prefix, or no gateReason at all) is unaffected — regression", () => {
      expect(
        nextQueueTransition({ status: "error", remainingBudget: 5, tier: 0 })
      ).toEqual({ state: "queued", remainingBudget: 4, tier: 0 });
      expect(
        nextQueueTransition({
          status: "error",
          remainingBudget: 5,
          tier: 0,
          gateReason: "agentrail run exited 1",
        })
      ).toEqual({ state: "queued", remainingBudget: 4, tier: 0 });
      expect(
        nextQueueTransition({
          status: "error",
          remainingBudget: 5,
          tier: 0,
          gateReason: undefined,
        })
      ).toEqual({ state: "queued", remainingBudget: 4, tier: 0 });
    });

    it("a gateReason that merely CONTAINS the prefix (not as a starting anchor) is NOT a refusal", () => {
      expect(
        nextQueueTransition({
          status: "error",
          remainingBudget: 5,
          tier: 0,
          gateReason: `see also: ${HOSTED_REFUSAL_PREFIX}x`,
        })
      ).toEqual({ state: "queued", remainingBudget: 4, tier: 0 });
    });
  });
});
