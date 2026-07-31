import { describe, expect, it } from "vitest";
import { parseSecretEnvelope, serializeOauthEnvelope } from "./secret-envelope";

/**
 * OAuth Connect Wave 3, W3-T1 (`.superpowers/sdd/plan-oauth.md`). Pure-function
 * coverage only — see `secret-envelope.ts`'s own doc-comment for why this is a
 * sibling of `crypto.ts` rather than folded into it. No DB, no
 * `CONNECTOR_SECRET_KEY` needed: these functions operate on already-decrypted
 * plaintext (the layer above `decryptSecret`/before `encryptSecret`).
 */

describe("serializeOauthEnvelope", () => {
  it("wraps the credential in the pinned {oauth:1,...} shape", () => {
    const json = serializeOauthEnvelope({
      access: "acc_123",
      refresh: "ref_456",
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
    expect(JSON.parse(json)).toEqual({
      oauth: 1,
      access: "acc_123",
      refresh: "ref_456",
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
  });
});

describe("parseSecretEnvelope", () => {
  it("round-trips a serialized oauth envelope", () => {
    const serialized = serializeOauthEnvelope({
      access: "acc_123",
      refresh: "ref_456",
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
    expect(parseSecretEnvelope(serialized)).toEqual({
      kind: "oauth",
      credential: {
        access: "acc_123",
        refresh: "ref_456",
        expiresAt: "2026-08-01T00:00:00.000Z",
      },
    });
  });

  it("treats a plain legacy token as kind:'token'", () => {
    expect(parseSecretEnvelope("lin_api_abcdef0123456789")).toEqual({
      kind: "token",
      value: "lin_api_abcdef0123456789",
    });
  });

  it("treats a legacy composite secret (contains ':') as kind:'token'", () => {
    expect(parseSecretEnvelope("pk-lf-abc:sk-lf-def")).toEqual({
      kind: "token",
      value: "pk-lf-abc:sk-lf-def",
    });
  });

  it("treats arbitrary JSON lacking the oauth:1 discriminator as kind:'token' (never guesses)", () => {
    const value = '{"foo":"bar"}';
    expect(parseSecretEnvelope(value)).toEqual({ kind: "token", value });
  });

  it("treats an oauth-shaped object with oauth !== 1 as kind:'token'", () => {
    const value = JSON.stringify({
      oauth: 2,
      access: "a",
      refresh: "r",
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
    expect(parseSecretEnvelope(value)).toEqual({ kind: "token", value });
  });

  it("treats an oauth-shaped object missing a required field as kind:'token'", () => {
    const value = JSON.stringify({ oauth: 1, access: "a", expiresAt: "2026-08-01T00:00:00.000Z" });
    expect(parseSecretEnvelope(value)).toEqual({ kind: "token", value });
  });

  it("treats an oauth-shaped object with a non-string field as kind:'token'", () => {
    const value = JSON.stringify({ oauth: 1, access: "a", refresh: 5, expiresAt: "2026-08-01T00:00:00.000Z" });
    expect(parseSecretEnvelope(value)).toEqual({ kind: "token", value });
  });

  it("never throws on malformed JSON that merely starts with a brace", () => {
    const value = "{not json";
    expect(() => parseSecretEnvelope(value)).not.toThrow();
    expect(parseSecretEnvelope(value)).toEqual({ kind: "token", value });
  });

  it("treats an empty string as kind:'token'", () => {
    expect(parseSecretEnvelope("")).toEqual({ kind: "token", value: "" });
  });
});
