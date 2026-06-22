import { describe, it, expect, vi } from "vitest";

// The db module is mocked so importing the query module is side-effect free; the
// transition under test is pure and never touches it.
vi.mock("../db.js", () => ({ db: {} }));

import { nextQueueTransition, MAX_TIER } from "../queries/runner.js";

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
});
