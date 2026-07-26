import { describe, expect, it } from "vitest";
import { RUN_FAMILY_VALUES, runs } from "../schema/runs.js";

describe("runs schema", () => {
  it("defines nullable runner_name with an empty string default", () => {
    expect(runs.runnerName.name).toBe("runner_name");
    expect(runs.runnerName.notNull).toBe(false);
    expect(runs.runnerName.default).toBe("");
  });

  // Issue #1223 AC4: the `family` column tags a run with what KIND of task
  // it is, so solve-rate/$-per-solved can be sliced by family later. Nullable
  // (no source classifies a live GitHub issue's family yet) but validated
  // against the fixed vocabulary when set (see the CHECK constraint below).
  it("defines a nullable family column with no default", () => {
    expect(runs.family.name).toBe("family");
    expect(runs.family.notNull).toBe(false);
    expect(runs.family.default).toBeUndefined();
  });

  it("exposes the fixed family vocabulary, kept in lockstep with the Python side", () => {
    // Mirrors agentrail/shared/task_family.py's TASK_FAMILY_VALUES exactly —
    // a live run and a corpus task must never speak two different
    // vocabularies for the same concept.
    expect(RUN_FAMILY_VALUES).toEqual([
      "bug",
      "feature",
      "refactor",
      "test",
      "infra",
    ]);
  });
});
