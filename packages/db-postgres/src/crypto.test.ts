import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, isEncrypted } from "./crypto";

describe("connector secret encryption", () => {
  beforeAll(() => {
    // Deterministic key material for the test (no real AUTH_SECRET needed).
    process.env["CONNECTOR_SECRET_KEY"] = "test-connector-secret-key-0123456789";
  });

  it("round-trips a credential through encrypt → decrypt", () => {
    const plaintext = "lin_api_abcdef0123456789";
    const enc = encryptSecret(plaintext);
    expect(enc).not.toContain(plaintext); // ciphertext must not leak plaintext
    expect(isEncrypted(enc)).toBe(true);
    expect(decryptSecret(enc)).toBe(plaintext);
  });

  it("produces a fresh IV each time (ciphertexts differ)", () => {
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-value");
    expect(decryptSecret(b)).toBe("same-value");
  });

  it("uses the versioned enc:v1 scheme", () => {
    expect(encryptSecret("x").startsWith("enc:v1:")).toBe(true);
  });

  it("passes a non-encrypted value through unchanged (defensive)", () => {
    expect(isEncrypted("plain")).toBe(false);
    expect(decryptSecret("plain")).toBe("plain");
  });

  it("fails authentication on a tampered ciphertext", () => {
    const enc = encryptSecret("secret");
    const parts = enc.split(":");
    // Flip the last char of the ciphertext segment.
    const ct = parts[4];
    parts[4] = ct.slice(0, -1) + (ct.endsWith("A") ? "B" : "A");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });
});
