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

// --- Task 8: Telegram inbound shim (JACE_TELEGRAM_FORWARD_TO_CONSOLE) -------
//
// apps/jace/agent/channels/telegram.ts stops handling turns on the way in
// once the flag is truthy — see
// docs/superpowers/specs/2026-07-27-jace-connect-command-design.md ("Part 2 —
// Telegram transport shim") and .superpowers/sdd/task-8-brief.md. Off
// (unset/falsy) must be today's behaviour byte-for-byte: no `onMessage`
// override at all, so eve's own default inbound dispatch — the thing that
// starts a turn from a raw webhook update — is completely untouched. On: an
// `onMessage` override forwards the raw update to the console via
// `forwardTelegramInbound` and returns `null` (eve's documented "drop this
// message" signal, see eve/channels/{slack,teams}'s own onMessage docs), so
// no turn is ever started on this door while the flag is on.

test("references JACE_TELEGRAM_FORWARD_TO_CONSOLE", () => {
  assert.match(code, /JACE_TELEGRAM_FORWARD_TO_CONSOLE/);
});

test("imports forwardTelegramInbound from the pure forward core (Task 7)", () => {
  assert.match(
    code,
    /import\s*{\s*forwardTelegramInbound\s*}\s*from\s*["']\.\.\/lib\/telegram_forward\.core\.mjs["']/,
  );
});

test("gates onMessage on the flag: no override at all when off, so eve's default inbound dispatch is byte-for-byte unchanged", () => {
  // Deliberately NOT `onMessage(ctx, message) { if (flag) {...} }` — a
  // handler that's always REGISTERED but conditionally no-ops would still
  // replace eve's own default admission/turn-start logic even when the flag
  // is off, which is exactly the "byte-for-byte unchanged" guarantee the
  // brief requires. `onMessage: forwardToConsole ? onMessage : undefined`
  // means the key is functionally absent (same as never having been passed)
  // whenever the flag is off.
  assert.match(
    code,
    /onMessage\s*:\s*forwardToConsole\s*\?\s*onMessage\s*:\s*undefined/,
  );
});

test("the flag-on onMessage handler calls forwardTelegramInbound and returns null (never starts a turn)", () => {
  const start = code.indexOf("function onMessage");
  assert.ok(start !== -1, "must define an onMessage handler function");
  const defaultIdx = code.indexOf("export default telegramChannel");
  assert.ok(defaultIdx !== -1 && defaultIdx > start, "onMessage must be defined before the channel export");
  const body = code.slice(start, defaultIdx);
  assert.match(body, /forwardTelegramInbound\(/);
  assert.match(body, /return\s+null/);
});

test("outbound handlers stay exactly as they were: message.completed still chat-splits, turn.started still keeps typing alive", () => {
  // Re-asserts (alongside the tests above and ack-channel-wiring.test.mjs's
  // shared coverage) the brief's own "Do not touch any outbound handler"
  // constraint for this specific task's diff.
  assert.match(code, /splitIntoChatMessages\(data\.message\)/);
  assert.match(code, /channel\.telegram\.post\(message\)/);
  assert.match(
    code,
    /typing\.start\(key,\s*\(\)\s*=>\s*channel\.telegram\.startTyping\(\)\)/,
  );
  assert.match(code, /["']turn\.completed["']/);
});
