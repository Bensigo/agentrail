import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { verifySlackSignature, sendSlackChannelMessage } from "./slack-bot";

const SIGNING_SECRET = "shhh-its-a-secret";

function sign(timestamp: string, rawBody: string, secret = SIGNING_SECRET): string {
  const basestring = `v0:${timestamp}:${rawBody}`;
  return `v0=${createHmac("sha256", secret).update(basestring).digest("hex")}`;
}

describe("verifySlackSignature", () => {
  const NOW = 1700000000;

  it("accepts a genuinely-signed, fresh request", () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const timestamp = String(NOW);
    const signature = sign(timestamp, rawBody);

    expect(
      verifySlackSignature({ signingSecret: SIGNING_SECRET, signature, timestamp, rawBody, nowSeconds: NOW })
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const timestamp = String(NOW);
    const signature = sign(timestamp, JSON.stringify({ a: 1 }));

    expect(
      verifySlackSignature({
        signingSecret: SIGNING_SECRET,
        signature,
        timestamp,
        rawBody: JSON.stringify({ a: 2 }),
        nowSeconds: NOW,
      })
    ).toBe(false);
  });

  it("rejects a signature computed with the WRONG signing secret", () => {
    const rawBody = "{}";
    const timestamp = String(NOW);
    const signature = sign(timestamp, rawBody, "wrong-secret");

    expect(
      verifySlackSignature({ signingSecret: SIGNING_SECRET, signature, timestamp, rawBody, nowSeconds: NOW })
    ).toBe(false);
  });

  it("rejects a stale timestamp (replay-attack protection, >5 minutes old)", () => {
    const rawBody = "{}";
    const staleTimestamp = String(NOW - 60 * 10);
    const signature = sign(staleTimestamp, rawBody);

    expect(
      verifySlackSignature({ signingSecret: SIGNING_SECRET, signature, timestamp: staleTimestamp, rawBody, nowSeconds: NOW })
    ).toBe(false);
  });

  it("accepts a timestamp within the 5-minute skew window", () => {
    const rawBody = "{}";
    const timestamp = String(NOW - 60 * 4);
    const signature = sign(timestamp, rawBody);

    expect(
      verifySlackSignature({ signingSecret: SIGNING_SECRET, signature, timestamp, rawBody, nowSeconds: NOW })
    ).toBe(true);
  });

  it("rejects when the signing secret, signature, or timestamp is missing", () => {
    const rawBody = "{}";
    const timestamp = String(NOW);
    const signature = sign(timestamp, rawBody);

    expect(verifySlackSignature({ signingSecret: undefined, signature, timestamp, rawBody, nowSeconds: NOW })).toBe(false);
    expect(verifySlackSignature({ signingSecret: SIGNING_SECRET, signature: null, timestamp, rawBody, nowSeconds: NOW })).toBe(false);
    expect(verifySlackSignature({ signingSecret: SIGNING_SECRET, signature, timestamp: null, rawBody, nowSeconds: NOW })).toBe(false);
  });

  it("rejects a non-numeric timestamp without throwing", () => {
    const rawBody = "{}";
    expect(
      verifySlackSignature({
        signingSecret: SIGNING_SECRET,
        signature: "v0=deadbeef",
        timestamp: "not-a-number",
        rawBody,
        nowSeconds: NOW,
      })
    ).toBe(false);
  });

  it("rejects a signature of a different length without throwing (timingSafeEqual guard)", () => {
    const rawBody = "{}";
    const timestamp = String(NOW);
    expect(
      verifySlackSignature({ signingSecret: SIGNING_SECRET, signature: "v0=short", timestamp, rawBody, nowSeconds: NOW })
    ).toBe(false);
  });
});

describe("sendSlackChannelMessage", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to chat.postMessage with the Bearer Authorization header", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });

    const result = await sendSlackChannelMessage("xoxb-123", "D0PNCRP9N", "hello");

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer xoxb-123" }),
        body: JSON.stringify({ channel: "D0PNCRP9N", text: "hello" }),
      })
    );
  });

  it("surfaces a typed failure when Slack's Web API returns ok:false (HTTP 200, error in body)", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: false, error: "channel_not_found" }) });

    const result = await sendSlackChannelMessage("xoxb-123", "bad-channel", "hello");

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("channel_not_found");
  });

  it("surfaces a typed failure on a non-ok HTTP response", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    const result = await sendSlackChannelMessage("xoxb-123", "D1", "hello");

    expect(result.ok).toBe(false);
  });

  it("surfaces a typed failure when the network call rejects", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await sendSlackChannelMessage("xoxb-123", "D1", "hello");

    expect(result.ok).toBe(false);
  });
});
