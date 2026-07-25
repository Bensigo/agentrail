import { describe, expect, it } from "vitest";
import { linkedIdentitiesLine } from "./linked-identities";

describe("linkedIdentitiesLine (shared by the Gateways page and the setup wizard's channel step — see linked-identities.ts's module doc-comment for lineage)", () => {
  it("lists comma-joined display names when every identity has one", () => {
    expect(linkedIdentitiesLine(["Ben", "Ada"])).toBe("Linked: Ben, Ada");
  });

  it("a single named identity needs no +N suffix", () => {
    expect(linkedIdentitiesLine(["Ben"])).toBe("Linked: Ben");
  });

  it("falls back to a bare count when none of the identities have a display name", () => {
    expect(linkedIdentitiesLine([null, null])).toBe("2 linked");
  });

  it("folds nameless identities into a trailing +N alongside the named ones", () => {
    expect(linkedIdentitiesLine(["Ben", null, null])).toBe("Linked: Ben +2");
  });

  it("an empty list reads as 0 linked — total, never throws", () => {
    expect(linkedIdentitiesLine([])).toBe("0 linked");
  });
});
