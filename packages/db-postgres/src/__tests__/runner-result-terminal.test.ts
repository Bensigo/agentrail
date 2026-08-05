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
let runUpdateValues: Record<string, unknown> | undefined;

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
    update: () => ({
      set: (values: Record<string, unknown>) => {
        runUpdateValues = values;
        return { where: () => Promise.resolve([]) };
      },
    }),
    insert: () => ({ values: () => Promise.resolve([]) }),
  },
}));

import { canonicalGitCommitSha, recordRunnerResult } from "../queries/runner.js";

const render = (q: unknown) => new PgDialect().sqlToQuery(q as never).sql;

beforeEach(() => {
  returnedState = "green";
  priorState = "running";
  captured.length = 0;
  runUpdateValues = undefined;
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

  it("does not persist a PR URL whose owner/repo conflicts with the queue entry", async () => {
    await recordRunnerResult({
      id: "1",
      workspaceId: "w",
      status: "green",
      prUrl: "https://github.com/attacker/evil-repo/pull/9",
    });

    expect(runUpdateValues).not.toHaveProperty("prUrl");
  });

  it("persists a valid PR URL in canonical form for the queue entry repo", async () => {
    await recordRunnerResult({
      id: "1",
      workspaceId: "w",
      status: "green",
      prUrl: "https://github.com/O/R/pull/9?tab=files#discussion",
    });

    expect(runUpdateValues).toMatchObject({
      prUrl: "https://github.com/o/r/pull/9",
    });
  });

  it("persists a valid produced head only with a queue-bound green PR", async () => {
    await recordRunnerResult({
      id: "1",
      workspaceId: "w",
      status: "green",
      prUrl: "https://github.com/o/r/pull/9",
      prHeadSha: "A".repeat(40),
    });

    expect(runUpdateValues).toMatchObject({ prHeadSha: "a".repeat(40) });
  });

  it("does not persist an unvalidated head or a head without an accepted green PR", async () => {
    await recordRunnerResult({
      id: "1",
      workspaceId: "w",
      status: "green",
      prUrl: "https://github.com/attacker/evil-repo/pull/9",
      prHeadSha: "a".repeat(40),
    });
    expect(runUpdateValues).not.toHaveProperty("prHeadSha");

    await recordRunnerResult({
      id: "1",
      workspaceId: "w",
      status: "green",
      prUrl: "https://github.com/o/r/pull/9",
      prHeadSha: "not-a-commit",
    });
    expect(runUpdateValues).not.toHaveProperty("prHeadSha");
  });
});

describe("canonicalGitCommitSha", () => {
  it("normalizes SHA-1 and SHA-256 ids but rejects abbreviated and non-hex values", () => {
    expect(canonicalGitCommitSha("A".repeat(40))).toBe("a".repeat(40));
    expect(canonicalGitCommitSha("b".repeat(64))).toBe("b".repeat(64));
    expect(canonicalGitCommitSha("a".repeat(39))).toBeNull();
    expect(canonicalGitCommitSha("z".repeat(40))).toBeNull();
  });
});
