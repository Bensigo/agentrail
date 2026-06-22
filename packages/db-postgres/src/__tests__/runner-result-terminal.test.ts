import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * recordRunnerResult terminalState (#888 notify trap). The route notifies ONLY
 * when terminalState is non-null, so these assert the green/running branch:
 *   - green   → terminalState 'green' (terminal)
 *   - running → null (heartbeat, NOT terminal → no notify)
 * The red/error branch is covered in runner-result-sql.test.ts. The db is mocked
 * to drive the `update().set().where().returning()` chain the green/running path
 * uses, returning the committed state so terminalState is read back, not guessed.
 */

let returnedState = "green";

vi.mock("../db.js", () => ({
  db: {
    // green/running path: chainable update; returning() yields the committed row.
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () =>
            Promise.resolve([{ id: "x", state: returnedState, externalId: "o/r#42" }]),
        }),
      }),
    }),
    // The tail `runs` mirror also calls update().set().where() (no returning).
    // The chain above already resolves where() to an object; the runs mirror
    // awaits where() directly, so make where() thenable-compatible by returning
    // a promise-like. To keep both shapes working we special-case below.
  },
}));

import { recordRunnerResult } from "../queries/runner.js";

beforeEach(() => {
  returnedState = "green";
});

describe("recordRunnerResult terminalState (green / running)", () => {
  it("green → terminalState 'green' and updated true", async () => {
    returnedState = "green";
    const res = await recordRunnerResult({ id: "1", workspaceId: "w", status: "green" });
    expect(res.updated).toBe(true);
    expect(res.terminalState).toBe("green");
    expect(res.externalId).toBe("o/r#42");
  });

  it("running → terminalState null (heartbeat, no notify)", async () => {
    returnedState = "running";
    const res = await recordRunnerResult({ id: "1", workspaceId: "w", status: "running" });
    expect(res.updated).toBe(true);
    expect(res.terminalState).toBeNull();
  });
});
