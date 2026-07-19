import { describe, it, expect } from "vitest";
import { ALIGNMENT_DENIED_PARK_REASON, ALIGNMENT_PARK_REASON } from "@agentrail/db-postgres";
import {
  formatRelativeTime,
  truncate,
  summarizeApprovalToolInput,
  toolLabel,
  channelLabel,
  isAlignmentParkReason,
} from "./approvals-helpers";

describe("formatRelativeTime", () => {
  const now = new Date("2026-07-19T12:00:00Z");

  it("renders 'just now' for under a minute", () => {
    expect(formatRelativeTime(new Date("2026-07-19T11:59:31Z"), now).label).toBe("just now");
  });

  it("renders minutes for under an hour", () => {
    expect(formatRelativeTime(new Date("2026-07-19T11:45:00Z"), now).label).toBe("15m ago");
  });

  it("renders hours for under a day", () => {
    expect(formatRelativeTime(new Date("2026-07-19T09:00:00Z"), now).label).toBe("3h ago");
  });

  it("renders days beyond a day", () => {
    expect(formatRelativeTime(new Date("2026-07-16T12:00:00Z"), now).label).toBe("3d ago");
  });

  it("accepts an ISO string, not just a Date (QueueEntryListItem.updatedAt shape)", () => {
    expect(formatRelativeTime("2026-07-19T11:45:00Z", now).label).toBe("15m ago");
  });

  it("carries the absolute time as the hover title", () => {
    const result = formatRelativeTime(new Date("2026-07-19T11:45:00Z"), now);
    expect(result.title).toBe(new Date("2026-07-19T11:45:00Z").toLocaleString());
  });
});

describe("truncate", () => {
  it("leaves a short string untouched", () => {
    expect(truncate("short", 10)).toBe("short");
  });

  it("cuts a long string and marks it truncated", () => {
    expect(truncate("a very long error message", 10)).toBe("a very lon…");
  });

  it("never throws on an empty string", () => {
    expect(truncate("", 10)).toBe("");
  });
});

describe("summarizeApprovalToolInput — create_issue", () => {
  it("headlines the title", () => {
    const summary = summarizeApprovalToolInput("create_issue", { title: "Add dark mode" });
    expect(summary.headline).toBe("Add dark mode");
    expect(summary.fields).toEqual([]);
  });

  it("falls back to a placeholder rather than rendering 'undefined'", () => {
    const summary = summarizeApprovalToolInput("create_issue", {});
    expect(summary.headline).toBe("(untitled)");
  });

  it("ignores an absent _brief key (today's real shape — no producer exists yet)", () => {
    const summary = summarizeApprovalToolInput("create_issue", { title: "x" });
    expect(summary.fields).toEqual([]);
  });

  it("renders a Brief field when _brief is a well-shaped object", () => {
    const summary = summarizeApprovalToolInput("create_issue", {
      title: "x",
      _brief: { title: "Composed brief title", estimateUsd: 12.5 },
    });
    expect(summary.fields).toContainEqual({
      label: "Brief",
      value: "Composed brief title — ~$12.50",
    });
  });

  it("tolerates a malformed _brief (string) without crashing", () => {
    expect(() =>
      summarizeApprovalToolInput("create_issue", { title: "x", _brief: "not an object" })
    ).not.toThrow();
    const summary = summarizeApprovalToolInput("create_issue", {
      title: "x",
      _brief: "not an object",
    });
    expect(summary.fields).toEqual([]);
  });

  it("tolerates a malformed _brief (array) without crashing", () => {
    const summary = summarizeApprovalToolInput("create_issue", { title: "x", _brief: [1, 2, 3] });
    expect(summary.fields).toEqual([]);
  });

  it("tolerates a _brief object with neither title nor estimateUsd", () => {
    const summary = summarizeApprovalToolInput("create_issue", {
      title: "x",
      _brief: { somethingElse: true },
    });
    expect(summary.fields).toEqual([]);
  });
});

describe("summarizeApprovalToolInput — create_workspace / create_repo", () => {
  it("headlines the workspace name", () => {
    const summary = summarizeApprovalToolInput("create_workspace", { name: "Acme" });
    expect(summary.headline).toBe("Acme");
  });

  it("falls back to a placeholder for a missing workspace name", () => {
    expect(summarizeApprovalToolInput("create_workspace", {}).headline).toBe("(unnamed)");
  });

  it("headlines the repo name and reports private by default", () => {
    const summary = summarizeApprovalToolInput("create_repo", { name: "widgets" });
    expect(summary.headline).toBe("widgets");
    expect(summary.fields).toContainEqual({ label: "Visibility", value: "Private" });
  });

  it("reports public only when private is the literal false", () => {
    const summary = summarizeApprovalToolInput("create_repo", { name: "widgets", private: false });
    expect(summary.fields).toContainEqual({ label: "Visibility", value: "Public" });
  });
});

describe("summarizeApprovalToolInput — alignment_brief", () => {
  it("headlines the title and surfaces task type + suggested model + estimate", () => {
    const summary = summarizeApprovalToolInput("alignment_brief", {
      title: "Add dark mode",
      taskType: "feature",
      suggestedModel: { slug: "sonnet-5", displayName: "Claude Sonnet 5" },
      estimateUsd: 4.2,
    });
    expect(summary.headline).toBe("Add dark mode");
    expect(summary.fields).toContainEqual({
      label: "Task type",
      value: "feature → Claude Sonnet 5",
    });
    expect(summary.fields).toContainEqual({ label: "Estimate", value: "~$4.20" });
  });

  it("never crashes on a malformed suggestedModel", () => {
    expect(() =>
      summarizeApprovalToolInput("alignment_brief", {
        title: "x",
        taskType: "feature",
        suggestedModel: "not an object",
        estimateUsd: 1,
      })
    ).not.toThrow();
  });
});

describe("summarizeApprovalToolInput — unknown tool fallback", () => {
  it("headlines the raw tool name and lists key:value fields", () => {
    const summary = summarizeApprovalToolInput("some_future_tool", { foo: "bar", count: 3 });
    expect(summary.headline).toBe("some_future_tool");
    expect(summary.fields).toContainEqual({ label: "foo", value: "bar" });
    expect(summary.fields).toContainEqual({ label: "count", value: "3" });
  });

  it("caps the number of rendered fields and notes how many were omitted", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`key${i}`, `value${i}`])
    );
    const summary = summarizeApprovalToolInput("wide_tool", wide);
    expect(summary.fields.length).toBe(13); // 12 fields + one "…and N more" marker
    expect(summary.fields.at(-1)?.value).toBe("…and 8 more");
  });

  it("never throws on a circular toolInput", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular["self"] = circular;
    expect(() => summarizeApprovalToolInput("weird_tool", circular)).not.toThrow();
  });
});

describe("toolLabel", () => {
  it("maps known tool names to plain English", () => {
    expect(toolLabel("create_issue")).toBe("Create issue");
    expect(toolLabel("alignment_brief")).toBe("Alignment brief");
  });

  it("falls back to the raw name for an unknown tool", () => {
    expect(toolLabel("mystery_tool")).toBe("mystery_tool");
  });
});

describe("isAlignmentParkReason", () => {
  const REASONS = [ALIGNMENT_PARK_REASON, ALIGNMENT_DENIED_PARK_REASON] as const;

  it("is true for the awaiting-alignment park reason", () => {
    expect(isAlignmentParkReason(ALIGNMENT_PARK_REASON, REASONS)).toBe(true);
  });

  it("is true for the alignment-denied park reason", () => {
    expect(isAlignmentParkReason(ALIGNMENT_DENIED_PARK_REASON, REASONS)).toBe(true);
  });

  it("is false for a guardrail park reason", () => {
    expect(isAlignmentParkReason("duplicate content: ...", REASONS)).toBe(false);
  });

  it("is false for a dependency park reason", () => {
    expect(isAlignmentParkReason("Waiting on #9", REASONS)).toBe(false);
  });

  it("is false for null (not parked, or a reasonless legacy row)", () => {
    expect(isAlignmentParkReason(null, REASONS)).toBe(false);
  });
});

describe("channelLabel", () => {
  it("maps known channels to plain English", () => {
    expect(channelLabel("telegram")).toBe("Telegram");
  });

  it("falls back to the raw channel for an unknown one", () => {
    expect(channelLabel("carrier-pigeon")).toBe("carrier-pigeon");
  });
});
