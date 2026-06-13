import { describe, expect, it } from "vitest";
import {
  buildRunDetailHref,
  formatClusterTime,
  truncateFingerprint,
} from "./failure-clusters.helpers";

describe("failure cluster helpers", () => {
  it("builds run detail links for expanded evidence rows", () => {
    expect(buildRunDetailHref("ws-1", "run-abc")).toBe(
      "/dashboard/ws-1/runs/run-abc"
    );
  });

  it("truncates long fingerprints without changing short values", () => {
    expect(truncateFingerprint("sha256:1234567890abcdef", 14)).toBe(
      "sha256:1234567..."
    );
    expect(truncateFingerprint("short", 14)).toBe("short");
  });

  it("formats cluster timestamps for dense table cells", () => {
    expect(formatClusterTime("2026-06-13T08:01:00.000Z")).toContain("Jun 13");
    expect(formatClusterTime("")).toBe("-");
  });
});
