import { describe, it, expect } from "vitest";
import { buildCitationUrl } from "./citation-url";

describe("buildCitationUrl", () => {
  it("builds a pinned blob URL from an https repo URL", () => {
    expect(
      buildCitationUrl(
        "https://github.com/bensigo/agentrail",
        "129103aa",
        "agentrail/context/index.py"
      )
    ).toBe(
      "https://github.com/bensigo/agentrail/blob/129103aa/agentrail/context/index.py"
    );
  });

  it("strips a trailing slash on the repo URL", () => {
    expect(
      buildCitationUrl("https://github.com/bensigo/agentrail/", "abc123", "README.md")
    ).toBe("https://github.com/bensigo/agentrail/blob/abc123/README.md");
  });

  it("strips a .git suffix", () => {
    expect(
      buildCitationUrl("https://github.com/bensigo/agentrail.git", "abc123", "README.md")
    ).toBe("https://github.com/bensigo/agentrail/blob/abc123/README.md");
  });

  it("handles an SSH-style repo URL", () => {
    expect(
      buildCitationUrl("git@github.com:bensigo/agentrail.git", "abc123", "README.md")
    ).toBe("https://github.com/bensigo/agentrail/blob/abc123/README.md");
  });

  it("strips a leading slash on the citation path", () => {
    expect(
      buildCitationUrl("https://github.com/bensigo/agentrail", "abc123", "/README.md")
    ).toBe("https://github.com/bensigo/agentrail/blob/abc123/README.md");
  });

  it("returns null for a non-github repo URL", () => {
    expect(
      buildCitationUrl("https://gitlab.com/bensigo/agentrail", "abc123", "README.md")
    ).toBeNull();
  });

  it("returns null when any input is empty", () => {
    expect(buildCitationUrl("", "abc123", "README.md")).toBeNull();
    expect(buildCitationUrl("https://github.com/bensigo/agentrail", "", "README.md")).toBeNull();
    expect(buildCitationUrl("https://github.com/bensigo/agentrail", "abc123", "")).toBeNull();
  });
});
