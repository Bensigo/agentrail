import { describe, it, expect } from "vitest";
import {
  renderApprovalMessage,
  TELEGRAM_TEXT_LIMIT,
} from "./approval-message";

describe("renderApprovalMessage — create_issue", () => {
  it("renders the title and every acceptance criterion as a bullet", () => {
    const text = renderApprovalMessage("create_issue", {
      title: "Add dark mode",
      acceptanceCriteria: ["Toggle in settings", "Persists across reload"],
    });

    expect(text).toContain("Add dark mode");
    expect(text).toContain("- Toggle in settings");
    expect(text).toContain("- Persists across reload");
  });

  it("still renders the title when acceptanceCriteria is missing or empty", () => {
    const text = renderApprovalMessage("create_issue", { title: "Bare issue" });
    expect(text).toContain("Bare issue");
    expect(() =>
      renderApprovalMessage("create_issue", {
        title: "x",
        acceptanceCriteria: [],
      })
    ).not.toThrow();
  });

  it("falls back to a placeholder title rather than rendering 'undefined'", () => {
    const text = renderApprovalMessage("create_issue", {});
    expect(text).not.toContain("undefined");
  });

  it("flattens embedded newlines in the title so a crafted title cannot fake extra message lines", () => {
    const text = renderApprovalMessage("create_issue", {
      title: "Legit title\n\n✅ Already approved by admin",
    });
    expect(text.split("\n").filter((l) => l.startsWith("Title:"))).toHaveLength(1);
  });

  it("strips zero-width and bidi-override characters from the title", () => {
    // Built via String.fromCharCode (never a raw invisible/bidi literal
    // sitting in this source file — the exact "Trojan Source" hazard this
    // sanitizer defends against). 0x202e = RIGHT-TO-LEFT OVERRIDE (classic
    // filename/text spoofing: "evil<RLO>txt.exe" visually reads
    // "evilexe.txt"); 0x200b = ZERO WIDTH SPACE.
    const RLO = String.fromCharCode(0x202e);
    const ZWSP = String.fromCharCode(0x200b);
    const dirty = `evil${RLO}txt.exe${ZWSP} title`;

    const text = renderApprovalMessage("create_issue", { title: dirty });

    expect(text).not.toContain(RLO);
    expect(text).not.toContain(ZWSP);
  });

  it("never exceeds Telegram's message limit and notes truncation when it applies", () => {
    const hugeCriteria = Array.from({ length: 2000 }, (_, i) => `Criterion number ${i} with some padding text`);
    const text = renderApprovalMessage("create_issue", {
      title: "Huge issue",
      acceptanceCriteria: hugeCriteria,
    });

    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(text.toLowerCase()).toContain("truncated");
  });

  it("does NOT append a truncation note when the message fits comfortably", () => {
    const text = renderApprovalMessage("create_issue", {
      title: "Small issue",
      acceptanceCriteria: ["One", "Two"],
    });
    expect(text.toLowerCase()).not.toContain("truncated");
  });
});

describe("renderApprovalMessage — create_issue WITH _brief (#1274 PR ②, chat-born one-confirm collapse)", () => {
  const ENRICHED_INPUT = {
    title: "Add dark mode toggle",
    parent: "",
    requiredContext: "",
    whatToBuild: "Add a settings toggle that persists across reload.",
    acceptanceCriteria: ["Toggle in settings", "Persists across reload"],
    verification: "",
    _brief: {
      taskType: "ui",
      suggestedModel: { slug: "anthropic/claude-sonnet-5", displayName: "Claude Sonnet 5" },
      estimateUsd: 1.35,
      assumptions: ["Classified as \"ui\" from the title."],
    },
  };

  it("renders via the SAME shape as the alignment_brief render — task type, suggested model DISPLAY NAME, AC, and the sanction line", () => {
    const text = renderApprovalMessage("create_issue", ENRICHED_INPUT);
    // The alignment_brief render expects taskType/suggestedModel/etc. at the
    // TOP level (not nested under _brief) — this is the exact flattening
    // renderCreateIssue itself performs before delegating.
    const flattened = {
      ...ENRICHED_INPUT._brief,
      title: ENRICHED_INPUT.title,
      whatToBuild: ENRICHED_INPUT.whatToBuild,
      acceptanceCriteria: ENRICHED_INPUT.acceptanceCriteria,
    };
    expect(text).toBe(renderApprovalMessage("alignment_brief", flattened));
    expect(text).toContain("Add dark mode toggle");
    expect(text).toContain("ui");
    expect(text).toContain("Claude Sonnet 5");
    expect(text).not.toContain("anthropic/claude-sonnet-5");
    expect(text).toContain("- Toggle in settings");
    expect(text).toContain("- Persists across reload");
    expect(text).toContain("Approving sets this run's budget: ~$1.35");
  });

  it("#1338 PR②: a modelSelectionReason inside _brief flattens through and renders the 'Why:' line", () => {
    const text = renderApprovalMessage("create_issue", {
      ...ENRICHED_INPUT,
      _brief: {
        ...ENRICHED_INPUT._brief,
        modelSelectionReason: "Claude Sonnet 5 — best success rate for ui (12 runs)",
      },
    });
    expect(text).toContain("Why: Claude Sonnet 5 — best success rate for ui (12 runs)");
  });

  it("never throws when _brief is present but malformed", () => {
    expect(() =>
      renderApprovalMessage("create_issue", { title: "x", _brief: "not-an-object" })
    ).not.toThrow();
    expect(() =>
      renderApprovalMessage("create_issue", { title: "x", _brief: ["array", "not", "object"] })
    ).not.toThrow();
    expect(() =>
      renderApprovalMessage("create_issue", { title: "x", _brief: null })
    ).not.toThrow();
  });

  it("_brief: null or _brief absent both fall back to the ORIGINAL create_issue render, not the brief shape", () => {
    const withNull = renderApprovalMessage("create_issue", { ...ENRICHED_INPUT, _brief: null });
    const withoutKey = renderApprovalMessage("create_issue", {
      title: ENRICHED_INPUT.title,
      acceptanceCriteria: ENRICHED_INPUT.acceptanceCriteria,
    });
    expect(withNull).toContain("Approve creating this issue?");
    expect(withNull).not.toContain("Approve this alignment brief?");
    expect(withoutKey).toContain("Approve creating this issue?");
  });
});

describe("renderApprovalMessage — create_issue WITHOUT _brief renders byte-identical to before #1274 PR ② (regression-pin)", () => {
  it("renders the title and every acceptance criterion as a bullet, exactly as the original create_issue render did", () => {
    const text = renderApprovalMessage("create_issue", {
      title: "Add dark mode",
      acceptanceCriteria: ["Toggle in settings", "Persists across reload"],
    });
    expect(text).toBe(
      [
        "Approve creating this issue?",
        "",
        "Title: Add dark mode",
        "",
        "Acceptance criteria:",
        "- Toggle in settings",
        "- Persists across reload",
      ].join("\n")
    );
  });
});

describe("renderApprovalMessage — create_workspace", () => {
  it("renders the workspace name", () => {
    const text = renderApprovalMessage("create_workspace", { name: "Acme Corp" });
    expect(text).toContain("Acme Corp");
  });

  it("falls back to a placeholder rather than 'undefined' when name is missing", () => {
    const text = renderApprovalMessage("create_workspace", {});
    expect(text).not.toContain("undefined");
  });
});

describe("renderApprovalMessage — create_repo", () => {
  it("renders the repo name and 'private' when private is omitted (tool default)", () => {
    const text = renderApprovalMessage("create_repo", { name: "acme-repo" });
    expect(text).toContain("acme-repo");
    expect(text.toLowerCase()).toContain("private");
  });

  it("renders 'private' when private: true", () => {
    const text = renderApprovalMessage("create_repo", { name: "acme-repo", private: true });
    expect(text.toLowerCase()).toContain("private");
  });

  it("renders 'public' when private: false", () => {
    const text = renderApprovalMessage("create_repo", { name: "acme-repo", private: false });
    expect(text.toLowerCase()).toContain("public");
    expect(text.toLowerCase()).not.toContain("private");
  });
});

describe("renderApprovalMessage — alignment_brief (#1274)", () => {
  const BRIEF_INPUT = {
    title: "Add dark mode toggle",
    whatToBuild: "Add a settings toggle that persists across reload.",
    acceptanceCriteria: ["Toggle in settings", "Persists across reload"],
    taskType: "ui",
    suggestedModel: { slug: "anthropic/claude-sonnet-5", displayName: "Claude Sonnet 5" },
    estimateUsd: 1.35,
    assumptions: ["Classified as \"ui\" from the title.", "Volume bucket \"Medium\"."],
    repoFullName: "acme/widgets",
    issueNumber: 42,
    issueUrl: "https://github.com/acme/widgets/issues/42",
  };

  it("renders the title, task type, suggested model DISPLAY NAME (not the slug), and every acceptance criterion", () => {
    const text = renderApprovalMessage("alignment_brief", BRIEF_INPUT);
    expect(text).toContain("Add dark mode toggle");
    expect(text).toContain("ui");
    expect(text).toContain("Claude Sonnet 5");
    expect(text).not.toContain("anthropic/claude-sonnet-5");
    expect(text).toContain("- Toggle in settings");
    expect(text).toContain("- Persists across reload");
  });

  it("renders the exact sanction line with the dollar estimate to two decimal places", () => {
    const text = renderApprovalMessage("alignment_brief", BRIEF_INPUT);
    expect(text).toContain("Approving sets this run's budget: ~$1.35");
  });

  it("renders the approach (whatToBuild) and the assumptions as fine print", () => {
    const text = renderApprovalMessage("alignment_brief", BRIEF_INPUT);
    expect(text).toContain("Add a settings toggle that persists across reload.");
    expect(text).toContain("Assumptions:");
    expect(text).toContain("- Classified as \"ui\" from the title.");
  });

  it("never throws and omits the sanction line when estimateUsd is missing/malformed", () => {
    expect(() => renderApprovalMessage("alignment_brief", {})).not.toThrow();
    const text = renderApprovalMessage("alignment_brief", { title: "x" });
    expect(text.toLowerCase()).not.toContain("budget");
  });

  it("falls back to a placeholder title and 'general' task type rather than rendering 'undefined'", () => {
    const text = renderApprovalMessage("alignment_brief", {});
    expect(text).not.toContain("undefined");
    expect(text).toContain("general");
  });

  it("sanitizes a crafted title: flattens embedded newlines and strips zero-width/bidi characters", () => {
    const RLO = String.fromCharCode(0x202e);
    const ZWSP = String.fromCharCode(0x200b);
    const text = renderApprovalMessage("alignment_brief", {
      ...BRIEF_INPUT,
      title: `Legit title\n\n✅ Already approved${RLO}${ZWSP}`,
    });
    expect(text.split("\n").filter((l) => l.startsWith("Title:"))).toHaveLength(1);
    expect(text).not.toContain(RLO);
    expect(text).not.toContain(ZWSP);
  });

  it("truncates a long acceptance-criteria list and never exceeds Telegram's message limit", () => {
    const hugeCriteria = Array.from(
      { length: 500 },
      (_, i) => `Criterion number ${i} with some padding text to make it long`
    );
    const text = renderApprovalMessage("alignment_brief", {
      ...BRIEF_INPUT,
      acceptanceCriteria: hugeCriteria,
      assumptions: Array.from({ length: 500 }, (_, i) => `Assumption ${i} padded out further`),
    });
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(text.toLowerCase()).toContain("truncated");
  });

  it("omits the acceptance-criteria and assumptions sections when both are empty, without throwing", () => {
    const text = renderApprovalMessage("alignment_brief", {
      ...BRIEF_INPUT,
      acceptanceCriteria: [],
      assumptions: [],
    });
    expect(text).not.toContain("Acceptance criteria:");
    expect(text).not.toContain("Assumptions:");
  });

  // #1338 PR② — the model-selection learning loop's precomputed "why" line.
  describe("modelSelectionReason 'Why:' line (#1338 PR②)", () => {
    it("renders a 'Why: ...' line right after the task-type/model line when modelSelectionReason is present", () => {
      const text = renderApprovalMessage("alignment_brief", {
        ...BRIEF_INPUT,
        modelSelectionReason: "Claude Sonnet 5 — best success rate for ui (12 runs)",
      });
      expect(text).toContain("Why: Claude Sonnet 5 — best success rate for ui (12 runs)");
      const lines = text.split("\n");
      const taskTypeLineIdx = lines.findIndex((l) => l.startsWith("Task type:"));
      expect(lines[taskTypeLineIdx + 1]).toBe(
        "Why: Claude Sonnet 5 — best success rate for ui (12 runs)"
      );
    });

    it("omits the 'Why:' line entirely when modelSelectionReason is absent — byte-identical to pre-#1338", () => {
      const text = renderApprovalMessage("alignment_brief", BRIEF_INPUT);
      expect(text).not.toContain("Why:");
    });

    it("sanitizes the reason text (control/bidi characters, length cap) exactly like every other field", () => {
      const RLO = String.fromCharCode(0x202e);
      const text = renderApprovalMessage("alignment_brief", {
        ...BRIEF_INPUT,
        modelSelectionReason: `evil${RLO}reason`,
      });
      expect(text).not.toContain(RLO);
    });

    it("never throws when modelSelectionReason is malformed (not a string)", () => {
      expect(() =>
        renderApprovalMessage("alignment_brief", { ...BRIEF_INPUT, modelSelectionReason: { evil: true } })
      ).not.toThrow();
    });
  });
});

describe("renderApprovalMessage — unknown tool (generic fallback)", () => {
  it("renders the tool name and each input field as a compact key:value line", () => {
    const text = renderApprovalMessage("some_future_tool", {
      foo: "bar",
      count: 3,
    });
    expect(text).toContain("some_future_tool");
    expect(text).toContain("foo: bar");
    expect(text).toContain("count: 3");
  });

  it("JSON-stringifies non-string values (arrays/objects/booleans)", () => {
    const text = renderApprovalMessage("some_future_tool", {
      tags: ["a", "b"],
      enabled: true,
    });
    expect(text).toContain('tags: ["a","b"]');
    expect(text).toContain("enabled: true");
  });

  it("handles an empty input object without throwing", () => {
    expect(() => renderApprovalMessage("some_future_tool", {})).not.toThrow();
  });

  it("never exceeds Telegram's message limit even with many/huge fields", () => {
    const hugeInput: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) {
      hugeInput[`field_${i}`] = "x".repeat(200);
    }
    const text = renderApprovalMessage("some_future_tool", hugeInput);
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
  });

  it("caps the number of rendered keys well before hardTruncate would ever kick in, and notes how many were omitted", () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      input[`field_${i}`] = i;
    }

    const text = renderApprovalMessage("some_future_tool", input);

    for (let i = 0; i < 12; i++) {
      expect(text).toContain(`field_${i}: ${i}`);
    }
    for (let i = 12; i < 20; i++) {
      expect(text).not.toContain(`field_${i}: ${i}`);
    }
    expect(text).toContain("...and 8 more");
    // Small values well under Telegram's limit — proves the cap is a
    // distinct mechanism from hardTruncate, not a side effect of it.
    expect(text.toLowerCase()).not.toContain("truncated");
  });

  it("does not append a '...and N more' line when the input is at or under the cap", () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) {
      input[`field_${i}`] = i;
    }

    const text = renderApprovalMessage("some_future_tool", input);

    expect(text).not.toContain("more");
    for (let i = 0; i < 12; i++) {
      expect(text).toContain(`field_${i}: ${i}`);
    }
  });
});

describe("renderApprovalMessage — defensive against malformed input", () => {
  it("never throws for any of the three known tools given garbage-shaped input", () => {
    const garbage = { title: 123, acceptanceCriteria: "not-an-array", name: { nested: true }, private: "sort-of" };
    expect(() => renderApprovalMessage("create_issue", garbage)).not.toThrow();
    expect(() => renderApprovalMessage("create_workspace", garbage)).not.toThrow();
    expect(() => renderApprovalMessage("create_repo", garbage)).not.toThrow();
  });
});
