// Structural test for the slow-turn acknowledgement wiring across channels.
//
// agent/channels/*.ts are Eve channel modules — `node --test` cannot import
// them directly (no TS loader is configured for the test run, and constructing
// a real channel would need Eve's runtime context). Following this repo's
// convention (see discord-channel.test.mjs), ALL the real logic lives in and is
// fully exercised by ack-on-silence.core.test.mjs; this test locks only the
// WIRING — that each channel arms the ack on turn.started, disarms it on
// turn.completed, and places its stops BELOW the tool-calls guard — by reading
// the source as text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name) =>
  readFileSync(
    fileURLToPath(new URL(`../agent/channels/${name}`, import.meta.url)),
    "utf8",
  );

const CHANNELS = ["telegram.ts", "discord.ts", "slack.ts", "console.ts"];

// Minor 3 fix: slack/console key the ack by `convoKey(ctx)` directly;
// telegram/discord instead hoist that into a local `key` (shared with the
// typing keep-alive) and pass `key`. Asserting only `/ack\.start\(/` /
// `/ack\.stop\(/` (as this file used to) is argument-blind: swapping
// `ack.stop(convoKey(ctx))` for e.g. `ack.stop("slack")` would keep every
// test here green while making every turn on that channel post "On it."
// even on an instant reply — exactly the regression this suite exists to
// prevent. These per-channel patterns assert the actual key argument too.
const START_KEY_PATTERN = {
  "telegram.ts": /ack\.start\(\s*key\s*,/,
  "discord.ts": /ack\.start\(\s*key\s*,/,
  "slack.ts": /ack\.start\(\s*convoKey\(ctx\)/,
  "console.ts": /ack\.start\(\s*convoKey\(ctx\)/,
};
const STOP_KEY_PATTERN = {
  "telegram.ts": /ack\.stop\(\s*key\s*\)/,
  "discord.ts": /ack\.stop\(\s*key\s*\)/,
  "slack.ts": /ack\.stop\(\s*convoKey\(ctx\)\s*\)/,
  "console.ts": /ack\.stop\(\s*convoKey\(ctx\)\s*\)/,
};

for (const name of CHANNELS) {
  test(`${name}: imports the ack module (createAckOnSilence, ACK_TEXT, isProactiveTurn) and instantiates it`, () => {
    const code = read(name);
    const importMatch = code.match(
      /import\s*\{([^}]*)\}\s*from\s*["']\.\.\/lib\/ack-on-silence\.core\.mjs["']/,
    );
    assert.ok(importMatch, `${name}: must import from ack-on-silence.core.mjs`);
    assert.match(importMatch[1], /createAckOnSilence/);
    assert.match(importMatch[1], /ACK_TEXT/);
    assert.match(importMatch[1], /isProactiveTurn/);
    assert.match(code, /const\s+ack\s*=\s*createAckOnSilence\(/);
  });

  // Bounded slices, not a fixed-width scan (Minor 4 fix). A fixed
  // `code.slice(idx, idx + N)` window is brittle to unrelated edits growing
  // the handler body past N chars (measured headroom before this fix: 284
  // used out of 400 for telegram, 309 of 400 for discord) — a comment line
  // added anywhere in the window trips a misleading "does not arm the ack"
  // failure. Bounding by the NEXT handler's key (as the tool-calls-guard
  // test below already does) has no such ceiling.
  test(`${name}: arms the ack in turn.started (skipping a Jace-initiated turn) and disarms it in turn.completed`, () => {
    const code = read(name);
    const turnStarted = code.slice(
      code.indexOf('"turn.started"'),
      code.indexOf('"turn.completed"'),
    );
    assert.match(turnStarted, START_KEY_PATTERN[name]);
    // Important 2: run-outcome.ts's Jace-initiated hand-offs (terminal run
    // outcome / goal-loop message) mark their forwarded auth with
    // JACE_PROACTIVE_ATTRIBUTE; every channel must consult isProactiveTurn
    // BEFORE arming the ack so that mark suppresses it — composing that
    // reply is a full model turn that routinely exceeds the ack window, and
    // there's no human message behind it to acknowledge.
    const guardIdx = turnStarted.indexOf("isProactiveTurn(");
    const armIdx = turnStarted.search(START_KEY_PATTERN[name]);
    assert.ok(guardIdx !== -1, `${name}: turn.started must consult isProactiveTurn`);
    assert.ok(
      guardIdx < armIdx,
      `${name}: isProactiveTurn must be consulted BEFORE ack.start arms the ack`,
    );

    const turnCompleted = code.slice(
      code.indexOf('"turn.completed"'),
      code.indexOf('"message.completed"'),
    );
    assert.match(turnCompleted, STOP_KEY_PATTERN[name]);
  });

  test(`${name}: stops the ack BELOW the tool-calls guard, not above it`, () => {
    // A `tool-calls` message.completed fires mid-turn while the turn keeps
    // working. Stopping above the guard would suppress the ack on exactly the
    // slow, tool-calling turns that most need it.
    const code = read(name);
    const body = code.slice(code.indexOf('"message.completed"'));
    const guard = body.indexOf('finishReason === "tool-calls"');
    const stop = body.search(STOP_KEY_PATTERN[name]);
    assert.ok(guard !== -1, "message.completed must keep eve's default guard");
    assert.ok(stop !== -1, "message.completed must stop the ack");
    assert.ok(stop > guard, "ack.stop must come AFTER the tool-calls guard");
  });

  // Minor 7: this non-override is load-bearing (overriding would clobber
  // eve's own error message and drop its error id — see each channel's own
  // header comment / the ack module's header comment for the rationale).
  // discord-channel.test.mjs and telegram-channel.test.mjs already asserted
  // this individually; folded into the shared four-channel loop here so
  // slack.ts and console.ts are covered too.
  test(`${name}: does NOT override turn.failed / session.failed (keeps Eve's error posts)`, () => {
    const code = read(name);
    assert.doesNotMatch(code, /["']turn\.failed["']/);
    assert.doesNotMatch(code, /["']session\.failed["']/);
  });
}

test("telegram + discord: typing.stop also moved below the tool-calls guard", () => {
  for (const name of ["telegram.ts", "discord.ts"]) {
    const body = read(name).slice(read(name).indexOf('"message.completed"'));
    const guard = body.indexOf('finishReason === "tool-calls"');
    const stop = body.indexOf("typing.stop(");
    assert.ok(stop > guard, `${name}: typing.stop must come AFTER the guard`);
  }
});

test("telegram: the ack posts via channel.telegram.post", () => {
  const code = read("telegram.ts");
  const turnStarted = code.slice(code.indexOf('"turn.started"'), code.indexOf('"turn.completed"'));
  assert.match(turnStarted, /channel\.telegram\.post\(\s*ACK_TEXT\s*\)/);
});

test("discord: the ack is delivered via deliverDiscordBubble, not a bare channel.post", () => {
  const code = read("discord.ts");
  const turnStarted = code.slice(
    code.indexOf('"turn.started"'),
    code.indexOf('"turn.completed"'),
  );

  // The ack is a reply like any other, so it MUST take the interaction
  // followup path. channel.discord.post() alone needs View Channel + Send
  // Messages on this specific channel and dies with a swallowed 50001 in
  // private channels — that was the production bug fixed in #1463.
  assert.match(turnStarted, /deliverDiscordBubble\(/);
  assert.match(turnStarted, /content:\s*ACK_TEXT/);
  assert.match(turnStarted, /attributes:\s*resolveSessionAuthAttributes\(/);
  assert.match(turnStarted, /postFollowup:\s*followupTransport/);
  // channel.discord.post may appear ONLY as the postViaBot fallback.
  assert.match(turnStarted, /postViaBot:\s*\(\)\s*=>\s*channel\.discord\.post\(/);
});

test("discord: imports deliverDiscordBubble alongside deliverDiscordReply", () => {
  const code = read("discord.ts");
  assert.match(
    code,
    /import\s*{[^}]*deliverDiscordBubble[^}]*deliverDiscordReply[^}]*}\s*from\s*["']\.\.\/lib\/discord-followup\.core\.mjs["']|import\s*{[^}]*deliverDiscordReply[^}]*deliverDiscordBubble[^}]*}\s*from\s*["']\.\.\/lib\/discord-followup\.core\.mjs["']/,
  );
});

test("slack: the ack posts to the thread seam", () => {
  const code = read("slack.ts");
  const turnStarted = code.slice(
    code.indexOf('"turn.started"'),
    code.indexOf('"turn.completed"'),
  );
  assert.match(turnStarted, /channel\.thread\.post\(\s*ACK_TEXT\s*\)/);
});

test("console: the ack posts through postConsoleChatReply, not a raw transport call", () => {
  const code = read("console.ts");
  const turnStarted = code.slice(
    code.indexOf('"turn.started"'),
    code.indexOf('"turn.completed"'),
  );
  assert.match(turnStarted, /postConsoleChatReply\(/);
  assert.match(turnStarted, /text:\s*ACK_TEXT/);
  assert.match(turnStarted, /workspaceId:\s*channel\.state\.workspaceId/);
  assert.match(turnStarted, /conversationKey:\s*channel\.state\.conversationKey/);
});
