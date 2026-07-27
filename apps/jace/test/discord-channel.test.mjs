// Structural test for the Discord channel's multi-message wiring.
//
// agent/channels/discord.ts is a `.ts` Eve channel module — `node --test`
// cannot import it directly (no TS loader is configured for the test run, and
// constructing a real `discordChannel()` would require Eve's runtime
// context). Following this repo's convention (see telegram-channel.test.mjs),
// ALL the real logic — paragraph splitting (chat-split.core.mjs), and the
// bubble-loop/typing/followup-vs-fallback/current-vs-initiator delivery
// (discord-followup.core.mjs) — lives in and is fully exercised FOR REAL by
// chat-split.core.test.mjs and discord-followup.core.test.mjs respectively;
// this test only locks the WIRING — that the channel's `message.completed`
// override preserves Eve's default guard and hands off to the right pure
// functions with the right arguments — by reading the source as text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const discordTsPath = fileURLToPath(
  new URL("../agent/channels/discord.ts", import.meta.url),
);
const code = readFileSync(discordTsPath, "utf8");

test("passes Discord credentials explicitly (C1) — eve's compiled callDiscordApi only sets the auth header when config.credentials.botToken is defined, so its documented DISCORD_BOT_TOKEN env fallback is unreachable without this", () => {
  assert.match(code, /credentials\s*:\s*\{/);
  assert.match(code, /botToken\s*:\s*process\.env\[["']DISCORD_BOT_TOKEN["']\]/);
  assert.match(code, /applicationId\s*:\s*process\.env\[["']DISCORD_APPLICATION_ID["']\]/);
  assert.match(code, /publicKey\s*:\s*process\.env\[["']DISCORD_PUBLIC_KEY["']\]/);
});

test("tunes the typing keep-alive refresh for Discord's ~10s expiry, not the module's Telegram-tuned 4000ms default", () => {
  assert.match(code, /createTypingKeepalive\(\s*\{\s*refreshMs:\s*8000\s*\}\s*\)/);
});

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

test("delegates the full reply to deliverDiscordReply, injecting the real Eve callbacks", () => {
  // The split/loop/typing/delivery logic used to live directly in this
  // file, where it could only be regex-matched, never executed (`node
  // --test` can't import a `.ts` Eve channel module without a TS loader).
  // fix-1-brief.md's minor "move the bubble loop into the core module ...
  // and test it for real" moved it into deliverDiscordReply
  // (agent/lib/discord-followup.core.mjs), which
  // discord-followup.core.test.mjs executes for real. This test only locks
  // that discord.ts wires the REAL Eve callbacks into it correctly.
  assert.match(code, /deliverDiscordReply\(\s*\{/);
  assert.match(code, /text\s*:\s*data\.message/);
  assert.match(code, /splitMessage\s*:\s*splitIntoChatMessages/);
  assert.match(
    code,
    /postViaBot\s*:\s*\(\s*message\s*\)\s*=>\s*channel\.discord\.post\(message\)/,
  );
  assert.match(
    code,
    /startTyping\s*:\s*\(\)\s*=>\s*channel\.discord\.startTyping\(\)/,
  );
});

// --- prod bug fix: reply via the interaction followup webhook -------------
//
// Root cause (diagnosed in prod 2026-07-25): channel.discord.post() always
// posts through the Bot API, which needs channel permissions the shared
// hosted bot may not have in a private channel or user-install. These tests
// lock the WIRING of the fix — that the handler resolves the followup
// credential via resolveSessionAuthAttributes(ctx.session.auth) (current,
// falling back to initiator ONLY — see that function's own doc comment for
// why "current" has to come first, verified against eve@0.19.0's REAL
// compiled runtime, not just its .d.ts stubs) and hands the whole reply to
// the pure, unit-tested discord-followup.core.mjs, whose own branch coverage
// (test/discord-followup.core.test.mjs) exercises followup-vs-fallback,
// current-beats-a-differing-initiator, 2000-char chunking, and mention
// suppression FOR REAL.
//
// The whole-file `assert.doesNotMatch(code, /Authorization/)` scan that used
// to live here is dropped (fix-1-brief.md minor): it breaks on any comment
// merely mentioning the word "Authorization", and
// discord-followup.core.test.mjs's "sends NO Authorization header" test
// already deep-equals the real `init.headers` object passed to the
// transport — a strictly stronger guarantee than grepping source text.

test("imports the pure followup-delivery core from agent/lib", () => {
  // deliverDiscordBubble joined this import in the ack-on-silence wiring
  // (Task 3): the ack is a reply like any other, so it reuses the same
  // followup-first bubble delivery deliverDiscordReply is built on.
  assert.match(
    code,
    /import\s*\{\s*deliverDiscordBubble\s*,\s*deliverDiscordReply\s*,\s*resolveSessionAuthAttributes\s*,?\s*\}\s*from\s*["']\.\.\/lib\/discord-followup\.core\.mjs["']/,
  );
});

test("message.completed accepts ctx (3rd handler arg) to reach session.auth", () => {
  assert.match(code, /async\s*["']message\.completed["']\s*\(\s*data\s*,\s*channel\s*,\s*ctx\s*\)/);
});

test("resolves the followup attributes via resolveSessionAuthAttributes(ctx.session.auth) — the whole point being that discord.ts itself never picks current vs initiator", () => {
  // Deliberately NOT a doesNotMatch(/ctx.session.auth.initiator/) guard
  // alongside this: this file's own header comment above legitimately
  // discusses both `.current` and `.initiator` in prose, and a whole-file
  // substring scan can't tell doc-comment prose from live code — exactly the
  // fragility fix-1-brief.md's minor flags about the OLD Authorization scan
  // this file used to have (now removed, see below). The single positive
  // match below is what actually matters: the attribute-precedence decision
  // happens in resolveSessionAuthAttributes, not here.
  assert.match(
    code,
    /resolveSessionAuthAttributes\(\s*ctx\??\.session\??\.auth\s*\)/,
  );
});

test("wires the typing keep-alive: start on turn.started, stop on turn end", () => {
  // The keep-alive LOGIC is fully exercised by typing-keepalive.core.test.mjs;
  // this locks that the channel actually drives it on the right events —
  // benefits both the interaction-backed reply path and the Gateway
  // receive()-triggered path equally (both go through channel.discord.startTyping()).
  //
  // turn.started now also arms the ack (Task 3), so both share one
  // `const key = convoKey(ctx)` local instead of each calling convoKey(ctx)
  // inline — see ack-channel-wiring.test.mjs for the ack-specific coverage.
  assert.match(
    code,
    /import\s*{\s*createTypingKeepalive\s*}\s*from\s*["']\.\.\/lib\/typing-keepalive\.core\.mjs["']/,
  );
  assert.match(code, /["']turn\.started["']/);
  assert.match(code, /const\s+key\s*=\s*convoKey\(ctx\)/);
  assert.match(code, /typing\.start\(key,\s*\(\)\s*=>\s*channel\.discord\.startTyping\(\)\)/);
  // Stops on both success paths.
  assert.match(code, /["']turn\.completed["']/);
  assert.match(code, /typing\.stop\(key\)/);
});

test("does NOT override turn.failed / session.failed (keeps Eve's error posts)", () => {
  // Overriding these would clobber Eve's default terminal-error messages, which
  // are not exported for chaining. The keep-alive's own safety cap covers the
  // failure path instead.
  assert.doesNotMatch(code, /["']turn\.failed["']/);
  assert.doesNotMatch(code, /["']session\.failed["']/);
});
