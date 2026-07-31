import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendSystemDiscordMessagePreferFollowup } from "./discord-system-message";

const ORIGINAL_TOKEN = process.env["DISCORD_BOT_TOKEN"];

describe("sendSystemDiscordMessagePreferFollowup", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    // The bot-path fallback (sendSystemDiscordMessage) needs a token to even
    // attempt its send — set one so fallback tests actually exercise the
    // fetch call this suite asserts against, rather than short-circuiting on
    // "DISCORD_BOT_TOKEN is not configured."
    process.env["DISCORD_BOT_TOKEN"] = "bot-tok-abc";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL_TOKEN === undefined) {
      delete process.env["DISCORD_BOT_TOKEN"];
    } else {
      process.env["DISCORD_BOT_TOKEN"] = ORIGINAL_TOKEN;
    }
  });

  it("posts to the interaction-followup webhook with no Authorization header when both credentials are present, and never calls the bot path on 2xx", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 204 });

    const result = await sendSystemDiscordMessagePreferFollowup({
      channelId: "chan-1",
      text: "upgrade now",
      interactionToken: "tok-xyz",
      applicationId: "app-123",
    });

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/v10/webhooks/app-123/tok-xyz");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ content: "upgrade now" }));
    // Exact equality (not objectContaining): proves no Authorization header
    // is sent at all — the interaction token IS the credential.
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("falls back to the bot path — called with (channelId, text) — on a non-2xx followup response", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404 }) // followup: expired/invalid token
      .mockResolvedValueOnce({ ok: true, status: 200 }); // bot path succeeds

    const result = await sendSystemDiscordMessagePreferFollowup({
      channelId: "chan-1",
      text: "upgrade now",
      interactionToken: "tok-xyz",
      applicationId: "app-123",
    });

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [botUrl, botInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(botUrl).toBe("https://discord.com/api/v10/channels/chan-1/messages");
    expect(botInit.headers).toEqual(
      expect.objectContaining({ Authorization: "Bot bot-tok-abc" })
    );
    expect(botInit.body).toBe(JSON.stringify({ content: "upgrade now" }));
  });

  it("goes straight to the bot path when applicationId is missing (one credential only)", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await sendSystemDiscordMessagePreferFollowup({
      channelId: "chan-1",
      text: "upgrade now",
      interactionToken: "tok-xyz",
    });

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://discord.com/api/v10/channels/chan-1/messages"
    );
  });

  it("goes straight to the bot path when interactionToken is missing (one credential only)", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await sendSystemDiscordMessagePreferFollowup({
      channelId: "chan-1",
      text: "upgrade now",
      applicationId: "app-123",
    });

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://discord.com/api/v10/channels/chan-1/messages"
    );
  });

  it("goes straight to the bot path when both credentials are absent", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await sendSystemDiscordMessagePreferFollowup({
      channelId: "chan-1",
      text: "upgrade now",
    });

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://discord.com/api/v10/channels/chan-1/messages"
    );
  });

  it("treats a whitespace-only credential as blank — straight to the bot path", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await sendSystemDiscordMessagePreferFollowup({
      channelId: "chan-1",
      text: "upgrade now",
      interactionToken: "   ",
      applicationId: "app-123",
    });

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://discord.com/api/v10/channels/chan-1/messages"
    );
  });

  it("falls back to the bot path — no throw — when the followup fetch itself throws", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await sendSystemDiscordMessagePreferFollowup({
      channelId: "chan-1",
      text: "upgrade now",
      interactionToken: "tok-xyz",
      applicationId: "app-123",
    });

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe(
      "https://discord.com/api/v10/channels/chan-1/messages"
    );
  });

  it("propagates a bot-path typed failure unchanged when both the followup and the bot post fail", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404 }) // followup
      .mockResolvedValueOnce({ ok: false, status: 403 }); // bot path — e.g. 50001 in a private channel

    const result = await sendSystemDiscordMessagePreferFollowup({
      channelId: "chan-1",
      text: "upgrade now",
      interactionToken: "tok-xyz",
      applicationId: "app-123",
    });

    expect(result.ok).toBe(false);
  });
});
