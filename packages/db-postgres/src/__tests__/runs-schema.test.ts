import { describe, expect, it } from "vitest";
import { runs } from "../schema/runs.js";

describe("runs schema", () => {
  it("defines nullable runner_name with an empty string default", () => {
    expect(runs.runnerName.name).toBe("runner_name");
    expect(runs.runnerName.notNull).toBe(false);
    expect(runs.runnerName.default).toBe("");
  });
});
