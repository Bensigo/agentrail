import { describe, expect, it } from "vitest";
import { deriveThreadName } from "./discord-thread-name";

describe("deriveThreadName", () => {
  it("uses the message text", () => {
    expect(deriveThreadName("how do I deploy this?")).toBe("how do I deploy this?");
  });

  it("collapses whitespace and newlines", () => {
    expect(deriveThreadName("what  is\n\nbroken")).toBe("what is broken");
  });

  it("cuts to 100 chars on a word boundary", () => {
    const name = deriveThreadName("word ".repeat(50).trim());
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.endsWith("word")).toBe(true);
  });

  it("hard-cuts a single unbroken token longer than the limit", () => {
    const name = deriveThreadName("x".repeat(200));
    expect(name).toHaveLength(100);
  });

  it("falls back to 'Jace' on empty or whitespace-only input", () => {
    expect(deriveThreadName("   ")).toBe("Jace");
    expect(deriveThreadName("")).toBe("Jace");
  });
});
