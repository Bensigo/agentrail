// Structural test for the Discord channel's multi-message wiring.
//
// agent/channels/discord.ts is a `.ts` Eve channel module — `node --test`
// cannot import it directly (no TS loader is configured for the test run, and
// constructing a real `discordChannel()` would require Eve's runtime
// context). Following this repo's convention (see telegram-channel.test.mjs),
// the split LOGIC lives in and is fully exercised by chat-split.core.test.mjs;
// this test only locks the WIRING — that the channel's `message.completed`
// override actually calls the pure splitter and preserves Eve's default
// guard — by reading the source as text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const discordTsPath = fileURLToPath(
  new URL("../agent/channels/discord.ts", import.meta.url),
);
const code = readFileSync(discordTsPath, "utf8");

test("imports the pure splitter from agent/lib", () => {
  assert.match(
    code,
    /import\s*{\s*splitIntoChatMessages\s*}\s*from\s*["']\.\.\/lib\/chat-split\.core\.mjs["']/,
  );
});

test("overrides message.completed and preserves Eve's default guard", () => {
  // Same guard as eve's built-in default handler: skip tool-call turns and
  // empty messages, so behavior for those turns is unchanged.
  assert.match(code, /events\s*:\s*\{/);
  assert.match(code, /["']message\.completed["']/);
  assert.match(code, /data\.finishReason\s*===\s*["']tool-calls["']/);
  assert.match(code, /!data\.message/);
});

test("posts the split messages and pauses typing between them", () => {
  assert.match(code, /splitIntoChatMessages\(data\.message\)/);
  assert.match(code, /channel\.discord\.post\(message\)/);
  assert.match(code, /channel\.discord\.startTyping\(\)/);
});

// --- prod bug fix: reply via the interaction followup webhook -------------
//
// Root cause (diagnosed in prod 2026-07-25): channel.discord.post() always
// posts through the Bot API, which needs channel permissions the shared
// hosted bot may not have in a private channel or user-install. These tests
// lock the WIRING of the fix — that the handler reads the interaction token
// out of ctx.session.auth.initiator.attributes (the one seam eve forwards
// `auth` through unchanged into, per eve@0.19.0's SessionAuthContext/
// SessionContext types) and hands delivery to the pure, unit-tested
// discord-followup.core.mjs, whose own branch coverage
// (test/discord-followup.core.test.mjs) exercises followup-vs-fallback.

test("imports the pure followup-delivery core from agent/lib", () => {
  assert.match(
    code,
    /import\s*{\s*deliverDiscordBubble\s*}\s*from\s*["']\.\.\/lib\/discord-followup\.core\.mjs["']/,
  );
});

test("message.completed accepts ctx (3rd handler arg) to reach session.auth.initiator", () => {
  assert.match(code, /async\s*["']message\.completed["']\s*\(\s*data\s*,\s*channel\s*,\s*ctx\s*\)/);
});

test("reads the followup credential out of ctx.session.auth.initiator.attributes, defensively", () => {
  assert.match(code, /ctx\??\.session\??\.auth\??\.initiator\??\.attributes/);
});

test("delegates delivery to deliverDiscordBubble, still passing channel.discord.post(message) as the bot fallback", () => {
  assert.match(code, /deliverDiscordBubble\(/);
  assert.match(code, /postViaBot\s*:\s*\(\)\s*=>\s*channel\.discord\.post\(message\)/);
});

test("the followup transport sends no Authorization header (the token IS the credential)", () => {
  // A structural guard against a regression that bolts bot-token auth onto
  // the followup call — the whole point of this endpoint is that it needs
  // none. The transport helper's header object must be exactly Content-Type.
  assert.doesNotMatch(code, /Authorization/);
});
