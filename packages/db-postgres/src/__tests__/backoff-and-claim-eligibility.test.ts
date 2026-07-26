import { describe, it, expect, vi } from "vitest";

// Pure functions — no db access, but keep parity with the rest of this
// package's test style (the module import graph is side-effect free anyway).
vi.mock("../db.js", () => ({ db: {} }));

import {
  backoffFloorMs,
  computeBackoffDelayMs,
  isClaimEligible,
  BACKOFF_BASE_MS,
  BACKOFF_MULTIPLIER,
  BACKOFF_MAX_MS,
  BACKOFF_JITTER_RATIO,
} from "../queries/runner.js";

describe("backoffFloorMs (#1389)", () => {
  it("the 1st attempt's floor is exactly the base delay", () => {
    expect(backoffFloorMs(1)).toBe(BACKOFF_BASE_MS);
  });

  it("grows exponentially by BACKOFF_MULTIPLIER per attempt", () => {
    expect(backoffFloorMs(2)).toBe(BACKOFF_BASE_MS * BACKOFF_MULTIPLIER);
    expect(backoffFloorMs(3)).toBe(BACKOFF_BASE_MS * BACKOFF_MULTIPLIER ** 2);
    expect(backoffFloorMs(4)).toBe(BACKOFF_BASE_MS * BACKOFF_MULTIPLIER ** 3);
  });

  it("caps at BACKOFF_MAX_MS for a large attempt count", () => {
    expect(backoffFloorMs(100)).toBe(BACKOFF_MAX_MS);
  });

  it("treats attempt <= 1 (or fractional) as the 1st attempt — never goes below the base", () => {
    expect(backoffFloorMs(0)).toBe(BACKOFF_BASE_MS);
    expect(backoffFloorMs(-5)).toBe(BACKOFF_BASE_MS);
    expect(backoffFloorMs(1.9)).toBe(BACKOFF_BASE_MS);
  });
});

describe("computeBackoffDelayMs (#1389 AC1 — strictly increasing gaps)", () => {
  it("with zero jitter, equals the deterministic floor exactly", () => {
    expect(computeBackoffDelayMs(1, () => 0)).toBe(backoffFloorMs(1));
    expect(computeBackoffDelayMs(3, () => 0)).toBe(backoffFloorMs(3));
  });

  it("with max jitter (rand=1), adds up to BACKOFF_JITTER_RATIO of the floor, never crosses into the next attempt's floor", () => {
    const attempt = 2;
    const delay = computeBackoffDelayMs(attempt, () => 1);
    const floor = backoffFloorMs(attempt);
    expect(delay).toBeGreaterThanOrEqual(floor);
    expect(delay).toBeLessThan(floor * (1 + BACKOFF_JITTER_RATIO) + 1);
    expect(delay).toBeLessThan(backoffFloorMs(attempt + 1));
  });

  it("PROOF of AC1: attempt N's worst case is always less than attempt N+1's best case, for every attempt below the cap", () => {
    // Stop once floor(n+1) would already be capped — once both attempts share
    // the same (capped) floor, growth flattens and the guarantee no longer
    // applies (by design: the entry is retrying at a bounded steady cadence,
    // not waiting longer forever). Solve for the largest n with
    // BACKOFF_BASE_MS * BACKOFF_MULTIPLIER^n <= BACKOFF_MAX_MS.
    const maxSafeN = Math.floor(
      Math.log(BACKOFF_MAX_MS / BACKOFF_BASE_MS) / Math.log(BACKOFF_MULTIPLIER)
    );
    expect(maxSafeN).toBeGreaterThan(1); // sanity: the constants leave room to test this
    for (let n = 1; n < maxSafeN; n++) {
      const worstCaseN = computeBackoffDelayMs(n, () => 1); // max jitter
      const bestCaseNext = computeBackoffDelayMs(n + 1, () => 0); // zero jitter
      expect(worstCaseN).toBeLessThan(bestCaseNext);
    }
  });

  it("default rand (Math.random) always produces a value within [floor, floor*(1+ratio)]", () => {
    for (let n = 1; n <= 5; n++) {
      const delay = computeBackoffDelayMs(n);
      const floor = backoffFloorMs(n);
      expect(delay).toBeGreaterThanOrEqual(floor);
      expect(delay).toBeLessThanOrEqual(Math.ceil(floor * (1 + BACKOFF_JITTER_RATIO)));
    }
  });
});

describe("isClaimEligible (#1389 — pure mirror of claimQueueEntry's SQL predicate, #910 lockstep)", () => {
  const now = new Date("2026-07-26T12:00:00Z");

  it("a non-'queued' state is never eligible, regardless of nextEligibleAt", () => {
    expect(isClaimEligible({ state: "running", nextEligibleAt: null }, now)).toBe(false);
    expect(isClaimEligible({ state: "parked", nextEligibleAt: null }, now)).toBe(false);
    expect(isClaimEligible({ state: "green", nextEligibleAt: null }, now)).toBe(false);
    expect(
      isClaimEligible({ state: "escalated-to-human", nextEligibleAt: null }, now)
    ).toBe(false);
  });

  it("'queued' with a null nextEligibleAt is eligible (a fresh entry, or one never delayed)", () => {
    expect(isClaimEligible({ state: "queued", nextEligibleAt: null }, now)).toBe(true);
  });

  it("'queued' with a FUTURE nextEligibleAt is NOT eligible", () => {
    const future = new Date(now.getTime() + 60_000);
    expect(isClaimEligible({ state: "queued", nextEligibleAt: future }, now)).toBe(false);
    // string form (as it round-trips through JSON) behaves the same
    expect(
      isClaimEligible({ state: "queued", nextEligibleAt: future.toISOString() }, now)
    ).toBe(false);
  });

  it("'queued' with a PAST nextEligibleAt is eligible (the delay elapsed)", () => {
    const past = new Date(now.getTime() - 1);
    expect(isClaimEligible({ state: "queued", nextEligibleAt: past }, now)).toBe(true);
  });

  it("'queued' with nextEligibleAt EXACTLY now is eligible (<=, not <)", () => {
    expect(isClaimEligible({ state: "queued", nextEligibleAt: now }, now)).toBe(true);
  });
});
