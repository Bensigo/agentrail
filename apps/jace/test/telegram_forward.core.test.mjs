// Unit tests for the Telegram forward core: update shaping and the
// injected-transport console POST — all exercised without a live network,
// mirroring discord_gateway.core.test.mjs's coverage of the analogous
// admitted-message -> discord-inbound path.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shapeTelegramInbound,
  forwardTelegramInbound,
  admitTelegramMessage,
  TELEGRAM_INBOUND_PATH,
  resolveConsoleConfig,
  buildTelegramInboundUrl,
} from "../agent/lib/telegram_forward.core.mjs";

function telegramUpdate(overrides = {}) {
  // `message` is merged field-by-field (see below) rather than replaced
  // wholesale, so it must be excluded from the outer `...rest` spread —
  // otherwise a `...overrides` applied AFTER the merged `message` would
  // clobber it back to the caller's own (partial, unmerged) override object.
  const { message: messageOverrides, ...rest } = overrides;
  return {
    update_id: 100,
    message: {
      message_id: 42,
      date: 1234567890,
      chat: { id: 555, type: "private" },
      from: { id: 777, username: "ada", first_name: "Ada", last_name: "Lovelace" },
      text: "hello Jace",
      ...messageOverrides,
    },
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// shapeTelegramInbound
// ---------------------------------------------------------------------------

test("shapeTelegramInbound: a well-formed update shapes correctly", () => {
  const result = shapeTelegramInbound(telegramUpdate());
  assert.deepEqual(result, {
    ok: true,
    body: {
      chatId: "555",
      messageId: "42",
      senderId: "777",
      senderDisplay: "ada",
      senderUsername: "ada",
      text: "hello Jace",
    },
  });
});

test("shapeTelegramInbound: falls back to first_name/last_name when no username", () => {
  const update = telegramUpdate();
  delete update.message.from.username;
  const result = shapeTelegramInbound(update);
  assert.equal(result.ok, true);
  assert.equal(result.body.senderDisplay, "Ada Lovelace");
  assert.equal(result.body.senderUsername, null);
});

test("shapeTelegramInbound: an edited_message is shaped the same as message", () => {
  const update = telegramUpdate();
  update.edited_message = update.message;
  delete update.message;
  const result = shapeTelegramInbound(update);
  assert.equal(result.ok, true);
  assert.equal(result.body.text, "hello Jace");
});

test("shapeTelegramInbound: a message carrying no text or caption is refused", () => {
  const update = telegramUpdate();
  delete update.message.text;
  const result = shapeTelegramInbound(update);
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, "string");
});

test("shapeTelegramInbound: whitespace-only text is refused", () => {
  const update = telegramUpdate({ message: { text: "   " } });
  const result = shapeTelegramInbound(update);
  assert.equal(result.ok, false);
});

test("shapeTelegramInbound: an update with neither message nor edited_message is refused", () => {
  const result = shapeTelegramInbound({ update_id: 1, my_chat_member: {} });
  assert.equal(result.ok, false);
});

test("shapeTelegramInbound: a malformed update (not an object) is refused", () => {
  assert.equal(shapeTelegramInbound(null).ok, false);
  assert.equal(shapeTelegramInbound(undefined).ok, false);
  assert.equal(shapeTelegramInbound("nope").ok, false);
});

test("shapeTelegramInbound: a message missing chat/from is refused", () => {
  const update = telegramUpdate();
  delete update.message.chat;
  assert.equal(shapeTelegramInbound(update).ok, false);
});

// ---------------------------------------------------------------------------
// Group/supergroup mention gate (Finding 1, final-branch review) —
// shapeTelegramInbound's admission of group/supergroup traffic, mirroring
// eve's own shouldDispatchTelegramMessage.
// ---------------------------------------------------------------------------

test("shapeTelegramInbound: a private chat admits, even with no botUsername known", () => {
  const result = shapeTelegramInbound(telegramUpdate());
  assert.equal(result.ok, true);
});

test("shapeTelegramInbound: a bare group message (no command/mention/reply) is refused", () => {
  const update = telegramUpdate({
    message: { chat: { id: 555, type: "group" }, text: "just chatting" },
  });
  const result = shapeTelegramInbound(update, { botUsername: "jace_bot" });
  assert.equal(result.ok, false);
});

test("shapeTelegramInbound: a group message starting with /command is admitted", () => {
  const update = telegramUpdate({
    message: { chat: { id: 555, type: "group" }, text: "/start" },
  });
  const result = shapeTelegramInbound(update, { botUsername: "jace_bot" });
  assert.equal(result.ok, true);
});

test("shapeTelegramInbound: a group message containing @botusername is admitted", () => {
  const update = telegramUpdate({
    message: { chat: { id: 555, type: "group" }, text: "hey @jace_bot can you help" },
  });
  const result = shapeTelegramInbound(update, { botUsername: "jace_bot" });
  assert.equal(result.ok, true);
});

test("shapeTelegramInbound: the @mention match is case-insensitive", () => {
  const update = telegramUpdate({
    message: { chat: { id: 555, type: "group" }, text: "hey @JACE_BOT" },
  });
  const result = shapeTelegramInbound(update, { botUsername: "jace_bot" });
  assert.equal(result.ok, true);
});

test("shapeTelegramInbound: a group message replying to the bot's own message is admitted", () => {
  const update = telegramUpdate({
    message: {
      chat: { id: 555, type: "group" },
      text: "yes please",
      reply_to_message: { from: { is_bot: true } },
    },
  });
  const result = shapeTelegramInbound(update, { botUsername: "jace_bot" });
  assert.equal(result.ok, true);
});

test("shapeTelegramInbound: a group message replying to a human (not the bot) is refused", () => {
  const update = telegramUpdate({
    message: {
      chat: { id: 555, type: "group" },
      text: "yes please",
      reply_to_message: { from: { is_bot: false } },
    },
  });
  const result = shapeTelegramInbound(update, { botUsername: "jace_bot" });
  assert.equal(result.ok, false);
});

test("shapeTelegramInbound: a supergroup follows the identical gate as group", () => {
  const bare = telegramUpdate({
    message: { chat: { id: 555, type: "supergroup" }, text: "hi" },
  });
  assert.equal(shapeTelegramInbound(bare, { botUsername: "jace_bot" }).ok, false);

  const command = telegramUpdate({
    message: { chat: { id: 555, type: "supergroup" }, text: "/start" },
  });
  assert.equal(shapeTelegramInbound(command, { botUsername: "jace_bot" }).ok, true);
});

test("shapeTelegramInbound: a channel post is refused outright, even with a slash command", () => {
  const update = telegramUpdate({
    message: { chat: { id: 555, type: "channel" }, text: "/start" },
  });
  assert.equal(shapeTelegramInbound(update, { botUsername: "jace_bot" }).ok, false);
});

// ---------------------------------------------------------------------------
// admitTelegramMessage (unit)
// ---------------------------------------------------------------------------

test("admitTelegramMessage: private admits unconditionally", () => {
  assert.equal(admitTelegramMessage({ chat: { type: "private" } }, undefined), true);
});

test("admitTelegramMessage: group without command/mention/reply refuses", () => {
  assert.equal(
    admitTelegramMessage({ chat: { type: "group" }, text: "hello" }, "jace_bot"),
    false,
  );
});

test("admitTelegramMessage: a bare /command admits even with no botUsername known", () => {
  assert.equal(admitTelegramMessage({ chat: { type: "group" }, text: "/start" }, undefined), true);
});

test("admitTelegramMessage: an unrecognized chat type (e.g. channel) refuses regardless", () => {
  assert.equal(
    admitTelegramMessage({ chat: { type: "channel" }, text: "/start" }, "jace_bot"),
    false,
  );
});

// ---------------------------------------------------------------------------
// resolveConsoleConfig / buildTelegramInboundUrl
// ---------------------------------------------------------------------------

test("resolveConsoleConfig: both vars set -> ok, trimmed, trailing slash stripped", () => {
  const result = resolveConsoleConfig({
    JACE_CONSOLE_BASE_URL: " http://console:3000/ ",
    JACE_CONSOLE_TOKEN: " secret ",
  });
  assert.deepEqual(result, { ok: true, baseUrl: "http://console:3000", token: "secret" });
});

test("resolveConsoleConfig: missing vars are reported by name", () => {
  assert.deepEqual(resolveConsoleConfig({}), {
    ok: false,
    missing: ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"],
  });
});

test("buildTelegramInboundUrl: appends the runner telegram-inbound path", () => {
  assert.equal(
    buildTelegramInboundUrl("http://console:3000"),
    "http://console:3000/api/v1/runner/telegram-inbound",
  );
  assert.equal(TELEGRAM_INBOUND_PATH, "/api/v1/runner/telegram-inbound");
});

// ---------------------------------------------------------------------------
// forwardTelegramInbound — injected transport, never throws, never retries.
// ---------------------------------------------------------------------------

const ENV = { JACE_CONSOLE_BASE_URL: "http://console:3000", JACE_CONSOLE_TOKEN: "secret" };

test("forwardTelegramInbound: a message with no text is refused WITHOUT a network call", async () => {
  let called = false;
  const update = telegramUpdate();
  delete update.message.text;
  const result = await forwardTelegramInbound({
    env: ENV,
    update,
    transport: async () => {
      called = true;
      return { status: 200 };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test("forwardTelegramInbound: sends the right method/headers/body", async () => {
  let captured;
  await forwardTelegramInbound({
    env: ENV,
    update: telegramUpdate(),
    transport: async (url, init) => {
      captured = { url, init };
      return { status: 200 };
    },
  });
  assert.equal(captured.url, "http://console:3000/api/v1/runner/telegram-inbound");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["Authorization"], "Bearer secret");
  assert.equal(captured.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(captured.init.body), {
    chatId: "555",
    messageId: "42",
    senderId: "777",
    senderDisplay: "ada",
    senderUsername: "ada",
    text: "hello Jace",
  });
});

test("forwardTelegramInbound: a transport throw resolves to ok:false, never rejects", async () => {
  const result = await forwardTelegramInbound({
    env: ENV,
    update: telegramUpdate(),
    transport: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /ECONNREFUSED/);
});

test("forwardTelegramInbound: a non-2xx status resolves to ok:false carrying the status", async () => {
  const result = await forwardTelegramInbound({
    env: ENV,
    update: telegramUpdate(),
    transport: async () => ({ status: 401 }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /401/);
});

test("forwardTelegramInbound: missing console config resolves to ok:false, reason config_missing", async () => {
  let called = false;
  const result = await forwardTelegramInbound({
    env: {},
    update: telegramUpdate(),
    transport: async () => {
      called = true;
      return { status: 200 };
    },
  });
  assert.deepEqual(result, { ok: false, reason: "config_missing" });
  assert.equal(called, false);
});

test("forwardTelegramInbound: a bare group message is refused WITHOUT a network call (Finding 1)", async () => {
  let called = false;
  const update = telegramUpdate({
    message: { chat: { id: 555, type: "group" }, text: "just chatting" },
  });
  const result = await forwardTelegramInbound({
    env: { ...ENV, TELEGRAM_BOT_USERNAME: "jace_bot" },
    update,
    transport: async () => {
      called = true;
      return { status: 200 };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test("forwardTelegramInbound: threads env.TELEGRAM_BOT_USERNAME through to the mention gate", async () => {
  let called = false;
  const update = telegramUpdate({
    message: { chat: { id: 555, type: "group" }, text: "hey @jace_bot" },
  });
  const result = await forwardTelegramInbound({
    env: { ...ENV, TELEGRAM_BOT_USERNAME: "jace_bot" },
    update,
    transport: async () => {
      called = true;
      return { status: 200 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(called, true);
});

test("forwardTelegramInbound: a 2xx status resolves to ok:true", async () => {
  const result = await forwardTelegramInbound({
    env: ENV,
    update: telegramUpdate(),
    transport: async () => ({ status: 200 }),
  });
  assert.deepEqual(result, { ok: true });
});
