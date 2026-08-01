import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { parseSentryWebhookPayload, verifySentryWebhookSignature } from "./sentry-webhook-helpers";

const SECRET = "w3t5-helpers-test-client-secret";

function sign(raw: string, secret: string): string {
  return createHmac("sha256", secret).update(raw, "utf8").digest("hex");
}

describe("verifySentryWebhookSignature", () => {
  it("accepts a correctly-computed HMAC-SHA256 hex signature", () => {
    const raw = JSON.stringify({ a: 1 });
    expect(verifySentryWebhookSignature(raw, sign(raw, SECRET), SECRET)).toBe(true);
  });

  it("rejects a null header (missing)", () => {
    expect(verifySentryWebhookSignature("body", null, SECRET)).toBe(false);
  });

  it("rejects an empty-string header", () => {
    expect(verifySentryWebhookSignature("body", "", SECRET)).toBe(false);
  });

  it("rejects a same-length, wrong-content header, never throwing", () => {
    const raw = "body";
    const real = sign(raw, SECRET);
    const wrong = "f".repeat(real.length);
    expect(wrong).not.toBe(real);
    expect(() => verifySentryWebhookSignature(raw, wrong, SECRET)).not.toThrow();
    expect(verifySentryWebhookSignature(raw, wrong, SECRET)).toBe(false);
  });

  it("rejects a too-short header without throwing (would otherwise be a timingSafeEqual RangeError)", () => {
    expect(() => verifySentryWebhookSignature("body", "abc", SECRET)).not.toThrow();
    expect(verifySentryWebhookSignature("body", "abc", SECRET)).toBe(false);
  });

  it("rejects a too-long header without throwing", () => {
    const raw = "body";
    const tooLong = sign(raw, SECRET) + "00";
    expect(() => verifySentryWebhookSignature(raw, tooLong, SECRET)).not.toThrow();
    expect(verifySentryWebhookSignature(raw, tooLong, SECRET)).toBe(false);
  });

  it("rejects a non-hex-looking header of the RIGHT length, never throwing (this receiver compares text, never hex-decodes)", () => {
    const raw = "body";
    const real = sign(raw, SECRET);
    const nonHex = "z".repeat(real.length);
    expect(() => verifySentryWebhookSignature(raw, nonHex, SECRET)).not.toThrow();
    expect(verifySentryWebhookSignature(raw, nonHex, SECRET)).toBe(false);
  });

  it("rejects a signature computed under a DIFFERENT secret", () => {
    const raw = "body";
    expect(verifySentryWebhookSignature(raw, sign(raw, "some-other-secret"), SECRET)).toBe(false);
  });

  it("is sensitive to every byte of the raw body, including multi-byte unicode", () => {
    const raw = JSON.stringify({ note: "café ☃ ünïcödé тест" });
    const signature = sign(raw, SECRET);
    expect(verifySentryWebhookSignature(raw, signature, SECRET)).toBe(true);
    // One character different (still valid JSON, still similar byte length)
    // -- must NOT validate against the ORIGINAL signature.
    const tampered = raw.replace("café", "cafe");
    expect(verifySentryWebhookSignature(tampered, signature, SECRET)).toBe(false);
  });
});

describe("parseSentryWebhookPayload", () => {
  it("parses action + the top-level installation.uuid", () => {
    const raw = JSON.stringify({ action: "deleted", installation: { uuid: "install-1" } });
    expect(parseSentryWebhookPayload(raw)).toEqual({ action: "deleted", installationId: "install-1" });
  });

  it("returns null for unparseable JSON", () => {
    expect(parseSentryWebhookPayload("{not json")).toBeNull();
  });

  it("returns null for JSON that parses but isn't an object (bare array, string, or null)", () => {
    expect(parseSentryWebhookPayload("[]")).toBeNull();
    expect(parseSentryWebhookPayload('"just a string"')).toBeNull();
    expect(parseSentryWebhookPayload("null")).toBeNull();
  });

  it("degrades action to null when absent or not a string, without throwing", () => {
    expect(parseSentryWebhookPayload("{}")).toEqual({ action: null, installationId: null });
    expect(parseSentryWebhookPayload(JSON.stringify({ action: 42 }))).toEqual({
      action: null,
      installationId: null,
    });
  });

  it("degrades installationId to null when installation is missing, not an object, or uuid isn't a string", () => {
    expect(parseSentryWebhookPayload(JSON.stringify({ action: "deleted" }))).toEqual({
      action: "deleted",
      installationId: null,
    });
    expect(
      parseSentryWebhookPayload(JSON.stringify({ action: "deleted", installation: "not-an-object" }))
    ).toEqual({ action: "deleted", installationId: null });
    expect(
      parseSentryWebhookPayload(JSON.stringify({ action: "deleted", installation: { uuid: 12345 } }))
    ).toEqual({ action: "deleted", installationId: null });
  });

  it("also reads the richer data.installation object's payload without needing it (top-level installation.uuid alone is sufficient)", () => {
    const raw = JSON.stringify({
      action: "deleted",
      data: { installation: { status: "pending", uuid: "install-nested-1" } },
      installation: { uuid: "install-nested-1" },
    });
    expect(parseSentryWebhookPayload(raw)).toEqual({ action: "deleted", installationId: "install-nested-1" });
  });
});
