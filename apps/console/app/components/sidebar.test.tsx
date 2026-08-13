import { describe, expect, it } from "vitest";
import { resolvePrimaryNavItems } from "./sidebar";
import { YOUR_ENGINEER_ZONE } from "./sidebar-nav";

describe("resolvePrimaryNavItems", () => {
  it("returns the Trust Layer destinations in their configured order", () => {
    expect(resolvePrimaryNavItems()).toBe(YOUR_ENGINEER_ZONE.items);
    expect(resolvePrimaryNavItems().map((item) => item.href)).toEqual([
      "",
      "briefs",
      "changes",
      "approvals",
    ]);
  });

  it("does not expose legacy Chat or Goals even when their route flags are enabled", () => {
    const hrefs = resolvePrimaryNavItems({
      chatEnabled: true,
      goalsEnabled: true,
    }).map((item) => item.href);

    expect(hrefs).not.toContain("chat");
    expect(hrefs).not.toContain("goals");
    expect(hrefs).not.toContain("work");
  });
});
