import { describe, expect, it } from "vitest";
import { splitCompositeSecret } from "./composite-secret";

/**
 * Task P0 (Evidence Providers Wave 2 — connect-form generalization). Pure
 * function, no I/O — the single place a joined `partA:partB` composite
 * secret is split back into its parts, consumed by `verify.ts` and
 * `connector-helpers.ts`'s `validateConnectorCredential`.
 */
describe("splitCompositeSecret — single-secret passthrough (no declared parts)", () => {
  it("returns the whole secret as one part when secretParts is absent", () => {
    expect(splitCompositeSecret({}, "lin_api_abc123")).toEqual({
      ok: true,
      parts: ["lin_api_abc123"],
    });
  });

  it("returns the whole secret as one part when secretParts is an empty array", () => {
    expect(splitCompositeSecret({ secretParts: [] }, "lin_api_abc123")).toEqual({
      ok: true,
      parts: ["lin_api_abc123"],
    });
  });

  it("does NOT split on ':' when no parts are declared — the whole string is the one part", () => {
    expect(splitCompositeSecret({}, "has:a:colon")).toEqual({
      ok: true,
      parts: ["has:a:colon"],
    });
  });
});

describe("splitCompositeSecret — composite (declared secretParts)", () => {
  const twoParts = { secretParts: [{ name: "Public key" }, { name: "Secret key" }] };

  it("splits a well-formed two-part secret", () => {
    expect(splitCompositeSecret(twoParts, "pk-lf-abc:sk-lf-def")).toEqual({
      ok: true,
      parts: ["pk-lf-abc", "sk-lf-def"],
    });
  });

  it("trims whitespace around each split part", () => {
    expect(splitCompositeSecret(twoParts, " pk-lf-abc : sk-lf-def ")).toEqual({
      ok: true,
      parts: ["pk-lf-abc", "sk-lf-def"],
    });
  });

  it("rejects too few parts, naming the expected count and part names", () => {
    const res = splitCompositeSecret(twoParts, "only-one-part");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("2 parts");
      expect(res.error).toContain("Public key");
      expect(res.error).toContain("Secret key");
      expect(res.error).toContain("got 1");
    }
  });

  it("rejects too many parts", () => {
    const res = splitCompositeSecret(twoParts, "a:b:c");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("got 3");
  });

  it("rejects a part that is empty after trimming, naming the empty part", () => {
    const res = splitCompositeSecret(twoParts, "pk-lf-abc:   ");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Secret key must not be empty.");
  });

  it("rejects the first part being empty", () => {
    const res = splitCompositeSecret(twoParts, ":sk-lf-def");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Public key must not be empty.");
  });

  it("generalizes to three declared parts", () => {
    const threeParts = {
      secretParts: [{ name: "A" }, { name: "B" }, { name: "C" }],
    };
    expect(splitCompositeSecret(threeParts, "1:2:3")).toEqual({
      ok: true,
      parts: ["1", "2", "3"],
    });
    const res = splitCompositeSecret(threeParts, "1:2");
    expect(res.ok).toBe(false);
  });
});
