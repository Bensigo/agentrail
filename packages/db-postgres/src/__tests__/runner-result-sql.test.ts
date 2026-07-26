import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * Guard against SQL ↔ helper drift (the review's required fix for #890 / loop
 * escalation). `nextQueueTransition` is the unit-tested spec, but PRODUCTION runs
 * the hand-written UPDATE inside `recordRunnerResult`. There is no live-DB test
 * harness in this package (every spec mocks `db`), so we mock `db` to CAPTURE the
 * SQL object the function builds and render it with drizzle's PgDialect, then
 * assert the load-bearing fragments — especially the red-vs-error tier behavior,
 * the dimension most likely to silently diverge from the helper.
 *
 * #1389 extends this same guard to the retry-backoff eligibility delay: the
 * red/error branch's SQL must (a) log an attempt to `queue_attempts` and (b)
 * set `next_eligible_at` using the SAME exported backoff constants
 * (`BACKOFF_BASE_MS`/`BACKOFF_MULTIPLIER`/`BACKOFF_MAX_MS`/
 * `BACKOFF_JITTER_RATIO`) `computeBackoffDelayMs` is built from — interpolated
 * as BOUND PARAMETERS (not duplicated magic numbers), so the two can never
 * drift apart (#910 lockstep rule). The real DB-level lockstep proof (the SQL
 * claim path actually skipping a delayed row, vs. `isClaimEligible`'s
 * prediction) lives in `queue-retry-backoff.integration.test.ts` — this file
 * only proves the SQL text carries the right shape/constants.
 */

const captured: unknown[] = [];
// The state the captured UPDATE's RETURNING yields back — set per-test so we can
// drive the red/error branch into either `queued` (retry) or `escalated-to-human`.
let returnedState = "queued";

vi.mock("../db.js", () => ({
  db: {
    // red/error path: capture the UPDATE; return one row so `updated` is true.
    // The row carries the `state` the CASE committed (read back via RETURNING).
    execute: (q: unknown) => {
      captured.push(q);
      return [{ id: "x", state: returnedState, external_id: "o/r#42" }];
    },
    // tail mirror onto the `runs` row — chainable no-op.
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
  },
}));

import {
  recordRunnerResult,
  HOSTED_REFUSAL_PREFIX,
  BACKOFF_BASE_MS,
  BACKOFF_MULTIPLIER,
  BACKOFF_MAX_MS,
  BACKOFF_JITTER_RATIO,
} from "../queries/runner.js";

const render = (q: unknown) => new PgDialect().sqlToQuery(q as never).sql;
const renderParams = (q: unknown) => new PgDialect().sqlToQuery(q as never).params;

beforeEach(() => {
  captured.length = 0;
  returnedState = "queued";
});

describe("recordRunnerResult SQL (lockstep with nextQueueTransition)", () => {
  it("red spends budget, escalates at exhaustion, and BUMPS tier", async () => {
    const res = await recordRunnerResult({ id: "1", workspaceId: "w", status: "red" });
    expect(res.updated).toBe(true);
    const sql = render(captured[0]);
    expect(sql).toContain("escalated-to-human");
    expect(sql).toContain("remaining_budget"); // GREATEST(remaining_budget - 1, 0)
    expect(sql).toContain("remaining_budget <= 1");
    // tier bump for a gate failure
    expect(sql).toContain("LEAST(tier + 1");
  });

  it("error spends budget and escalates, but does NOT bump tier", async () => {
    const res = await recordRunnerResult({ id: "1", workspaceId: "w", status: "error" });
    expect(res.updated).toBe(true);
    const sql = render(captured[0]);
    expect(sql).toContain("escalated-to-human");
    expect(sql).toContain("remaining_budget");
    // NO model escalation on an infra/timeout error — tier set to itself.
    expect(sql).not.toContain("tier + 1");
  });

  it("a red that RE-QUEUES (budget left) yields terminalState=null (no notify on retry)", async () => {
    returnedState = "queued"; // the CASE committed `queued` → not terminal
    const res = await recordRunnerResult({ id: "1", workspaceId: "w", status: "red" });
    expect(res).toEqual({
      updated: true,
      terminalState: null,
      externalId: "o/r#42",
      taskType: null,
      // #1343: the red/error branch always reports `transitioned: true` on a
      // successful update — unconditional/byte-identical, see
      // RecordRunnerResult.transitioned's own doc-comment for why (every
      // red/error call legitimately spends budget, unlike green).
      transitioned: true,
    });
  });

  it("a red that EXHAUSTS budget yields terminalState='escalated-to-human'", async () => {
    returnedState = "escalated-to-human"; // the CASE committed the terminal
    const res = await recordRunnerResult({ id: "1", workspaceId: "w", status: "error" });
    expect(res.terminalState).toBe("escalated-to-human");
    expect(res.externalId).toBe("o/r#42");
  });
});

/**
 * #1389 — the retry-backoff eligibility delay. The red/error branch's SQL
 * must log an attempt AND set `next_eligible_at` from the SAME exported
 * constants `computeBackoffDelayMs` is built from.
 */
describe("recordRunnerResult SQL — retry backoff (#1389, lockstep with computeBackoffDelayMs)", () => {
  it("logs an attempt to queue_attempts on every red/error call", async () => {
    await recordRunnerResult({ id: "1", workspaceId: "w", status: "red" });
    const sql = render(captured[0]);
    expect(sql).toContain("INSERT INTO queue_attempts");
    expect(sql).toContain("queue_entry_id");
    expect(sql).toContain("outcome");
    expect(sql).toContain("error_summary");
  });

  it("counts attempts (INCLUDING the one just inserted) as the backoff exponent's source", async () => {
    await recordRunnerResult({ id: "1", workspaceId: "w", status: "red" });
    const sql = render(captured[0]);
    expect(sql).toContain("attempt_count");
    expect(sql).toContain("COUNT(*)");
  });

  it("sets next_eligible_at using the SAME exported backoff constants as computeBackoffDelayMs — bound parameters, not hardcoded literals", async () => {
    await recordRunnerResult({ id: "1", workspaceId: "w", status: "red" });
    const sql = render(captured[0]);
    expect(sql).toContain("next_eligible_at");
    expect(sql).toContain("LEAST(");
    expect(sql).toContain("power(");
    expect(sql).toContain("random()");

    const params = renderParams(captured[0]);
    // The exact same values `backoffFloorMs`/`computeBackoffDelayMs` use —
    // interpolated as parameters, so a change to the exported constants
    // automatically flows into the SQL with zero risk of the two drifting.
    expect(params).toContain(BACKOFF_MAX_MS / 1000);
    expect(params).toContain(BACKOFF_BASE_MS / 1000);
    expect(params).toContain(BACKOFF_MULTIPLIER);
    expect(params).toContain(BACKOFF_JITTER_RATIO);
  });

  it("clears next_eligible_at (NULL) when this attempt exhausts the budget — nothing left to retry", async () => {
    await recordRunnerResult({ id: "1", workspaceId: "w", status: "red" });
    const sql = render(captured[0]);
    expect(sql).toContain("WHEN remaining_budget <= 1 THEN NULL");
  });
});

/**
 * #1267 PR③ — a hosted refusal (an `error` whose gate_reason carries
 * HOSTED_REFUSAL_PREFIX) must jump straight to `escalated-to-human` in a
 * SEPARATE SQL branch that spends neither remaining_budget nor tier, and
 * persists the message onto `park_reason` (the existing free-text per-row
 * reason column) so an operator sees why. This is the SQL twin of
 * nextQueueTransition's hosted-refusal branch — same lockstep contract as the
 * ordinary red/error branch above.
 */
describe("recordRunnerResult SQL — hosted refusal (#1267 PR③, lockstep with nextQueueTransition)", () => {
  it("escalates immediately with NO remaining_budget/tier MATH in the SQL at all (#1389: the attempt log still READS tier — for the log, not a bump)", async () => {
    returnedState = "escalated-to-human";
    const res = await recordRunnerResult({
      id: "1",
      workspaceId: "w",
      status: "error",
      gateReason: `${HOSTED_REFUSAL_PREFIX}no Independent Reviewer configured`,
    });
    expect(res.updated).toBe(true);
    expect(res.terminalState).toBe("escalated-to-human");
    const sql = render(captured[0]);
    expect(sql).toContain("escalated-to-human");
    // The refusal branch is unconditional — no budget/tier ARITHMETIC at all
    // (unlike the ordinary branch, which always touches both). #1389's
    // attempt-log INSERT reads the row's current `tier` (to log which tier
    // this one-and-only attempt ran at), so the bare word "tier" now
    // legitimately appears — what must NEVER appear is a bump expression.
    expect(sql).not.toContain("remaining_budget");
    expect(sql).not.toContain("tier + 1");
    expect(sql).not.toContain("LEAST(tier");
    // The message rides park_reason — the existing per-row reason column.
    expect(sql).toContain("park_reason");
    // #1389: still logs the one attempt, and clears any (impossible, but
    // defensive) pending delay — there's nothing left to retry.
    expect(sql).toContain("INSERT INTO queue_attempts");
    expect(sql).toContain("next_eligible_at = NULL");
  });

  it("persists the gate_reason message as a bound parameter on park_reason AND as the attempt log's error_summary", async () => {
    returnedState = "escalated-to-human";
    const message = `${HOSTED_REFUSAL_PREFIX}no Independent Reviewer configured`;
    await recordRunnerResult({
      id: "1", workspaceId: "w", status: "error", gateReason: message,
    });
    const params = renderParams(captured[0]);
    // Bound at least once for park_reason; #1389 also binds it (or its
    // bounded copy) for error_summary — either way the message text is
    // present among the parameters, proving it wasn't dropped.
    expect(params).toContain(message);
  });

  it("a `red` status is NEVER treated as a hosted refusal, even with the prefix in gateReason — runs the ordinary tier-bump SQL", async () => {
    returnedState = "queued";
    await recordRunnerResult({
      id: "1",
      workspaceId: "w",
      status: "red",
      gateReason: `${HOSTED_REFUSAL_PREFIX}x`,
    });
    const sql = render(captured[0]);
    expect(sql).toContain("remaining_budget <= 1");
    expect(sql).toContain("LEAST(tier + 1");
    expect(sql).not.toContain("park_reason");
  });

  it("an ordinary error (no gateReason) runs the pre-existing SQL — regression, byte-for-byte unaffected on the state-machine fields", async () => {
    returnedState = "queued";
    await recordRunnerResult({ id: "1", workspaceId: "w", status: "error" });
    const sql = render(captured[0]);
    expect(sql).toContain("remaining_budget <= 1");
    expect(sql).not.toContain("tier + 1");
    expect(sql).not.toContain("park_reason");
  });

  it("an error with an unrelated gateReason (no prefix) also runs the ordinary SQL", async () => {
    returnedState = "queued";
    await recordRunnerResult({
      id: "1", workspaceId: "w", status: "error", gateReason: "agentrail run exited 1",
    });
    const sql = render(captured[0]);
    expect(sql).toContain("remaining_budget <= 1");
    expect(sql).not.toContain("park_reason");
  });
});
