/**
 * Acceptance test — issue #869
 *
 * ROOT CAUSE: review_gates.blocking_reasons is stored as an array of
 * {title, body, file, severity} objects, but the UI typed it as string[]
 * and rendered each entry directly as a React child, causing
 * "Objects are not valid as a React child" at runtime.
 *
 * AC pinned here:
 *  1. blockingReasonLabel(string) → the original string (backward compat)
 *  2. blockingReasonLabel({title, body, file, severity}) → human-readable
 *     text that includes title and body, and file when present
 *  3. blockingReasonLabel never returns the raw JS object (no "[object Object]")
 *  4. blockingReasonSeverity(string) → null  (no badge for legacy strings)
 *  5. blockingReasonSeverity({…, severity}) → the severity string (for badge)
 *
 * The Implementer must create ./blocking-reason.ts exporting these two
 * functions. Until then every test below is RED.
 */
import { describe, it, expect } from "vitest";
import {
  blockingReasonLabel,
  blockingReasonSeverity,
  type BlockingReason,
} from "./blocking-reason";

const objectReason: BlockingReason = {
  title: "PR #756 — add browser screenshots",
  body: "Screenshot evidence is required for UI changes.",
  file: null,
  severity: "P1",
};

const objectReasonWithFile: BlockingReason = {
  title: "Missing type annotation",
  body: "Every exported function must have an explicit return type.",
  file: "src/utils.ts",
  severity: "P0",
};

describe("blockingReasonLabel", () => {
  it("returns a plain string unchanged (backward compat)", () => {
    expect(blockingReasonLabel("CI must be green")).toBe("CI must be green");
  });

  it("returns the title when given an object reason", () => {
    const label = blockingReasonLabel(objectReason);
    expect(label).toContain("PR #756 — add browser screenshots");
  });

  it("includes the body in the label for an object reason", () => {
    const label = blockingReasonLabel(objectReason);
    expect(label).toContain("Screenshot evidence is required for UI changes.");
  });

  it("includes the file path when file is non-null", () => {
    const label = blockingReasonLabel(objectReasonWithFile);
    expect(label).toContain("src/utils.ts");
  });

  it("does not include a file segment when file is null", () => {
    const label = blockingReasonLabel(objectReason);
    // null file should not leak a "null" or "file:" segment into the label
    expect(label).not.toMatch(/\bnull\b/);
  });

  it("never returns '[object Object]' for an object reason", () => {
    const label = blockingReasonLabel(objectReason);
    expect(label).not.toBe("[object Object]");
    expect(label).not.toContain("[object Object]");
  });

  it("returns a string (never an object) so React can render it safely", () => {
    expect(typeof blockingReasonLabel(objectReason)).toBe("string");
    expect(typeof blockingReasonLabel("plain string")).toBe("string");
  });
});

describe("blockingReasonSeverity", () => {
  it("returns null for a plain string reason (no badge for legacy data)", () => {
    expect(blockingReasonSeverity("CI must be green")).toBeNull();
  });

  it("returns the severity string for an object reason", () => {
    expect(blockingReasonSeverity(objectReason)).toBe("P1");
  });

  it("returns P0 for a P0-severity object reason", () => {
    expect(blockingReasonSeverity(objectReasonWithFile)).toBe("P0");
  });
});
