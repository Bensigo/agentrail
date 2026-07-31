// Structural test for the Slack channel's zero-Slack-I/O wiring.
//
// agent/channels/slack.ts is a `.ts` Eve channel module — `node --test`
// cannot import it directly (no TS loader is configured for the test run, and
// constructing a real `slackChannel()` would require Eve's runtime context).
// Following this repo's convention (see telegram-channel.test.mjs /
// discord-gateway-wiring.test.mjs), the split LOGIC lives in and is fully
// exercised by chat-split.core.test.mjs; this test only locks the WIRING —
// by reading the source as text.
//
// Every assertion below (other than the two that explicitly want the raw
// header prose) runs against `codeNoComments`, not `code` — this file's
// header/inline comments deliberately quote things like `"turn.failed"` and
// `channel.thread.post(...)` in backticks while EXPLAINING eve's defaults,
// which would otherwise false-positive/false-negative naive substring
// matching against the real declarations below them. Stripping full-line
// `//` comments first (every comment in slack.ts is its own line — verified
// by inspection) keeps the structural checks anchored to actual code.
//
// The companion invariant that every eve Slack default event is declared
// here (so an un-overridden default can never silently reintroduce a Slack
// API call) lives in slack-defaults-coverage.test.mjs, not this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const slackTsPath = fileURLToPath(
  new URL("../agent/channels/slack.ts", import.meta.url),
);
const code = readFileSync(slackTsPath, "utf8");
const codeNoComments = code
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

/** Slice out one `events` handler's body by its declared key (matched
 * against the comment-stripped source), from the key's opening quote up to
 * the next declared handler's opening quote, or end of file. */
function handlerBody(key, nextKey) {
  const start = codeNoComments.indexOf(`"${key}"`);
  assert.ok(start !== -1, `"${key}" handler not found in agent/channels/slack.ts`);
  const end = nextKey ? codeNoComments.indexOf(`"${nextKey}"`, start) : codeNoComments.length;
  assert.ok(end !== -1 && end > start, `could not bound "${key}" handler body`);
  return codeNoComments.slice(start, end);
}

test("imports the pure splitter from agent/lib", () => {
  assert.match(
    codeNoComments,
    /import\s*{\s*splitIntoChatMessages\s*}\s*from\s*["']\.\.\/lib\/chat-split\.core\.mjs["']/,
  );
});

// Task 4 (docs/superpowers/specs/2026-07-29-slack-multi-workspace-design.md
// §4): the reply no longer posts through eve's own bound channel — it hands
// back to the console, which resolves the right customer's bot token.
test("imports postSlackReply and resolveSlackReplyTeamId from agent/lib", () => {
  assert.match(
    codeNoComments,
    /import\s*{\s*postSlackReply\s*,\s*resolveSlackReplyTeamId\s*}\s*from\s*["']\.\.\/lib\/slack_reply\.core\.mjs["']/,
  );
});

test("never calls channel.thread.startTyping anywhere in real code", () => {
  // The prod outage's root fix: no typing indicator is worth a guaranteed-
  // to-fail Slack API attempt with no bot token configured (see the file's
  // header comment on why "startTyping swallows its errors" was true but
  // insufficient reasoning).
  assert.doesNotMatch(codeNoComments, /\.startTyping\(/);
});

test("never calls channel.thread.post or channel.slack.request anywhere in real code", () => {
  // The reply goes through postSlackReply -> the console, never eve's own
  // bound Slack client.
  assert.doesNotMatch(codeNoComments, /channel\.thread\.post\(/);
  assert.doesNotMatch(codeNoComments, /channel\.slack\.request\(/);
});

test("overrides message.completed and preserves Eve's default guard", () => {
  assert.match(codeNoComments, /events\s*:\s*\{/);
  const body = handlerBody("message.completed", "turn.failed");
  assert.match(body, /data\.finishReason\s*===\s*["']tool-calls["']/);
  assert.match(body, /!data\.message/);
});

test("posts the split messages via postSlackReply, never channel.thread.post, with no between-bubble typing", () => {
  const body = handlerBody("message.completed", "turn.failed");
  assert.match(body, /splitIntoChatMessages\(data\.message\)/);
  assert.match(body, /await\s+postSlackReply\(/);
  assert.doesNotMatch(body, /channel\.thread\.post\(/);
  assert.doesNotMatch(body, /startTyping/);
});

// Task 4: the team id is read from ctx.session.auth (never channel.state,
// which eve hardcodes to teamId: null for every proactive/hosted-inbound
// session — see this file's own header comment on why), and the
// destination (channelId/threadTs) still comes from channel.state, which IS
// reliable.
test("message.completed resolves teamId from ctx.session.auth and channelId/threadTs from channel.state", () => {
  const body = handlerBody("message.completed", "turn.failed");
  assert.match(body, /resolveSlackReplyTeamId\(ctx\?\.session\?\.auth\)/);
  assert.match(body, /channelId:\s*channel\.state\.channelId/);
  assert.match(body, /threadTs:\s*channel\.state\.threadTs/);
});

test("turn.started is a no-op (no startTyping, no leftover state resets from eve's default)", () => {
  const body = handlerBody("turn.started", "reasoning.appended");
  assert.doesNotMatch(body, /channel\.state\.pendingToolCallMessage/);
  assert.doesNotMatch(body, /startTyping/);
});

test("reasoning.appended and actions.requested are no-ops", () => {
  const reasoning = handlerBody("reasoning.appended", "actions.requested");
  const actions = handlerBody("actions.requested", "message.completed");
  assert.doesNotMatch(reasoning, /startTyping/);
  assert.doesNotMatch(actions, /startTyping/);
});

test("turn.failed routes the failure notice through postSlackReply, wrapped in its own try/catch", () => {
  const body = handlerBody("turn.failed", "session.failed");
  assert.match(body, /resolveSlackReplyTeamId\(ctx\?\.session\?\.auth\)/);
  assert.match(body, /await\s+postSlackReply\(/);
  assert.match(body, /try\s*\{/);
  assert.match(body, /catch\s*\(err\)/);
  assert.doesNotMatch(body, /channel\.thread\.post\(/);
});

test("session.failed is a documented no-op (no ctx available to resolve a team id safely)", () => {
  const body = handlerBody("session.failed", "authorization.required");
  assert.doesNotMatch(body, /postSlackReply/);
  assert.doesNotMatch(body, /channel\.thread\.post\(/);
});

test("authorization.required and authorization.completed are no-ops", () => {
  const required = handlerBody("authorization.required", "authorization.completed");
  const completed = handlerBody("authorization.completed", "input.requested");
  assert.doesNotMatch(required, /postEphemeral|postDirectMessage/);
  assert.doesNotMatch(completed, /slack\.request/);
});

test("input.requested is declared (overrides eve's separately-exported defaultInputRequestedHandler)", () => {
  assert.match(codeNoComments, /["']input\.requested["']\s*:\s*async/);
});

test("documents the zero-Slack-I/O invariant and the one-handler-per-event trap at the top of the file", () => {
  const header = code.slice(0, code.indexOf("import"));
  assert.match(header, /ZERO SLACK API CALLS/);
  assert.match(header, /resolves exactly ONE handler per event/);
  assert.match(header, /events\[name\]/);
  assert.match(header, /defaultEvents/);
  assert.match(header, /\[name\]/);
});
