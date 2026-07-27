// Structural test for the Telegram channel's multi-message wiring.
//
// agent/channels/telegram.ts is a `.ts` Eve channel module — `node --test`
// cannot import it directly (no TS loader is configured for the test run, and
// constructing a real `telegramChannel()` would require Eve's runtime
// context). Following this repo's convention (skills.test.mjs,
// reporting-skills.test.mjs, qa-no-shell-string.test.mjs), the split LOGIC
// lives in and is fully exercised by chat-split.core.test.mjs; this test only
// locks the WIRING — that the channel's `message.completed` override actually
// calls the pure splitter and preserves Eve's default guard — by reading the
// source as text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const telegramTsPath = fileURLToPath(
  new URL("../agent/channels/telegram.ts", import.meta.url),
);
const code = readFileSync(telegramTsPath, "utf8");

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
  assert.match(code, /channel\.telegram\.post\(message\)/);
  assert.match(code, /channel\.telegram\.startTyping\(\)/);
});

test("wires the typing keep-alive: start on turn.started, stop on turn end", () => {
  // The keep-alive LOGIC is fully exercised by typing-keepalive.core.test.mjs;
  // this locks that the channel actually drives it on the right events —
  // benefits both the turn.started and message.completed paths equally.
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
  assert.match(code, /typing\.start\(key,\s*\(\)\s*=>\s*channel\.telegram\.startTyping\(\)\)/);
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
