import { describe, it, expect } from "vitest";
import { scopeForEstimate, scopeSentence, scopeFieldValue } from "./approval-scope";

// Subscription-platform slice 6 Task 5 (plan
// docs/superpowers/plans/2026-07-31-subscription-console-slice6.md, Global
// Constraints): single source of the scope thresholds/wording every
// approval surface reads from — the chat/Telegram sanction line
// (`approval-message.ts`), the console Approvals page mirror
// (`approvals-helpers.ts`), and the landing demo
// (`(marketing)/_conversation-demo.tsx`). Boundaries pinned exhaustively
// here so no call site ever needs to re-derive or re-test them.

describe("scopeForEstimate — thresholds (<2 small, <6 medium, else large)", () => {
  it("0 is small", () => {
    expect(scopeForEstimate(0)).toBe("small");
  });

  it("1.99 is small (just under the small/medium boundary)", () => {
    expect(scopeForEstimate(1.99)).toBe("small");
  });

  it("exactly 2 is medium, NOT small — the boundary is < 2, not <= 2", () => {
    expect(scopeForEstimate(2)).toBe("medium");
  });

  it("5.99 is medium (just under the medium/large boundary)", () => {
    expect(scopeForEstimate(5.99)).toBe("medium");
  });

  it("exactly 6 is large, NOT medium — the boundary is < 6, not <= 6", () => {
    expect(scopeForEstimate(6)).toBe("large");
  });

  it("well above 6 is large", () => {
    expect(scopeForEstimate(42)).toBe("large");
  });
});

describe("scopeSentence — byte-exact wording, never a dollar sign", () => {
  it("small: 'Approving starts a small task.'", () => {
    expect(scopeSentence(1.35)).toBe("Approving starts a small task.");
  });

  it("medium: 'Approving starts a medium task.'", () => {
    expect(scopeSentence(4.2)).toBe("Approving starts a medium task.");
  });

  it("large: 'Approving starts a large task.'", () => {
    expect(scopeSentence(12)).toBe("Approving starts a large task.");
  });

  it("never contains a dollar sign, at any threshold", () => {
    expect(scopeSentence(0)).not.toContain("$");
    expect(scopeSentence(2)).not.toContain("$");
    expect(scopeSentence(6)).not.toContain("$");
    expect(scopeSentence(999)).not.toContain("$");
  });
});

describe("scopeFieldValue — byte-exact Title Case, never a dollar sign", () => {
  it("small: 'Small task'", () => {
    expect(scopeFieldValue(1.35)).toBe("Small task");
  });

  it("medium: 'Medium task'", () => {
    expect(scopeFieldValue(4.2)).toBe("Medium task");
  });

  it("large: 'Large task'", () => {
    expect(scopeFieldValue(12)).toBe("Large task");
  });

  it("never contains a dollar sign, at any threshold", () => {
    expect(scopeFieldValue(0)).not.toContain("$");
    expect(scopeFieldValue(2)).not.toContain("$");
    expect(scopeFieldValue(6)).not.toContain("$");
    expect(scopeFieldValue(999)).not.toContain("$");
  });
});
