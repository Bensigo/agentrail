// Structural test for the hand-rolled iMessage channel's wiring (#1100).
//
// agent/channels/imessage.ts is a `.ts` Eve channel module — `node --test`
// cannot import it directly (no TS loader is configured for the test run, and
// constructing a real `defineChannel()` would require Eve's runtime context).
// Following this repo's convention (telegram-channel.test.mjs, skills.test.mjs),
// the PURE logic (send-body shaping, inbound parse, constant-time auth) lives in
// and is fully exercised by loopmessage.core.test.mjs; this test only locks the
// WIRING — that the channel authorizes inbound, ACKs fast, defers the turn,
// exposes the run-outcome hand-off, and splits replies — by reading the source
// as text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const imessageTsPath = fileURLToPath(
  new URL("../agent/channels/imessage.ts", import.meta.url),
);
const code = readFileSync(imessageTsPath, "utf8");

test("is a hand-rolled defineChannel tagged with the imessage kindHint", () => {
  assert.match(code, /defineChannel\s*(<[^>]*>)?\s*\(/);
  assert.match(code, /kindHint\s*:\s*["']imessage["']/);
});

test("imports the pure core + the shared chat splitter (no hand-rolled logic)", () => {
  assert.match(
    code,
    /from\s*["']\.\.\/lib\/loopmessage\.core\.mjs["']/,
  );
  assert.match(
    code,
    /import\s*{\s*splitIntoChatMessages\s*}\s*from\s*["']\.\.\/lib\/chat-split\.core\.mjs["']/,
  );
});

test("inbound route verifies the Authorization header and 401s on mismatch", () => {
  assert.match(code, /POST\(\s*["']\/["']/);
  assert.match(code, /verifyWebhookAuthorization\(/);
  assert.match(code, /status:\s*401/);
});

test("inbound route ACKs 200 and defers the model turn under waitUntil", () => {
  // LoopMessage retries any non-2xx (up to 30×), so we must return 200 fast and
  // do the model turn under waitUntil to avoid duplicate replies.
  assert.match(code, /status:\s*200/);
  assert.match(code, /args\.waitUntil\(/);
  assert.match(code, /args\.send\(/);
  // only actionable inbound text drives a turn
  assert.match(code, /isActionableInbound\(/);
});

test("exposes a receive() hand-off with the LOOPMESSAGE_DEFAULT_RECIPIENT fallback", () => {
  // the run-outcome route calls args.receive(imessage, …); the recipient is
  // resolved from the target else the Jace-side default env.
  assert.match(code, /receive\s*\(\s*input\s*,\s*{\s*send\s*}\s*\)/);
  assert.match(code, /LOOPMESSAGE_DEFAULT_RECIPIENT/);
  assert.match(code, /input\.target\?\.handle/);
});

test("outbound send posts to the LoopMessage Send API with the core helpers", () => {
  assert.match(code, /fetch\(\s*LOOPMESSAGE_SEND_URL/);
  assert.match(code, /loopMessageSendHeaders\(/);
  assert.match(code, /buildSendBody\(/);
});

test("overrides message.completed, preserves Eve's default guard, splits bubbles", () => {
  // Same guard as eve's built-in default handler: skip tool-call turns and empty
  // messages so those turns behave unchanged.
  assert.match(code, /events\s*:\s*\{/);
  assert.match(code, /["']message\.completed["']/);
  assert.match(code, /data\.finishReason\s*===\s*["']tool-calls["']/);
  assert.match(code, /!data\.message/);
  assert.match(code, /splitIntoChatMessages\(data\.message\)/);
  assert.match(code, /channel\.imessage\.post\(/);
});

test("does NOT call a typing indicator (LoopMessage has none)", () => {
  // telegram posts channel.telegram.startTyping() between bubbles; imessage must
  // NOT — LoopMessage exposes no typing signal. Assert on the CALL, not the word,
  // so the explanatory comment in the source is allowed to mention it.
  assert.doesNotMatch(code, /\.startTyping\(/);
});
