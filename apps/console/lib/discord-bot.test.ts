import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "crypto";
import {
  verifyDiscordSignature,
  sendDiscordChannelMessage,
  DISCORD_INTERACTION_RESPONSE,
  DISCORD_INTERACTION_TYPE,
} from "./discord-bot";

/** A real Ed25519 keypair, generated once — mirrors how a real Discord
 * application's public key + Discord's own signing key relate. */
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_HEX = publicKey
  .export({ type: "spki", format: "der" })
  .subarray(-32)
  .toString("hex");

function sign(timestamp: string, rawBody: string): string {
  return cryptoSign(null, Buffer.from(timestamp + rawBody), privateKey).toString("hex");
}

describe("verifyDiscordSignature", () => {
  it("accepts a genuinely-signed request", () => {
    const timestamp = "1700000000";
    const rawBody = JSON.stringify({ type: 1 });
    const signatureHex = sign(timestamp, rawBody);

    expect(
      verifyDiscordSignature({ publicKeyHex: PUBLIC_KEY_HEX, signatureHex, timestamp, rawBody })
    ).toBe(true);
  });

  it("rejects a tampered body (signature was computed over a different body)", () => {
    const timestamp = "1700000000";
    const signatureHex = sign(timestamp, JSON.stringify({ type: 1 }));

    expect(
      verifyDiscordSignature({
        publicKeyHex: PUBLIC_KEY_HEX,
        signatureHex,
        timestamp,
        rawBody: JSON.stringify({ type: 2 }),
      })
    ).toBe(false);
  });

  it("rejects a tampered timestamp", () => {
    const rawBody = JSON.stringify({ type: 1 });
    const signatureHex = sign("1700000000", rawBody);

    expect(
      verifyDiscordSignature({
        publicKeyHex: PUBLIC_KEY_HEX,
        signatureHex,
        timestamp: "1700000001",
        rawBody,
      })
    ).toBe(false);
  });

  it("rejects a signature from a DIFFERENT key entirely", () => {
    const other = generateKeyPairSync("ed25519");
    const timestamp = "1700000000";
    const rawBody = JSON.stringify({ type: 1 });
    const signatureHex = cryptoSign(null, Buffer.from(timestamp + rawBody), other.privateKey).toString("hex");

    expect(
      verifyDiscordSignature({ publicKeyHex: PUBLIC_KEY_HEX, signatureHex, timestamp, rawBody })
    ).toBe(false);
  });

  it("rejects a malformed (non-hex, wrong-length) public key without throwing", () => {
    expect(
      verifyDiscordSignature({
        publicKeyHex: "not-hex-and-too-short",
        signatureHex: "aa".repeat(64),
        timestamp: "1700000000",
        rawBody: "{}",
      })
    ).toBe(false);
  });

  it("rejects a malformed (wrong-length) signature without throwing", () => {
    expect(
      verifyDiscordSignature({
        publicKeyHex: PUBLIC_KEY_HEX,
        signatureHex: "aa",
        timestamp: "1700000000",
        rawBody: "{}",
      })
    ).toBe(false);
  });

  it("rejects when the public key, signature, or timestamp is missing/blank", () => {
    const rawBody = "{}";
    expect(verifyDiscordSignature({ publicKeyHex: "", signatureHex: "aa".repeat(64), timestamp: "1", rawBody })).toBe(false);
    expect(verifyDiscordSignature({ publicKeyHex: PUBLIC_KEY_HEX, signatureHex: "", timestamp: "1", rawBody })).toBe(false);
    expect(verifyDiscordSignature({ publicKeyHex: PUBLIC_KEY_HEX, signatureHex: "aa".repeat(64), timestamp: "", rawBody })).toBe(false);
  });
});

describe("sendDiscordChannelMessage", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the channel messages endpoint with the Bot Authorization header", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    const result = await sendDiscordChannelMessage("tok-123", "chan-1", "hello");

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/chan-1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bot tok-123" }),
        body: JSON.stringify({ content: "hello" }),
      })
    );
  });

  it("surfaces a typed failure (never throws) on a non-ok response", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });

    const result = await sendDiscordChannelMessage("tok-123", "chan-1", "hello");

    expect(result.ok).toBe(false);
  });

  it("surfaces a typed failure when the network call rejects", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await sendDiscordChannelMessage("tok-123", "chan-1", "hello");

    expect(result.ok).toBe(false);
  });
});

describe("DISCORD_INTERACTION_RESPONSE / DISCORD_INTERACTION_TYPE", () => {
  it("matches Discord's documented numeric values", () => {
    expect(DISCORD_INTERACTION_RESPONSE.PONG).toBe(1);
    expect(DISCORD_INTERACTION_RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE).toBe(4);
    expect(DISCORD_INTERACTION_TYPE.PING).toBe(1);
    expect(DISCORD_INTERACTION_TYPE.APPLICATION_COMMAND).toBe(2);
    expect(DISCORD_INTERACTION_TYPE.MESSAGE_COMPONENT).toBe(3);
  });
});
