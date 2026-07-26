// Unit tests for the Discord Gateway listener's pure core: message admission,
// payload shaping, close-code classification, and the injected-transport
// console POST — all exercised without a live socket or network, per the
// spec's verification section.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isFromBot,
  isDirectMessage,
  mentionsBot,
  admitMessage,
  stripBotMention,
  buildProviderMessageId,
  shapeInboundPayload,
  FATAL_CLOSE_CODES,
  classifyCloseCode,
  DISCORD_INBOUND_PATH,
  resolveGatewayConsoleConfig,
  buildDiscordInboundUrl,
  postDiscordInboundMessage,
  INITIAL_CONNECT_MAX_ATTEMPTS,
  computeInitialConnectBackoffMs,
} from "../agent/lib/discord_gateway.core.mjs";

const BOT_ID = "1530306014740615328";

function guildMessage(overrides = {}) {
  return {
    id: "msg-1",
    channel_id: "chan-1",
    guild_id: "guild-1",
    author: { id: "user-1", username: "ada", global_name: "Ada", bot: false },
    mentions: [],
    content: "hello",
    ...overrides,
  };
}

function dmMessage(overrides = {}) {
  const msg = guildMessage(overrides);
  delete msg.guild_id;
  return msg;
}

// ---------------------------------------------------------------------------
// isFromBot / isDirectMessage / mentionsBot
// ---------------------------------------------------------------------------

test("isFromBot: true only when author.bot is exactly true", () => {
  assert.equal(isFromBot({ bot: true }), true);
  assert.equal(isFromBot({ bot: false }), false);
  assert.equal(isFromBot({}), false);
  assert.equal(isFromBot(null), false);
  assert.equal(isFromBot(undefined), false);
});

test("isDirectMessage: true iff guild_id is absent/null/undefined", () => {
  assert.equal(isDirectMessage({}), true);
  assert.equal(isDirectMessage({ guild_id: null }), true);
  assert.equal(isDirectMessage({ guild_id: undefined }), true);
  assert.equal(isDirectMessage({ guild_id: "guild-1" }), false);
});

test("isDirectMessage: false when guild_id is missing but a member object is present (malformed-guild-event guard)", () => {
  // Discord attaches `member` to every guild message and never to a DM — a
  // guild_id-only check fails OPEN on a malformed event missing guild_id but
  // still carrying `member`. Requiring member == null too keeps it out of
  // the "admit unconditionally" DM path.
  assert.equal(isDirectMessage({ member: { nick: "x" } }), false);
  assert.equal(isDirectMessage({ guild_id: null, member: {} }), false);
});

test("isDirectMessage: still true for a real DM shape (no guild_id, no member)", () => {
  assert.equal(isDirectMessage({ guild_id: undefined, member: undefined }), true);
});

test("mentionsBot: true iff botUserId appears in the mentions array", () => {
  assert.equal(mentionsBot([{ id: BOT_ID }], BOT_ID), true);
  assert.equal(mentionsBot([{ id: "someone-else" }], BOT_ID), false);
  assert.equal(mentionsBot([], BOT_ID), false);
  assert.equal(mentionsBot(undefined, BOT_ID), false);
  assert.equal(mentionsBot([{ id: BOT_ID }], ""), false, "no botUserId known yet -> never matches");
  assert.equal(mentionsBot([{ id: BOT_ID }], null), false);
});

// ---------------------------------------------------------------------------
// admitMessage — the full matrix from the spec: mention / DM / self /
// other-bot / empty.
// ---------------------------------------------------------------------------

test("admitMessage: no botUserId yet -> never admits", () => {
  const result = admitMessage(dmMessage(), undefined);
  assert.equal(result.admit, false);
  assert.match(result.reason, /bot user id not yet known/);
});

test("admitMessage: malformed payload (null / non-object) -> not admitted", () => {
  assert.equal(admitMessage(null, BOT_ID).admit, false);
  assert.equal(admitMessage(undefined, BOT_ID).admit, false);
  assert.equal(admitMessage("nope", BOT_ID).admit, false);
});

test("admitMessage: the bot's OWN message is ignored", () => {
  const msg = dmMessage({ author: { id: BOT_ID, username: "jace", bot: true } });
  const result = admitMessage(msg, BOT_ID);
  assert.equal(result.admit, false);
  assert.match(result.reason, /bot/);
});

test("admitMessage: another bot's message is ignored, even in a DM", () => {
  const msg = dmMessage({ author: { id: "other-bot", username: "carl-bot", bot: true } });
  assert.equal(admitMessage(msg, BOT_ID).admit, false);
});

test("admitMessage: empty content is ignored (DM)", () => {
  assert.equal(admitMessage(dmMessage({ content: "" }), BOT_ID).admit, false);
  assert.equal(admitMessage(dmMessage({ content: "   " }), BOT_ID).admit, false);
  assert.equal(admitMessage(dmMessage({ content: undefined }), BOT_ID).admit, false);
});

test("admitMessage: empty content is ignored even when it mentions the bot", () => {
  const msg = guildMessage({ content: "", mentions: [{ id: BOT_ID }] });
  assert.equal(admitMessage(msg, BOT_ID).admit, false);
});

test("admitMessage: a DM with real content is admitted", () => {
  const result = admitMessage(dmMessage(), BOT_ID);
  assert.equal(result.admit, true);
  assert.match(result.reason, /direct message/);
});

test("admitMessage: a guild message that mentions the bot is admitted", () => {
  const msg = guildMessage({ mentions: [{ id: BOT_ID }] });
  const result = admitMessage(msg, BOT_ID);
  assert.equal(result.admit, true);
  assert.match(result.reason, /mentions the bot/);
});

test("admitMessage: a guild message that does NOT mention the bot is ignored", () => {
  const msg = guildMessage({ mentions: [] });
  const result = admitMessage(msg, BOT_ID);
  assert.equal(result.admit, false);
  assert.match(result.reason, /without a mention/);
});

test("admitMessage: @everyone in a guild channel is NOT treated as a bot mention", () => {
  // Discord does not add every member to `mentions` for an @everyone/@here
  // sweep — mention_everyone is a separate flag this listener never reads.
  const msg = guildMessage({ mentions: [], mention_everyone: true, content: "@everyone hi" });
  assert.equal(admitMessage(msg, BOT_ID).admit, false);
});

test("admitMessage: a role mention (not this user id) does not admit", () => {
  const msg = guildMessage({ mentions: [{ id: "some-other-user" }], mention_roles: [BOT_ID] });
  assert.equal(admitMessage(msg, BOT_ID).admit, false);
});

test("admitMessage: a malformed event with no guild_id but a member object is NOT treated as a DM (fails closed, not open)", () => {
  const msg = guildMessage({ member: { nick: "x" } });
  delete msg.guild_id;
  // mentions is [] by default (from guildMessage()) -> falls through to the
  // ordinary "guild message without a mention" rejection, not silently
  // admitted as a DM.
  const result = admitMessage(msg, BOT_ID);
  assert.equal(result.admit, false);
  assert.match(result.reason, /without a mention/);
});

// ---------------------------------------------------------------------------
// admitMessage — I1: mention-only content (nothing left after stripping the
// bot's own mention token) must be skipped cleanly, not admitted then 400'd
// by the console's discord-inbound route.
// ---------------------------------------------------------------------------

test("admitMessage: a guild message that is ONLY the bot mention is NOT admitted (I1)", () => {
  const msg = guildMessage({ content: `<@${BOT_ID}>`, mentions: [{ id: BOT_ID }] });
  const result = admitMessage(msg, BOT_ID);
  assert.equal(result.admit, false);
  assert.match(result.reason, /empty after stripping/);
});

test("admitMessage: a guild message with only whitespace around the mention token is NOT admitted", () => {
  const msg = guildMessage({ content: `   <@!${BOT_ID}>   `, mentions: [{ id: BOT_ID }] });
  assert.equal(admitMessage(msg, BOT_ID).admit, false);
});

test("admitMessage: a guild mention WITH real text after it is still admitted", () => {
  const msg = guildMessage({ content: `<@${BOT_ID}> hello`, mentions: [{ id: BOT_ID }] });
  const result = admitMessage(msg, BOT_ID);
  assert.equal(result.admit, true);
  assert.match(result.reason, /mentions the bot/);
});

test("admitMessage: a DM is unaffected by the strip-empty check when its content has no mention token", () => {
  const result = admitMessage(dmMessage({ content: "hello" }), BOT_ID);
  assert.equal(result.admit, true);
});

// ---------------------------------------------------------------------------
// stripBotMention
// ---------------------------------------------------------------------------

test("stripBotMention: removes a plain <@id> mention token", () => {
  assert.equal(stripBotMention(`<@${BOT_ID}> hello`, BOT_ID), "hello");
});

test("stripBotMention: removes the legacy nickname-mention <@!id> form too", () => {
  assert.equal(stripBotMention(`<@!${BOT_ID}> hello`, BOT_ID), "hello");
});

test("stripBotMention: removes the mention wherever it sits, collapsing whitespace", () => {
  assert.equal(stripBotMention(`hello <@${BOT_ID}> there`, BOT_ID), "hello there");
  assert.equal(stripBotMention(`hello there <@${BOT_ID}>`, BOT_ID), "hello there");
});

test("stripBotMention: removes multiple occurrences", () => {
  assert.equal(stripBotMention(`<@${BOT_ID}> hi <@${BOT_ID}>`, BOT_ID), "hi");
});

test("stripBotMention: a DIFFERENT user's mention is left alone", () => {
  assert.equal(stripBotMention(`<@someone-else> hi <@${BOT_ID}>`, BOT_ID), "<@someone-else> hi");
});

test("stripBotMention: no botUserId -> content is returned trimmed, unmodified otherwise", () => {
  assert.equal(stripBotMention("  hi  ", undefined), "hi");
});

test("stripBotMention: non-string content -> empty string", () => {
  assert.equal(stripBotMention(undefined, BOT_ID), "");
  assert.equal(stripBotMention(null, BOT_ID), "");
});

// ---------------------------------------------------------------------------
// buildProviderMessageId / shapeInboundPayload
// ---------------------------------------------------------------------------

test("buildProviderMessageId: channelId:messageId, matching the interactions door's own convention", () => {
  assert.equal(buildProviderMessageId("998877", "int-42"), "998877:int-42");
});

test("shapeInboundPayload: builds the discord-inbound body from a guild mention", () => {
  const message = guildMessage({
    channel_id: "chan-1",
    id: "msg-1",
    author: { id: "user-1", username: "ada", global_name: "Ada", bot: false },
    content: `<@${BOT_ID}> what's the status?`,
  });
  const payload = shapeInboundPayload({ message, botUserId: BOT_ID });
  assert.deepEqual(payload, {
    channelId: "chan-1",
    messageId: "msg-1",
    senderId: "user-1",
    senderDisplay: "Ada",
    senderUsername: "ada",
    text: "what's the status?",
  });
});

test("shapeInboundPayload: display name falls back to username, then the raw id", () => {
  const noGlobalName = guildMessage({ author: { id: "user-2", username: "ada_handle", bot: false } });
  assert.equal(shapeInboundPayload({ message: noGlobalName, botUserId: BOT_ID }).senderDisplay, "ada_handle");

  const noNameAtAll = guildMessage({ author: { id: "user-3", bot: false } });
  const shaped = shapeInboundPayload({ message: noNameAtAll, botUserId: BOT_ID });
  assert.equal(shaped.senderDisplay, "user-3");
  assert.equal(shaped.senderUsername, null);
});

test("shapeInboundPayload: display name uses ?? not || — an explicit empty string is kept, matching the interactions webhook door's chain", () => {
  const emptyGlobalName = guildMessage({
    author: { id: "user-4", username: "ada_handle", global_name: "", bot: false },
  });
  assert.equal(shapeInboundPayload({ message: emptyGlobalName, botUserId: BOT_ID }).senderDisplay, "");
});

test("shapeInboundPayload: works on a DM message (no channel-mention token to strip)", () => {
  const message = dmMessage({ content: "hey jace" });
  const payload = shapeInboundPayload({ message, botUserId: BOT_ID });
  assert.equal(payload.text, "hey jace");
});

// ---------------------------------------------------------------------------
// classifyCloseCode
// ---------------------------------------------------------------------------

test("classifyCloseCode: every documented non-recoverable code is fatal", () => {
  for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
    const result = classifyCloseCode(code);
    assert.equal(result.fatal, true, `code ${code} must classify as fatal`);
    assert.ok(result.summary.length > 0);
  }
});

test("PIN: FATAL_CLOSE_CODES is exactly the six Discord documents as non-recoverable", () => {
  assert.deepEqual(
    Object.keys(FATAL_CLOSE_CODES).map(Number).sort((a, b) => a - b),
    [4004, 4010, 4011, 4012, 4013, 4014],
  );
});

test("classifyCloseCode: 4014 (disallowed intents) names the privileged-intent cause", () => {
  const result = classifyCloseCode(4014);
  assert.equal(result.fatal, true);
  assert.match(result.summary, /intent/i);
});

test("classifyCloseCode: every documented recoverable code is non-fatal", () => {
  for (const code of [1000, 4000, 4001, 4002, 4003, 4005, 4007, 4008, 4009]) {
    const result = classifyCloseCode(code);
    assert.equal(result.fatal, false, `code ${code} must NOT classify as fatal`);
    assert.ok(result.summary.length > 0);
  }
});

test("classifyCloseCode: an unrecognized code defaults to non-fatal with a generic summary", () => {
  const result = classifyCloseCode(1006);
  assert.equal(result.fatal, false);
  assert.match(result.summary, /1006/);
});

// ---------------------------------------------------------------------------
// resolveGatewayConsoleConfig / buildDiscordInboundUrl
// ---------------------------------------------------------------------------

test("resolveGatewayConsoleConfig: both vars set -> ok, trimmed, trailing slash stripped", () => {
  const result = resolveGatewayConsoleConfig({
    JACE_CONSOLE_BASE_URL: " http://console:3000/ ",
    JACE_CONSOLE_TOKEN: " secret ",
  });
  assert.deepEqual(result, { ok: true, baseUrl: "http://console:3000", token: "secret" });
});

test("resolveGatewayConsoleConfig: missing vars are reported by name", () => {
  assert.deepEqual(resolveGatewayConsoleConfig({}), {
    ok: false,
    missing: ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"],
  });
  assert.deepEqual(resolveGatewayConsoleConfig({ JACE_CONSOLE_BASE_URL: "http://x" }), {
    ok: false,
    missing: ["JACE_CONSOLE_TOKEN"],
  });
});

test("resolveGatewayConsoleConfig: whitespace-only counts as unset", () => {
  const result = resolveGatewayConsoleConfig({ JACE_CONSOLE_BASE_URL: "   ", JACE_CONSOLE_TOKEN: "  " });
  assert.equal(result.ok, false);
});

test("buildDiscordInboundUrl: appends the runner discord-inbound path", () => {
  assert.equal(buildDiscordInboundUrl("http://console:3000"), "http://console:3000/api/v1/runner/discord-inbound");
  assert.equal(DISCORD_INBOUND_PATH, "/api/v1/runner/discord-inbound");
});

// ---------------------------------------------------------------------------
// postDiscordInboundMessage — injected transport, never throws.
// ---------------------------------------------------------------------------

const ENV = { JACE_CONSOLE_BASE_URL: "http://console:3000", JACE_CONSOLE_TOKEN: "secret" };
const BASE_ARGS = {
  channelId: "chan-1",
  messageId: "msg-1",
  senderId: "user-1",
  senderDisplay: "Ada",
  senderUsername: "ada",
  text: "hello",
};

test("postDiscordInboundMessage: missing config -> ok:false, transport never called", async () => {
  let called = false;
  const result = await postDiscordInboundMessage({
    ...BASE_ARGS,
    env: {},
    transport: async () => {
      called = true;
      return { status: 200, json: async () => ({}) };
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /JACE_CONSOLE_BASE_URL/);
  assert.equal(called, false);
});

test("postDiscordInboundMessage: sends the right method/headers/body", async () => {
  let captured;
  await postDiscordInboundMessage({
    ...BASE_ARGS,
    env: ENV,
    transport: async (url, init) => {
      captured = { url, init };
      return { status: 200, json: async () => ({ ok: true, deduped: false }) };
    },
  });
  assert.equal(captured.url, "http://console:3000/api/v1/runner/discord-inbound");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["Authorization"], "Bearer secret");
  assert.equal(captured.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(captured.init.body), BASE_ARGS);
});

test("postDiscordInboundMessage: a transport throw resolves to ok:false, never rejects", async () => {
  const result = await postDiscordInboundMessage({
    ...BASE_ARGS,
    env: ENV,
    transport: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNREFUSED/);
});

test("postDiscordInboundMessage: a non-2xx response resolves to ok:false with the status", async () => {
  const result = await postDiscordInboundMessage({
    ...BASE_ARGS,
    env: ENV,
    transport: async () => ({ status: 401, json: async () => ({ error: "Unauthorized" }) }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /401/);
});

test("postDiscordInboundMessage: a 2xx with deduped:true is reported", async () => {
  const result = await postDiscordInboundMessage({
    ...BASE_ARGS,
    env: ENV,
    transport: async () => ({ status: 200, json: async () => ({ ok: true, deduped: true }) }),
  });
  assert.deepEqual(result, { ok: true, deduped: true });
});

test("postDiscordInboundMessage: a 2xx with an unparsable body is still ok:true, deduped:false", async () => {
  const result = await postDiscordInboundMessage({
    ...BASE_ARGS,
    env: ENV,
    transport: async () => ({
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }),
  });
  assert.deepEqual(result, { ok: true, deduped: false });
});

// ---------------------------------------------------------------------------
// computeInitialConnectBackoffMs / INITIAL_CONNECT_MAX_ATTEMPTS (I4) — the
// INITIAL manager.connect() retry backoff. Mid-session reconnect backoff is
// @discordjs/ws's own internal responsibility and is not covered here.
// ---------------------------------------------------------------------------

test("INITIAL_CONNECT_MAX_ATTEMPTS: capped at 5 per the spec", () => {
  assert.equal(INITIAL_CONNECT_MAX_ATTEMPTS, 5);
});

test("computeInitialConnectBackoffMs: grows exponentially with attempt, capped at 15s (random()=1 pins the delay to the cap exactly)", () => {
  const deps = { random: () => 1 };
  assert.equal(computeInitialConnectBackoffMs(1, deps), 500);
  assert.equal(computeInitialConnectBackoffMs(2, deps), 1000);
  assert.equal(computeInitialConnectBackoffMs(3, deps), 2000);
  assert.equal(computeInitialConnectBackoffMs(4, deps), 4000);
  assert.equal(computeInitialConnectBackoffMs(5, deps), 8000);
  assert.equal(computeInitialConnectBackoffMs(6, deps), 15000, "capped at the max delay");
  assert.equal(computeInitialConnectBackoffMs(20, deps), 15000, "stays capped, never grows unbounded");
});

test("computeInitialConnectBackoffMs: random()=0 -> zero delay (full jitter's lower bound)", () => {
  assert.equal(computeInitialConnectBackoffMs(1, { random: () => 0 }), 0);
});

test("computeInitialConnectBackoffMs: mid-range jitter stays strictly inside (0, cap) for that attempt", () => {
  const delay = computeInitialConnectBackoffMs(2, { random: () => 0.5 });
  assert.equal(delay, 500, "0.5 * 1000ms cap");
});

test("computeInitialConnectBackoffMs: defaults to Math.random when no deps given, staying in [0, 500)", () => {
  const delay = computeInitialConnectBackoffMs(1);
  assert.ok(delay >= 0 && delay < 500, `expected [0,500), got ${delay}`);
});
