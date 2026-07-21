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

import { recordRunnerResult, HOSTED_REFUSAL_PREFIX } from "../queries/runner.js";

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
 * #1267 PR③ — a hosted refusal (an `error` whose gate_reason carries
 * HOSTED_REFUSAL_PREFIX) must jump straight to `escalated-to-human` in a
 * SEPARATE SQL branch that spends neither remaining_budget nor tier, and
 * persists the message onto `park_reason` (the existing free-text per-row
 * reason column) so an operator sees why. This is the SQL twin of
 * nextQueueTransition's hosted-refusal branch — same lockstep contract as the
 * ordinary red/error branch above.
 */
describe("recordRunnerResult SQL — hosted refusal (#1267 PR③, lockstep with nextQueueTransition)", () => {
  it("escalates immediately with NO remaining_budget/tier math in the SQL at all", async () => {
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
    // The refusal branch is unconditional — no budget/tier expressions at all
    // (unlike the ordinary branch, which always touches both).
    expect(sql).not.toContain("remaining_budget");
    expect(sql).not.toContain("tier");
    // The message rides park_reason — the existing per-row reason column.
    expect(sql).toContain("park_reason");
  });

  it("persists the gate_reason message as a bound parameter on park_reason", async () => {
    returnedState = "escalated-to-human";
    const message = `${HOSTED_REFUSAL_PREFIX}no Independent Reviewer configured`;
    await recordRunnerResult({
      id: "1", workspaceId: "w", status: "error", gateReason: message,
    });
    expect(renderParams(captured[0])).toContain(message);
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

  it("an ordinary error (no gateReason) runs the pre-existing SQL — regression, byte-for-byte unaffected", async () => {
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
