import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./_conversation-demo.tsx", import.meta.url), "utf8");
const dataSource = readFileSync(new URL("./_conversation-demo-data.ts", import.meta.url), "utf8");

describe("conversation demo — acceptance contract", () => {
  it("shows human confirmation and a coding-agent handoff", () => {
    expect(source).toContain("✅ Confirm plan");
    expect(source).toContain("Plan confirmed by you");
    expect(dataSource).toContain("coding agent");
    expect(dataSource).not.toContain("bounded Context Pack");
    expect(dataSource).not.toContain("external builder");
  });

  it("contains no legacy estimate, model, execution, or delivery outcome claims", () => {
    const combined = `${source}\n${dataSource}`.toLowerCase();
    for (const retired of ["estimate", "suggested model", "pr ready", "pull request", "run outcome", "approve"]) {
      expect(combined).not.toContain(retired);
    }
  });
});
