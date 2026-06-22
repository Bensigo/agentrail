import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveTelegramChatId,
  sendTelegramWelcome,
  sendTelegramMessage,
  setTelegramWebhook,
  getTelegramUpdates,
  deleteTelegramWebhook,
} from "./telegram";

const TOKEN = "123456789:AAH" + "a".repeat(32);

function mockFetchOnce(body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    json: async () => body,
  } as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveTelegramChatId (direct-chat discovery)", () => {
  it("returns the most recent chat id from getUpdates", async () => {
    mockFetchOnce({
      ok: true,
      result: [
        { message: { chat: { id: 111 } } },
        { message: { chat: { id: 222 } } },
      ],
    });
    const res = await resolveTelegramChatId(TOKEN);
    expect(res).toEqual({ ok: true, chatId: "222" });
  });

  it("falls back to my_chat_member chat id", async () => {
    mockFetchOnce({
      ok: true,
      result: [{ my_chat_member: { chat: { id: 555 } } }],
    });
    const res = await resolveTelegramChatId(TOKEN);
    expect(res).toEqual({ ok: true, chatId: "555" });
  });

  it("errors with a helpful message when the bot has no updates", async () => {
    mockFetchOnce({ ok: true, result: [] });
    const res = await resolveTelegramChatId(TOKEN);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/send it a message/i);
  });

  it("errors when Telegram rejects the token", async () => {
    mockFetchOnce({ ok: false });
    const res = await resolveTelegramChatId(TOKEN);
    expect(res.ok).toBe(false);
  });
});

describe("sendTelegramWelcome", () => {
  it("posts a welcome message and succeeds when Telegram accepts it", async () => {
    const fn = mockFetchOnce({ ok: true });
    const res = await sendTelegramWelcome(TOKEN, "-100123");
    expect(res).toEqual({ ok: true });
    // The send targets the supplied chat id.
    const [, init] = fn.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      chat_id: "-100123",
    });
  });

  it("errors when the bot can't message the chat", async () => {
    mockFetchOnce({ ok: false });
    const res = await sendTelegramWelcome(TOKEN, "-100123");
    expect(res.ok).toBe(false);
  });
});

describe("sendTelegramMessage (shared sender)", () => {
  it("posts the supplied text to the supplied chat and succeeds", async () => {
    const fn = mockFetchOnce({ ok: true });
    const res = await sendTelegramMessage(TOKEN, "999", "hello world");
    expect(res).toEqual({ ok: true });
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toContain("/sendMessage");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      chat_id: "999",
      text: "hello world",
    });
  });

  it("returns an error result (never throws) when Telegram rejects", async () => {
    mockFetchOnce({ ok: false });
    const res = await sendTelegramMessage(TOKEN, "999", "x");
    expect(res.ok).toBe(false);
  });

  it("swallows a transport throw into an error result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );
    const res = await sendTelegramMessage(TOKEN, "999", "x");
    expect(res.ok).toBe(false);
  });
});

describe("setTelegramWebhook", () => {
  it("registers the webhook with url + secret_token and succeeds", async () => {
    const fn = mockFetchOnce({ ok: true });
    const res = await setTelegramWebhook(
      TOKEN,
      "https://app.example/api/v1/connectors/telegram/webhook/ws-1",
      "sekret"
    );
    expect(res).toEqual({ ok: true });
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toContain("/setWebhook");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      url: "https://app.example/api/v1/connectors/telegram/webhook/ws-1",
      secret_token: "sekret",
    });
  });

  it("surfaces a Telegram rejection (best-effort, never throws)", async () => {
    mockFetchOnce({ ok: false, description: "Bad webhook: HTTPS required" });
    const res = await setTelegramWebhook(TOKEN, "http://insecure", "s");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/HTTPS/);
  });
});

describe("getTelegramUpdates (polling driver)", () => {
  it("returns well-formed updates and passes the offset", async () => {
    const fn = mockFetchOnce({
      ok: true,
      result: [
        { update_id: 10, message: { text: "/status", chat: { id: 1 } } },
        { update_id: 11, message: { text: "hi", chat: { id: 1 } } },
      ],
    });
    const res = await getTelegramUpdates(TOKEN, 10);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.updates).toHaveLength(2);
      expect(res.updates[0].update_id).toBe(10);
    }
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toContain("/getUpdates");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      offset: 10,
      allowed_updates: ["message"],
    });
  });

  it("filters out updates with no numeric update_id", async () => {
    mockFetchOnce({
      ok: true,
      result: [
        { update_id: 1, message: { text: "ok", chat: { id: 1 } } },
        { message: { text: "no id" } }, // dropped
        { update_id: "x" }, // dropped
      ],
    });
    const res = await getTelegramUpdates(TOKEN);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.updates).toHaveLength(1);
  });

  it("returns an error (never throws) when Telegram rejects (e.g. webhook set → 409)", async () => {
    mockFetchOnce({ ok: false, description: "Conflict: can't use getUpdates" });
    const res = await getTelegramUpdates(TOKEN);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Conflict/);
  });

  it("swallows a transport throw into an error result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const res = await getTelegramUpdates(TOKEN);
    expect(res.ok).toBe(false);
  });
});

describe("deleteTelegramWebhook (polling startup)", () => {
  it("succeeds when Telegram clears the webhook", async () => {
    const fn = mockFetchOnce({ ok: true });
    const res = await deleteTelegramWebhook(TOKEN);
    expect(res).toEqual({ ok: true });
    const [url] = fn.mock.calls[0];
    expect(String(url)).toContain("/deleteWebhook");
  });

  it("is harmless and reports best-effort on rejection (never throws)", async () => {
    mockFetchOnce({ ok: false, description: "nope" });
    const res = await deleteTelegramWebhook(TOKEN);
    expect(res.ok).toBe(false);
  });

  it("swallows a transport throw into an error result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const res = await deleteTelegramWebhook(TOKEN);
    expect(res.ok).toBe(false);
  });
});
