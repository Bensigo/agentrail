import { describe, it, expect } from "vitest";
import {
  parseAcceptanceCriteriaForBrief,
  composeAlignmentBrief,
  composeChatBornBrief,
  extractConfirmedBudgetAndModel,
} from "./alignment-brief";
import { estimateBrief } from "./alignment";

describe("parseAcceptanceCriteriaForBrief: tolerant AC extraction", () => {
  it("extracts checkbox criteria from a house-format '## Acceptance criteria' section", () => {
    const body = "## Acceptance criteria\n- [ ] first\n- [x] second\n";
    expect(parseAcceptanceCriteriaForBrief(body)).toEqual(["first", "second"]);
  });

  it("is tolerant of an ABSENT Acceptance criteria section — returns [] rather than throwing", () => {
    expect(() => parseAcceptanceCriteriaForBrief("## Summary\nno AC here\n")).not.toThrow();
    expect(parseAcceptanceCriteriaForBrief("## Summary\nno AC here\n")).toEqual([]);
  });

  it("is tolerant of an empty body", () => {
    expect(parseAcceptanceCriteriaForBrief("")).toEqual([]);
  });

  it("is tolerant of a present-but-prose-only Acceptance criteria section (no checkboxes)", () => {
    const body = "## Acceptance criteria\nIt should feel fast.\n";
    expect(parseAcceptanceCriteriaForBrief(body)).toEqual([]);
  });
});

describe("composeAlignmentBrief", () => {
  const BASE = {
    title: "Add dark mode toggle",
    body: "## Acceptance criteria\n- [ ] Toggle in settings\n- [ ] Persists across reload\n",
    repoFullName: "acme/widgets",
    issueNumber: 42,
    issueUrl: "https://github.com/acme/widgets/issues/42",
  };

  it("carries title/repo/issue reference straight through", () => {
    const brief = composeAlignmentBrief(BASE);
    expect(brief.title).toBe(BASE.title);
    expect(brief.repoFullName).toBe("acme/widgets");
    expect(brief.issueNumber).toBe(42);
    expect(brief.issueUrl).toBe("https://github.com/acme/widgets/issues/42");
  });

  it("stores the FULL body under whatToBuild, not a pre-truncated excerpt", () => {
    const longBody =
      "## Acceptance criteria\n- [ ] a\n" + "x".repeat(5000);
    const brief = composeAlignmentBrief({ ...BASE, body: longBody });
    expect(brief.whatToBuild).toBe(longBody);
    expect(brief.whatToBuild.length).toBeGreaterThan(4000);
  });

  it("parses acceptance criteria via the tolerant parser", () => {
    const brief = composeAlignmentBrief(BASE);
    expect(brief.acceptanceCriteria).toEqual([
      "Toggle in settings",
      "Persists across reload",
    ]);
  });

  it("degrades gracefully (no throw, taskType still resolves) when the body has no AC section", () => {
    const brief = composeAlignmentBrief({ ...BASE, body: "no AC section here" });
    expect(brief.acceptanceCriteria).toEqual([]);
    expect(typeof brief.taskType).toBe("string");
    expect(brief.estimateUsd).toBeGreaterThan(0);
  });

  it("matches estimateBrief's own output exactly for the same input (no drift between the two)", () => {
    const brief = composeAlignmentBrief(BASE);
    const directEstimate = estimateBrief({
      title: BASE.title,
      whatToBuild: BASE.body,
      acceptanceCriteria: ["Toggle in settings", "Persists across reload"],
    });
    expect(brief.taskType).toBe(directEstimate.taskType);
    expect(brief.estimateUsd).toBe(directEstimate.estimateUsd);
    expect(brief.suggestedModel).toEqual({
      slug: directEstimate.suggestedModel.slug,
      displayName: directEstimate.suggestedModel.displayName,
    });
    expect(brief.assumptions).toEqual(directEstimate.assumptions);
  });

  it("classifies a UI-shaped issue as taskType 'ui' with a non-zero estimate", () => {
    const brief = composeAlignmentBrief({
      ...BASE,
      title: "Build a new settings page",
    });
    expect(brief.taskType).toBe("ui");
    expect(brief.suggestedModel.slug).toBeTruthy();
    expect(brief.suggestedModel.displayName).toBeTruthy();
  });
});

describe("composeChatBornBrief (#1274 PR ②)", () => {
  const CHAT_BORN = {
    title: "Add dark mode toggle",
    whatToBuild: "Add a settings toggle that persists across reload.",
    acceptanceCriteria: ["Toggle in settings", "Persists across reload"],
  };

  it("matches estimateBrief's own output exactly for the same input (no drift between the two)", () => {
    const brief = composeChatBornBrief(CHAT_BORN);
    const directEstimate = estimateBrief(CHAT_BORN);
    expect(brief.taskType).toBe(directEstimate.taskType);
    expect(brief.estimateUsd).toBe(directEstimate.estimateUsd);
    expect(brief.suggestedModel).toEqual({
      slug: directEstimate.suggestedModel.slug,
      displayName: directEstimate.suggestedModel.displayName,
    });
    expect(brief.assumptions).toEqual(directEstimate.assumptions);
  });

  it("never includes title/whatToBuild/acceptanceCriteria — those already live on create_issue's own toolInput", () => {
    const brief = composeChatBornBrief(CHAT_BORN);
    expect(brief).not.toHaveProperty("title");
    expect(brief).not.toHaveProperty("whatToBuild");
    expect(brief).not.toHaveProperty("acceptanceCriteria");
  });

  it("never includes repoFullName/issueNumber/issueUrl — no issue exists yet at approval-record time", () => {
    const brief = composeChatBornBrief(CHAT_BORN);
    expect(brief).not.toHaveProperty("repoFullName");
    expect(brief).not.toHaveProperty("issueNumber");
    expect(brief).not.toHaveProperty("issueUrl");
  });

  it("estimateUsd is always > 0 for a well-formed input (never a silent 0)", () => {
    const brief = composeChatBornBrief(CHAT_BORN);
    expect(brief.estimateUsd).toBeGreaterThan(0);
  });

  it("classifies a mechanical-shaped task distinctly from a UI-shaped one", () => {
    const ui = composeChatBornBrief({ ...CHAT_BORN, title: "Build a new settings page" });
    const mechanical = composeChatBornBrief({
      ...CHAT_BORN,
      title: "Rename a variable across the codebase",
      whatToBuild: "Simple find-and-replace rename, no logic change.",
    });
    expect(ui.taskType).toBe("ui");
    expect(mechanical.taskType).not.toBe("ui");
  });

  it("degrades gracefully (no throw) with an empty acceptanceCriteria array", () => {
    expect(() =>
      composeChatBornBrief({ title: "x", whatToBuild: "y", acceptanceCriteria: [] })
    ).not.toThrow();
  });

  it("the output round-trips through extractConfirmedBudgetAndModel (the shape the confirm side-effect reads back)", () => {
    const brief = composeChatBornBrief(CHAT_BORN);
    const extracted = extractConfirmedBudgetAndModel(brief as unknown as Record<string, unknown>);
    expect(extracted).toEqual({
      estimatedBudgetUsd: brief.estimateUsd,
      modelOverride: brief.suggestedModel.slug,
    });
  });
});

describe("extractConfirmedBudgetAndModel", () => {
  it("extracts estimateUsd + suggestedModel.slug from a well-formed toolInput", () => {
    const result = extractConfirmedBudgetAndModel({
      estimateUsd: 1.35,
      suggestedModel: { slug: "anthropic/claude-sonnet-5", displayName: "Claude Sonnet 5" },
    });
    expect(result).toEqual({ estimatedBudgetUsd: 1.35, modelOverride: "anthropic/claude-sonnet-5" });
  });

  it("returns null when estimateUsd is missing", () => {
    expect(
      extractConfirmedBudgetAndModel({ suggestedModel: { slug: "x" } })
    ).toBeNull();
  });

  it("returns null when estimateUsd is not a finite number (NaN/Infinity/string)", () => {
    expect(
      extractConfirmedBudgetAndModel({ estimateUsd: NaN, suggestedModel: { slug: "x" } })
    ).toBeNull();
    expect(
      extractConfirmedBudgetAndModel({ estimateUsd: Infinity, suggestedModel: { slug: "x" } })
    ).toBeNull();
    expect(
      extractConfirmedBudgetAndModel({ estimateUsd: "1.35", suggestedModel: { slug: "x" } })
    ).toBeNull();
  });

  it("returns null when suggestedModel is missing, not an object, or an array", () => {
    expect(extractConfirmedBudgetAndModel({ estimateUsd: 1 })).toBeNull();
    expect(
      extractConfirmedBudgetAndModel({ estimateUsd: 1, suggestedModel: "x" })
    ).toBeNull();
    expect(
      extractConfirmedBudgetAndModel({ estimateUsd: 1, suggestedModel: ["x"] })
    ).toBeNull();
    expect(
      extractConfirmedBudgetAndModel({ estimateUsd: 1, suggestedModel: null })
    ).toBeNull();
  });

  it("returns null when suggestedModel.slug is missing or not a non-empty string", () => {
    expect(
      extractConfirmedBudgetAndModel({ estimateUsd: 1, suggestedModel: {} })
    ).toBeNull();
    expect(
      extractConfirmedBudgetAndModel({ estimateUsd: 1, suggestedModel: { slug: "" } })
    ).toBeNull();
    expect(
      extractConfirmedBudgetAndModel({ estimateUsd: 1, suggestedModel: { slug: 42 } })
    ).toBeNull();
  });

  it("never throws on a malformed/adversarial toolInput", () => {
    expect(() => extractConfirmedBudgetAndModel({})).not.toThrow();
    expect(() => extractConfirmedBudgetAndModel({ estimateUsd: {} })).not.toThrow();
  });
});
