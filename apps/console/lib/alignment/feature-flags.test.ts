import { describe, it, expect } from "vitest";
import { isModelSelectionLearningEnabled } from "./feature-flags";

describe("isModelSelectionLearningEnabled: off by default (the safety seam)", () => {
  it("neither env var set -> disabled for a normal workspace", () => {
    expect(isModelSelectionLearningEnabled("ws-1", {})).toBe(false);
  });

  it("neither env var set -> disabled even with no workspaceId at all", () => {
    expect(isModelSelectionLearningEnabled(undefined, {})).toBe(false);
    expect(isModelSelectionLearningEnabled(null, {})).toBe(false);
  });

  it("an empty-string env value is treated as unset (disabled)", () => {
    expect(
      isModelSelectionLearningEnabled("ws-1", {
        MODEL_SELECTION_LEARNING_ENABLED: "",
        MODEL_SELECTION_LEARNING_WORKSPACES: "",
      })
    ).toBe(false);
  });
});

describe("isModelSelectionLearningEnabled: global switch", () => {
  it("MODEL_SELECTION_LEARNING_ENABLED=true enables every workspace", () => {
    expect(
      isModelSelectionLearningEnabled("ws-1", { MODEL_SELECTION_LEARNING_ENABLED: "true" })
    ).toBe(true);
    expect(
      isModelSelectionLearningEnabled("ws-anything-else", {
        MODEL_SELECTION_LEARNING_ENABLED: "true",
      })
    ).toBe(true);
  });

  it("MODEL_SELECTION_LEARNING_ENABLED=1 also enables (numeric truthy form)", () => {
    expect(isModelSelectionLearningEnabled("ws-1", { MODEL_SELECTION_LEARNING_ENABLED: "1" })).toBe(
      true
    );
  });

  it("is case-insensitive for the 'true' form", () => {
    expect(
      isModelSelectionLearningEnabled("ws-1", { MODEL_SELECTION_LEARNING_ENABLED: "TRUE" })
    ).toBe(true);
  });

  it("any other value (e.g. 'false', 'yes', '0') does not enable the global switch", () => {
    for (const value of ["false", "yes", "0", "off"]) {
      expect(isModelSelectionLearningEnabled("ws-1", { MODEL_SELECTION_LEARNING_ENABLED: value })).toBe(
        false
      );
    }
  });

  it("the global switch enables even a null/undefined workspaceId (no workspace to scope stats to, but the flag check itself doesn't require one)", () => {
    expect(
      isModelSelectionLearningEnabled(undefined, { MODEL_SELECTION_LEARNING_ENABLED: "true" })
    ).toBe(true);
  });
});

describe("isModelSelectionLearningEnabled: per-workspace allowlist (additive to the global switch)", () => {
  it("enables only the listed workspace(s) when the global switch is off", () => {
    const env = { MODEL_SELECTION_LEARNING_WORKSPACES: "ws-1,ws-2" };
    expect(isModelSelectionLearningEnabled("ws-1", env)).toBe(true);
    expect(isModelSelectionLearningEnabled("ws-2", env)).toBe(true);
    expect(isModelSelectionLearningEnabled("ws-3", env)).toBe(false);
  });

  it("tolerates whitespace around comma-separated ids", () => {
    const env = { MODEL_SELECTION_LEARNING_WORKSPACES: " ws-1 , ws-2 ,ws-3" };
    expect(isModelSelectionLearningEnabled("ws-2", env)).toBe(true);
    expect(isModelSelectionLearningEnabled("ws-3", env)).toBe(true);
  });

  it("a workspace not in the list stays disabled, even with an otherwise-non-empty allowlist", () => {
    expect(
      isModelSelectionLearningEnabled("ws-unlisted", { MODEL_SELECTION_LEARNING_WORKSPACES: "ws-1" })
    ).toBe(false);
  });

  it("with no workspaceId, the allowlist alone never enables it (nothing to match against)", () => {
    expect(
      isModelSelectionLearningEnabled(undefined, { MODEL_SELECTION_LEARNING_WORKSPACES: "ws-1" })
    ).toBe(false);
  });

  it("the global switch wins even if the allowlist doesn't include the workspace", () => {
    expect(
      isModelSelectionLearningEnabled("ws-not-listed", {
        MODEL_SELECTION_LEARNING_ENABLED: "true",
        MODEL_SELECTION_LEARNING_WORKSPACES: "ws-other",
      })
    ).toBe(true);
  });
});

describe("isModelSelectionLearningEnabled: defaults to reading the real process.env when no env override is given", () => {
  it("does not throw when called with only a workspaceId (exercises the process.env default param)", () => {
    expect(() => isModelSelectionLearningEnabled("ws-1")).not.toThrow();
  });
});
