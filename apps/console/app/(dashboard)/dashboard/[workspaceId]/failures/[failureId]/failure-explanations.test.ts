import { describe, expect, it } from "vitest";
import {
  explainFailure,
  humanizeType,
  normalizeSeverity,
  severityMeaning,
} from "./failure-explanations";

describe("explainFailure", () => {
  it("returns a curated explanation for known failure types", () => {
    const e = explainFailure({ failure_type: "test_error", message: "x" });
    expect(e.title).toBe("Tests failed");
    expect(e.category).toBe("Verification");
    expect(e.why.length).toBeGreaterThan(0);
    expect(e.whatToCheck.length).toBeGreaterThan(0);
  });

  it("covers every failure type the UI filter and runner can emit", () => {
    for (const t of [
      "tool_error",
      "context_error",
      "auth_error",
      "lint_error",
      "test_error",
      "build_error",
      "afk_failure",
    ]) {
      const e = explainFailure({ failure_type: t, message: "boom" });
      expect(e.summary.length).toBeGreaterThan(10);
    }
  });

  it("falls back gracefully for unknown types, leaning on the message and phase", () => {
    const e = explainFailure({
      failure_type: "quantum_error",
      message: "reactor offline",
      phase: "deploy",
    });
    expect(e.title).toBe("Quantum error");
    expect(e.category).toBe("Deploy");
    expect(e.summary).toContain("deploy");
  });
});

describe("humanizeType", () => {
  it("turns snake_case into a readable title", () => {
    expect(humanizeType("tool_error")).toBe("Tool error");
    expect(humanizeType("afk_failure")).toBe("Afk failure");
  });
  it("never returns empty", () => {
    expect(humanizeType("")).toBe("Failure");
  });
});

describe("severity normalization", () => {
  it("maps the runner's literal 'error' to high", () => {
    expect(normalizeSeverity("error")).toBe("high");
  });
  it("maps review spellings onto buckets", () => {
    expect(normalizeSeverity("critical")).toBe("critical");
    expect(normalizeSeverity("warning")).toBe("medium");
    expect(normalizeSeverity("info")).toBe("low");
  });
  it("defaults unknown severities to high rather than under-stating", () => {
    expect(normalizeSeverity("kaboom")).toBe("high");
    expect(normalizeSeverity("")).toBe("high");
  });
  it("attaches an impact statement", () => {
    expect(severityMeaning("critical").impact.length).toBeGreaterThan(10);
    expect(severityMeaning("error").level).toBe("high");
  });
});
