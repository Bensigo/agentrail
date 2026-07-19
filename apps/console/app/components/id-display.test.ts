import { describe, it, expect } from "vitest";
import { shortId, nameOrShortId } from "./id-display";

describe("shortId", () => {
  it("truncates a raw UUID to 8 leading chars + an ellipsis", () => {
    expect(shortId("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d")).toBe("a1b2c3d4…");
  });

  it("never returns the full 36-char UUID as-is", () => {
    const id = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
    expect(shortId(id)).not.toBe(id);
    expect(shortId(id).length).toBeLessThan(id.length);
  });

  it("respects a custom visibleChars length", () => {
    expect(shortId("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", 12)).toBe(
      "a1b2c3d4-e5f…"
    );
  });

  it("passes short ids through unchanged (no spurious ellipsis)", () => {
    expect(shortId("short")).toBe("short");
    expect(shortId("exactly8", 8)).toBe("exactly8");
  });
});

describe("nameOrShortId", () => {
  const id = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

  it("prefers a resolved name, with no title (no tooltip needed)", () => {
    expect(nameOrShortId("agentrail-console", id)).toEqual({
      text: "agentrail-console",
    });
  });

  it("falls back to a short hash + full id in title when name is null", () => {
    expect(nameOrShortId(null, id)).toEqual({
      text: "a1b2c3d4…",
      title: id,
    });
  });

  it("falls back to a short hash + full id in title when name is undefined", () => {
    expect(nameOrShortId(undefined, id)).toEqual({
      text: "a1b2c3d4…",
      title: id,
    });
  });

  it("falls back to a short hash + full id in title when name is empty string", () => {
    expect(nameOrShortId("", id)).toEqual({
      text: "a1b2c3d4…",
      title: id,
    });
  });

  it("the fallback text is never the full raw id", () => {
    const result = nameOrShortId(null, id);
    expect(result.text).not.toBe(id);
  });
});
