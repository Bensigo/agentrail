import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./_conversation-demo.tsx", import.meta.url), "utf8");
const dataSource = readFileSync(new URL("./_conversation-demo-data.ts", import.meta.url), "utf8");

describe("conversation demo — acceptance contract", () => {
  it("shows confirmation and the external builder handoff", () => {
    expect(source).toContain("✅ Confirm contract");
    expect(source).toContain("Contract confirmed by you");
    expect(dataSource).toContain("bounded Context Pack");
    expect(dataSource).toContain("external builder");
  });

  it("contains no legacy estimate, model, execution, or delivery outcome claims", () => {
    const combined = `${source}\n${dataSource}`.toLowerCase();
    for (const retired of ["estimate", "suggested model", "pr ready", "pull request", "run outcome", "approve"]) {
      expect(combined).not.toContain(retired);
    }
  });
});
