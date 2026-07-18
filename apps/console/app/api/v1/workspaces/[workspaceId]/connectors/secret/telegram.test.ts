import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveTelegramChatId,
  sendTelegramWelcome,
  sendTelegramMessage,
  buildApprovalKeyboard,
  parseApprovalCallbackData,
  answerCallbackQuery,
  editMessageText,
  APPROVAL_CALLBACK_PREFIX,
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

  it("includes reply_markup in the body when supplied (issue #1273)", async () => {
    const fn = mockFetchOnce({ ok: true });
    const keyboard = buildApprovalKeyboard("cbtoken123456");

    const res = await sendTelegramMessage(TOKEN, "999", "approve?", keyboard);

    expect(res).toEqual({ ok: true });
    const [, init] = fn.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      chat_id: "999",
      text: "approve?",
      reply_markup: keyboard,
    });
  });

  it("omits reply_markup from the body entirely when not supplied — byte-unchanged for existing callers", async () => {
    const fn = mockFetchOnce({ ok: true });

    await sendTelegramMessage(TOKEN, "999", "hello world");

    const [, init] = fn.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).not.toHaveProperty("reply_markup");
    expect(body).toEqual({ chat_id: "999", text: "hello world" });
  });
});

describe("buildApprovalKeyboard (issue #1273)", () => {
  it("builds a single row with an Approve and a Deny button", () => {
    const keyboard = buildApprovalKeyboard("cbtoken123456");
    expect(keyboard.inline_keyboard).toHaveLength(1);
    expect(keyboard.inline_keyboard[0]).toHaveLength(2);
  });

  it("encodes callback_data starting with the shared 'ar:' prefix, distinguishable per button, under Telegram's 64-byte cap", () => {
    const token = "abcdef0123456789"; // 16 hex chars, the recordApprovalRequest shape
    const keyboard = buildApprovalKeyboard(token);
    const [approve, deny] = keyboard.inline_keyboard[0]!;

    expect(approve!.callback_data.startsWith(APPROVAL_CALLBACK_PREFIX)).toBe(true);
    expect(deny!.callback_data.startsWith(APPROVAL_CALLBACK_PREFIX)).toBe(true);
    expect(approve!.callback_data).not.toBe(deny!.callback_data);
    expect(Buffer.byteLength(approve!.callback_data, "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(deny!.callback_data, "utf8")).toBeLessThanOrEqual(64);
  });

  it("round-trips through parseApprovalCallbackData: Approve -> approved, Deny -> denied, same token", () => {
    const token = "abcdef0123456789";
    const keyboard = buildApprovalKeyboard(token);
    const [approve, deny] = keyboard.inline_keyboard[0]!;

    expect(parseApprovalCallbackData(approve!.callback_data)).toEqual({
      decision: "approved",
      callbackToken: token,
    });
    expect(parseApprovalCallbackData(deny!.callback_data)).toEqual({
      decision: "denied",
      callbackToken: token,
    });
  });
});

describe("parseApprovalCallbackData (issue #1273)", () => {
  it("returns null for data that does not start with the 'ar:' prefix (e.g. Eve's own 'eve:'-prefixed data)", () => {
    expect(parseApprovalCallbackData("eve:something")).toBeNull();
    expect(parseApprovalCallbackData("")).toBeNull();
  });

  it("returns null for a malformed 'ar:' payload with no token after the flag", () => {
    expect(parseApprovalCallbackData("ar:y")).toBeNull();
    expect(parseApprovalCallbackData("ar:")).toBeNull();
  });

  it("returns null for an 'ar:' payload with an unrecognized decision flag", () => {
    expect(parseApprovalCallbackData("ar:xtoken123")).toBeNull();
  });
});

describe("answerCallbackQuery", () => {
  it("posts callback_query_id and text to answerCallbackQuery", async () => {
    const fn = mockFetchOnce({ ok: true });
    const res = await answerCallbackQuery(TOKEN, "cbq-1", "Approved");

    expect(res).toEqual({ ok: true });
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toContain("/answerCallbackQuery");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      callback_query_id: "cbq-1",
      text: "Approved",
    });
  });

  it("omits text from the body when not supplied", async () => {
    const fn = mockFetchOnce({ ok: true });
    await answerCallbackQuery(TOKEN, "cbq-1");

    const [, init] = fn.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      callback_query_id: "cbq-1",
    });
  });

  it("returns an error result (never throws) when Telegram rejects", async () => {
    mockFetchOnce({ ok: false });
    const res = await answerCallbackQuery(TOKEN, "cbq-1");
    expect(res.ok).toBe(false);
  });

  it("swallows a transport throw into an error result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const res = await answerCallbackQuery(TOKEN, "cbq-1");
    expect(res.ok).toBe(false);
  });
});

describe("editMessageText", () => {
  it("posts chat_id, message_id and text to editMessageText", async () => {
    const fn = mockFetchOnce({ ok: true });
    const res = await editMessageText(TOKEN, -100123, 42, "updated text");

    expect(res).toEqual({ ok: true });
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toContain("/editMessageText");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      chat_id: -100123,
      message_id: 42,
      text: "updated text",
    });
  });

  it("returns an error result (never throws) when Telegram rejects", async () => {
    mockFetchOnce({ ok: false });
    const res = await editMessageText(TOKEN, -100123, 42, "x");
    expect(res.ok).toBe(false);
  });

  it("swallows a transport throw into an error result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const res = await editMessageText(TOKEN, -100123, 42, "x");
    expect(res.ok).toBe(false);
  });
});
