import { describe, it, expect, vi } from "vitest";

// The db module is mocked so importing the query module is side-effect free; the
// transition under test is pure and never touches it.
vi.mock("../db.js", () => ({ db: {} }));

import {
  nextQueueTransition,
  MAX_TIER,
  HOSTED_REFUSAL_PREFIX,
  backoffFloorMs,
} from "../queries/runner.js";

// Every red/error call below that asserts the FULL object via `.toEqual`
// pins `rand: () => 0` so `retryDelayMs` (#1389) comes out deterministic —
// exactly `backoffFloorMs(attemptNumber)`, zero jitter — instead of a random
// value that would make the assertion flaky. Production callers never pass
// `rand`; see `computeBackoffDelayMs`'s own doc-comment.
const ZERO_JITTER = () => 0;

/**
 * nextQueueTransition is the PURE result→queue-state decision extracted from
 * recordRunnerResult (BUG 2). It must:
 *  - terminate on green; heartbeat on running (budget/tier untouched);
 *  - on red OR error: spend one budget, bump tier (capped), re-queue;
 *  - escalate-to-human terminally once the budget is exhausted.
 *
 * #1389: it must ALSO attach a strictly-growing backoff delay
 * (`retryDelayMs`) whenever it re-admits the entry as 'queued', and `null`
 * whenever it does not (green / running / either escalation path).
 */
describe("nextQueueTransition", () => {
  it("green is terminal and leaves budget/tier untouched; no retry delay", () => {
    expect(
      nextQueueTransition({ status: "green", remainingBudget: 3, tier: 1 })
    ).toEqual({ state: "green", remainingBudget: 3, tier: 1, retryDelayMs: null });
  });

  it("running is a heartbeat and leaves budget/tier untouched; no retry delay", () => {
    expect(
      nextQueueTransition({ status: "running", remainingBudget: 3, tier: 1 })
    ).toEqual({ state: "running", remainingBudget: 3, tier: 1, retryDelayMs: null });
  });

  it("red decrements budget, bumps tier, re-queues, and attaches the 1st-attempt backoff floor", () => {
    expect(
      nextQueueTransition({
        status: "red",
        remainingBudget: 5,
        tier: 0,
        rand: ZERO_JITTER,
      })
    ).toEqual({
      state: "queued",
      remainingBudget: 4,
      tier: 1,
      retryDelayMs: backoffFloorMs(1),
    });
  });

  it("error is retryable (#890) but does NOT bump tier (infra/timeout, not a gate failure); still gets a retry delay", () => {
    expect(
      nextQueueTransition({
        status: "error",
        remainingBudget: 5,
        tier: 0,
        rand: ZERO_JITTER,
      })
    ).toEqual({
      state: "queued",
      remainingBudget: 4,
      tier: 0,
      retryDelayMs: backoffFloorMs(1),
    });
    // even at a higher tier, an error keeps the tier where it is
    expect(
      nextQueueTransition({
        status: "error",
        remainingBudget: 5,
        tier: 2,
        rand: ZERO_JITTER,
      })
    ).toEqual({
      state: "queued",
      remainingBudget: 4,
      tier: 2,
      retryDelayMs: backoffFloorMs(1),
    });
  });

  it("a LATER attempt number produces a LARGER backoff floor — the growth #1389 AC1 relies on", () => {
    const attempt1 = nextQueueTransition({
      status: "red",
      remainingBudget: 5,
      tier: 0,
      attemptNumber: 1,
      rand: ZERO_JITTER,
    });
    const attempt3 = nextQueueTransition({
      status: "red",
      remainingBudget: 5,
      tier: 0,
      attemptNumber: 3,
      rand: ZERO_JITTER,
    });
    expect(attempt1.retryDelayMs).toBeGreaterThan(0);
    expect(attempt3.retryDelayMs).toBeGreaterThan(attempt1.retryDelayMs!);
  });

  it("escalates-to-human terminally when the last attempt's budget is exhausted; no retry delay (nothing left to retry)", () => {
    // remainingBudget === 1 means this red/error is the final attempt.
    expect(
      nextQueueTransition({ status: "red", remainingBudget: 1, tier: 2 })
    ).toEqual({
      state: "escalated-to-human",
      remainingBudget: 0,
      tier: 2,
      retryDelayMs: null,
    });
    // error escalates too, but its tier is unchanged (stays 1, not bumped to 2)
    expect(
      nextQueueTransition({ status: "error", remainingBudget: 1, tier: 1 })
    ).toEqual({
      state: "escalated-to-human",
      remainingBudget: 0,
      tier: 1,
      retryDelayMs: null,
    });
  });

  it("caps tier at MAX_TIER so escalation stays bounded", () => {
    const out = nextQueueTransition({
      status: "red",
      remainingBudget: 5,
      tier: MAX_TIER,
    });
    expect(out.tier).toBe(MAX_TIER);
  });

  it("models a full red sequence: 5 attempts then escalate, backoff growing every retry", () => {
    // Seed of 5 (the enqueue budget) ⇒ four re-queues then escalate on the 5th.
    let budget = 5;
    let tier = 0;
    const states: string[] = [];
    const delays: (number | null)[] = [];
    for (let i = 0; i < 5; i++) {
      const out = nextQueueTransition({
        status: "red",
        remainingBudget: budget,
        tier,
        attemptNumber: i + 1,
        rand: ZERO_JITTER,
      });
      states.push(out.state);
      delays.push(out.retryDelayMs);
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
    // The 4 re-queues carry a strictly increasing delay; the final escalation
    // carries none.
    expect(delays.slice(0, 4)).toEqual([
      backoffFloorMs(1),
      backoffFloorMs(2),
      backoffFloorMs(3),
      backoffFloorMs(4),
    ]);
    expect(delays[4]).toBeNull();
    for (let i = 1; i < 4; i++) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
  });

  // ---------------------------------------------------------------------------
  // #1267 PR③ — a hosted startup refusal (a static per-repo config gap, e.g. no
  // Independent Reviewer configured, #1270) must jump straight to a human,
  // spending NEITHER budget NOR tier — no retry or stronger model fixes it.
  // ---------------------------------------------------------------------------
  describe("hosted refusal (#1267 PR③)", () => {
    it("an error whose gateReason carries the hosted-refusal prefix escalates immediately, budget/tier untouched, no retry delay", () => {
      expect(
        nextQueueTransition({
          status: "error",
          remainingBudget: 5,
          tier: 0,
          gateReason: `${HOSTED_REFUSAL_PREFIX}no Independent Reviewer configured`,
        })
      ).toEqual({
        state: "escalated-to-human",
        remainingBudget: 5,
        tier: 0,
        retryDelayMs: null,
      });
    });

    it("escalates on the FIRST attempt, not just when budget is nearly exhausted", () => {
      const out = nextQueueTransition({
        status: "error",
        remainingBudget: 5,
        tier: 0,
        gateReason: `${HOSTED_REFUSAL_PREFIX}x`,
      });
      expect(out.state).toBe("escalated-to-human");
      expect(out.remainingBudget).toBe(5);
      expect(out.tier).toBe(0);
      expect(out.retryDelayMs).toBeNull();
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
      expect(
        nextQueueTransition({
          status: "red",
          remainingBudget: 5,
          tier: 0,
          gateReason: `${HOSTED_REFUSAL_PREFIX}x`,
          rand: ZERO_JITTER,
        })
      ).toEqual({
        state: "queued",
        remainingBudget: 4,
        tier: 1,
        retryDelayMs: backoffFloorMs(1),
      });
    });

    it("an ordinary error (no prefix, or no gateReason at all) is unaffected — regression", () => {
      expect(
        nextQueueTransition({
          status: "error",
          remainingBudget: 5,
          tier: 0,
          rand: ZERO_JITTER,
        })
      ).toEqual({
        state: "queued",
        remainingBudget: 4,
        tier: 0,
        retryDelayMs: backoffFloorMs(1),
      });
      expect(
        nextQueueTransition({
          status: "error",
          remainingBudget: 5,
          tier: 0,
          gateReason: "agentrail run exited 1",
          rand: ZERO_JITTER,
        })
      ).toEqual({
        state: "queued",
        remainingBudget: 4,
        tier: 0,
        retryDelayMs: backoffFloorMs(1),
      });
      expect(
        nextQueueTransition({
          status: "error",
          remainingBudget: 5,
          tier: 0,
          gateReason: undefined,
          rand: ZERO_JITTER,
        })
      ).toEqual({
        state: "queued",
        remainingBudget: 4,
        tier: 0,
        retryDelayMs: backoffFloorMs(1),
      });
    });

    it("a gateReason that merely CONTAINS the prefix (not as a starting anchor) is NOT a refusal", () => {
      expect(
        nextQueueTransition({
          status: "error",
          remainingBudget: 5,
          tier: 0,
          gateReason: `see also: ${HOSTED_REFUSAL_PREFIX}x`,
          rand: ZERO_JITTER,
        })
      ).toEqual({
        state: "queued",
        remainingBudget: 4,
        tier: 0,
        retryDelayMs: backoffFloorMs(1),
      });
    });
  });
});
