import { describe, expect, it } from "vitest";
import { RUN_FAMILY_VALUES } from "../schema/runs.js";
import { isRunFamily, runFamilyLangfuseTag } from "./run-family.js";

// Issue #1223 AC4: these are PURE functions, unit-testable in complete
// isolation from any real Langfuse client, database, or network call — the
// escape hatch the issue names for verifying the tag/column mapping without
// a live-run credential.

describe("isRunFamily", () => {
  it.each(RUN_FAMILY_VALUES)("accepts the vocabulary value %s", (value) => {
    expect(isRunFamily(value)).toBe(true);
  });

  it("rejects an unrecognized string", () => {
    expect(isRunFamily("chore")).toBe(false);
  });

  it("rejects null/undefined/non-string values", () => {
    expect(isRunFamily(null)).toBe(false);
    expect(isRunFamily(undefined)).toBe(false);
    expect(isRunFamily(42)).toBe(false);
    expect(isRunFamily({})).toBe(false);
  });
});

describe("runFamilyLangfuseTag", () => {
  it("returns the exact family:<value> tag for a recognized family", () => {
    expect(runFamilyLangfuseTag("bug")).toBe("family:bug");
    expect(runFamilyLangfuseTag("feature")).toBe("family:feature");
    expect(runFamilyLangfuseTag("refactor")).toBe("family:refactor");
    expect(runFamilyLangfuseTag("test")).toBe("family:test");
    expect(runFamilyLangfuseTag("infra")).toBe("family:infra");
  });

  it("returns undefined for null (unclassified run)", () => {
    expect(runFamilyLangfuseTag(null)).toBeUndefined();
  });

  it("returns undefined for undefined (argument omitted)", () => {
    expect(runFamilyLangfuseTag(undefined)).toBeUndefined();
  });

  it("returns undefined for a malformed/typo'd value rather than emitting a bad tag", () => {
    expect(runFamilyLangfuseTag("Bug")).toBeUndefined();
    expect(runFamilyLangfuseTag("bugfix")).toBeUndefined();
    expect(runFamilyLangfuseTag("")).toBeUndefined();
  });
});
