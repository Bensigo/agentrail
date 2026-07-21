import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * recordRunnerResult terminalState (#888 notify trap). The route notifies ONLY
 * when terminalState is non-null, so these assert the green/running branch:
 *   - green   → terminalState 'green' (terminal)
 *   - running → null (heartbeat, NOT terminal → no notify)
 * The red/error branch is covered in runner-result-sql.test.ts.
 *
 * #1343: the green/running branch is raw SQL (a locking `prior` CTE feeding
 * the UPDATE, so the row's state immediately BEFORE this call can be compared
 * to what it committed — see RecordRunnerResult.transitioned's doc-comment),
 * not the fluent `.update()` chain this suite used to mock. `db.execute` is
 * mocked to capture the query and return the committed row PLUS the
 * `prior_state` the CTE's RETURNING carries; `priorState` is set per-test to
 * drive the duplicate-green (`transitioned: false`) vs. genuine-transition
 * (`transitioned: true`) cases.
 */

let returnedState = "green";
let priorState = "running";
const captured: unknown[] = [];

vi.mock("../db.js", () => ({
  db: {
    // green/running path: the locking-CTE UPDATE this file drives.
    execute: (q: unknown) => {
      captured.push(q);
      return Promise.resolve([
        {
          id: "x",
          state: returnedState,
          external_id: "o/r#42",
          task_type: null,
          prior_state: priorState,
        },
      ]);
    },
    // The tail `runs` mirror calls update().set().where() (no returning) —
    // unaffected by the #1343 SQL change, still the fluent chain.
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
  },
}));

import { recordRunnerResult } from "../queries/runner.js";

const render = (q: unknown) => new PgDialect().sqlToQuery(q as never).sql;

beforeEach(() => {
  returnedState = "green";
  priorState = "running";
  captured.length = 0;
});

describe("recordRunnerResult terminalState (green / running)", () => {
  it("green → terminalState 'green' and updated true", async () => {
    returnedState = "green";
    priorState = "running";
    const res = await recordRunnerResult({ id: "1", workspaceId: "w", status: "green" });
    expect(res.updated).toBe(true);
    expect(res.terminalState).toBe("green");
    expect(res.externalId).toBe("o/r#42");
  });

  it("running → terminalState null (heartbeat, no notify)", async () => {
    returnedState = "running";
    priorState = "running";
    const res = await recordRunnerResult({ id: "1", workspaceId: "w", status: "running" });
    expect(res.updated).toBe(true);
    expect(res.terminalState).toBeNull();
  });
});

/**
 * #1343 — the duplicate-green guard. A queue entry that was ALREADY 'green'
 * before this call (prior_state === 'green') must report `transitioned:
 * false`, which is what lets the runner-result route skip the redundant
 * merge attempt and the contradictory second chat notify on a replayed
 * result. A genuine first-time green (prior_state something else, e.g.
 * 'running') must report `transitioned: true`.
 */
describe("recordRunnerResult transitioned (#1343 duplicate-green guard)", () => {
  it("genuine green transition (prior state 'running'): transitioned true", async () => {
    returnedState = "green";
    priorState = "running";
    const res = await recordRunnerResult({ id: "1", workspaceId: "w", status: "green" });
    expect(res.transitioned).toBe(true);
  });

  it("duplicate/replayed green (prior state ALREADY 'green'): transitioned false", async () => {
    returnedState = "green";
    priorState = "green";
    const res = await recordRunnerResult({ id: "1", workspaceId: "w", status: "green" });
    expect(res.updated).toBe(true);
    expect(res.terminalState).toBe("green");
    expect(res.transitioned).toBe(false);
  });

  it("the UPDATE locks the row FOR UPDATE via the prior CTE, so a concurrent duplicate can never race to two 'transitioned' answers", async () => {
    await recordRunnerResult({ id: "1", workspaceId: "w", status: "green" });
    const sql = render(captured[0]);
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("prior_state");
  });
});
