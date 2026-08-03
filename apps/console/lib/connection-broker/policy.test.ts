import { describe, expect, it } from "vitest";
import { canUseConnectorTool } from "./policy";

describe("connector subagent policy", () => {
  it("keeps debugger reads allowed and writes blocked", () => {
    expect(canUseConnectorTool({ subagent: "debugger", toolset: "observability", mutates: false })).toBe(true);
    expect(canUseConnectorTool({ subagent: "debugger", toolset: "write", mutates: true })).toBe(false);
  });

  it("requires an approval for reviewer and implementer writes", () => {
    expect(canUseConnectorTool({ subagent: "reviewer", toolset: "review", mutates: true })).toBe(false);
    expect(canUseConnectorTool({ subagent: "reviewer", toolset: "review", mutates: true, approvalGranted: true })).toBe(true);
    expect(canUseConnectorTool({ subagent: "implementer", toolset: "write", mutates: true, approvalGranted: true })).toBe(true);
  });

  it("keeps researcher and qa scoped to their toolsets", () => {
    expect(canUseConnectorTool({ subagent: "researcher", toolset: "docs", mutates: false })).toBe(true);
    expect(canUseConnectorTool({ subagent: "researcher", toolset: "write", mutates: false })).toBe(false);
    expect(canUseConnectorTool({ subagent: "qa", toolset: "browser", mutates: false })).toBe(true);
    expect(canUseConnectorTool({ subagent: "qa", toolset: "write", mutates: true, approvalGranted: true })).toBe(false);
  });
});
