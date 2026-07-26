// Structural test for the Slack channel's multi-message wiring.
//
// agent/channels/slack.ts is a `.ts` Eve channel module — `node --test`
// cannot import it directly (no TS loader is configured for the test run, and
// constructing a real `slackChannel()` would require Eve's runtime context).
// Following this repo's convention (see telegram-channel.test.mjs), the split
// LOGIC lives in and is fully exercised by chat-split.core.test.mjs; this
// test only locks the WIRING — that the channel's `message.completed`
// override actually calls the pure splitter and preserves Eve's default
// guard — by reading the source as text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const slackTsPath = fileURLToPath(
  new URL("../agent/channels/slack.ts", import.meta.url),
);
const code = readFileSync(slackTsPath, "utf8");

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

test("posts the split messages via the bound thread and pauses typing between them", () => {
  assert.match(code, /splitIntoChatMessages\(data\.message\)/);
  assert.match(code, /channel\.thread\.post\(message\)/);
  assert.match(code, /channel\.thread\.startTyping\(\)/);
});

// --- Important 1: turn.started replaces eve's default handler, not chains
// over it (eve's slackChannel resolves ONE handler per event) — so the
// default's four side effects must be reproduced here or they're silently
// lost. Verified against eve@0.19.0's REAL compiled runtime,
// apps/jace/.output/server/_libs/eve.mjs (defaultEvents' turn.started).

test("turn.started reproduces eve's default: clears pendingToolCallMessage, lastReasoningTypingAtMs, lastReasoningTypingStatus", () => {
  const turnStarted = code.slice(
    code.indexOf('"turn.started"'),
    code.indexOf('"turn.completed"'),
  );
  assert.match(turnStarted, /channel\.state\.pendingToolCallMessage\s*=\s*null/);
  assert.match(turnStarted, /channel\.state\.lastReasoningTypingAtMs\s*=\s*null/);
  assert.match(turnStarted, /channel\.state\.lastReasoningTypingStatus\s*=\s*null/);
});

test("turn.started reproduces eve's default: still calls channel.thread.startTyping(\"Working...\")", () => {
  const turnStarted = code.slice(
    code.indexOf('"turn.started"'),
    code.indexOf('"turn.completed"'),
  );
  assert.match(turnStarted, /channel\.thread\.startTyping\(\s*["']Working\.\.\.["']\s*\)/);
});
