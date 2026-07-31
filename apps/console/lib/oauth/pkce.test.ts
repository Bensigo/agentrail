import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import { computeCodeChallengeS256, generateCodeVerifier } from "./pkce";

describe("generateCodeVerifier", () => {
  it("produces a 43-character string (32 random bytes, base64url, unpadded)", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(43);
  });

  it("uses only RFC 7636's unreserved URL-safe charset (base64url's own alphabet is a strict subset)", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("never contains base64 padding", () => {
    expect(generateCodeVerifier()).not.toContain("=");
  });

  it("mints a fresh, distinct verifier on every call", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });
});

describe("computeCodeChallengeS256", () => {
  it("computes base64url(sha256(verifier)) — matches a from-scratch reference computation", () => {
    const verifier = "test-verifier-value";
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(computeCodeChallengeS256(verifier)).toBe(expected);
  });

  it("is deterministic — the SAME verifier always produces the SAME challenge", () => {
    const verifier = generateCodeVerifier();
    expect(computeCodeChallengeS256(verifier)).toBe(computeCodeChallengeS256(verifier));
  });

  it("two different verifiers produce two different challenges", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(computeCodeChallengeS256(a)).not.toBe(computeCodeChallengeS256(b));
  });

  it("matches RFC 7636's own well-known S256 worked example verifier/challenge pair (independently recomputed with Node's own crypto module before being hardcoded here, not trusted from memory alone)", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(computeCodeChallengeS256(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
