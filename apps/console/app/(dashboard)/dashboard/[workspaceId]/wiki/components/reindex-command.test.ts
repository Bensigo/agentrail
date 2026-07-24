import { describe, it, expect } from "vitest";
import { reindexCommand } from "./reindex-command";

describe("reindexCommand", () => {
  it("returns the context index command", () => {
    expect(reindexCommand()).toBe("agentrail context index");
  });
});
