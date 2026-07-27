// Structural test for the work-acknowledgement wiring across channels.
//
// agent/channels/*.ts are Eve channel modules — `node --test` cannot import
// them directly (no TS loader is configured for the test run, and constructing
// a real channel would need Eve's runtime context). Following this repo's
// convention (see discord-channel.test.mjs), ALL the real logic lives in and is
// fully exercised by ack-on-work.core.test.mjs; this test locks only the
// WIRING — that each channel arms the ack from actions.requested, disarms it on
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

// slack.ts is deliberately NOT here: it is the one ack-less channel, because
// eve's own default `actions.requested` already sets a native thread typing
// status naming the running tools, and eve resolves ONE handler per event on
// slack (declaring ours would replace that default, and its text runs through
// helpers eve does not re-export). See slack.ts's header comment, and the
// explicit assertions at the bottom of this file that lock that decision in.
const CHANNELS = ["telegram.ts", "discord.ts", "console.ts"];

// The ack key argument is asserted, not just the call: asserting only
// `/ack\.arm\(/` is argument-blind, and swapping `ack.arm(convoKey(ctx), ...)`
// for e.g. `ack.arm("slack", ...)` would keep this suite green while collapsing
// every concurrent conversation onto one ack.
const ARM_KEY_PATTERN = /ack\.arm\(\s*convoKey\(ctx\)\s*,\s*data\.turnId\s*,/;
const STOP_KEY_PATTERN = {
  "telegram.ts": /ack\.stop\(\s*key\s*\)/,
  "discord.ts": /ack\.stop\(\s*key\s*\)/,
  "console.ts": /ack\.stop\(\s*convoKey\(ctx\)\s*\)/,
};

for (const name of CHANNELS) {
  test(`${name}: imports the ack module (createAckOnWork, workPhraseFor, isProactiveTurn) and instantiates it`, () => {
    const code = read(name);
    const importMatch = code.match(
      /import\s*\{([^}]*)\}\s*from\s*["']\.\.\/lib\/ack-on-work\.core\.mjs["']/,
    );
    assert.ok(importMatch, `${name}: must import from ack-on-work.core.mjs`);
    assert.match(importMatch[1], /createAckOnWork/);
    assert.match(importMatch[1], /workPhraseFor/);
    assert.match(importMatch[1], /isProactiveTurn/);
    assert.match(code, /const\s+ack\s*=\s*createAckOnWork\(/);
  });

  test(`${name}: arms the ack from actions.requested, NOT from turn.started`, () => {
    // The whole point of the change. Arming from turn.started fires on every
    // turn — including a turn whose entire output is a clarifying question,
    // where an "on it" is not merely noise but false.
    const code = read(name);
    const turnStarted = code.slice(
      code.indexOf('"turn.started"'),
      code.indexOf('"actions.requested"'),
    );
    assert.doesNotMatch(
      turnStarted,
      /ack\.arm\(/,
      `${name}: turn.started must NOT arm the ack`,
    );

    const actionsRequested = code.slice(
      code.indexOf('"actions.requested"'),
      code.indexOf('"turn.completed"'),
    );
    assert.match(actionsRequested, ARM_KEY_PATTERN);
  });

  test(`${name}: derives its copy from the payload, never a fixed string`, () => {
    const code = read(name);
    const actionsRequested = code.slice(
      code.indexOf('"actions.requested"'),
      code.indexOf('"turn.completed"'),
    );
    // The phrase must come from workPhraseFor(data.actions) — a hardcoded
    // literal here would reintroduce the "On it." that fired on every turn.
    assert.match(actionsRequested, /workPhraseFor\(\s*data\.actions\s*\)/);
    assert.doesNotMatch(actionsRequested, /["']On it/);
  });

  test(`${name}: stays silent when the payload yields no phrase`, () => {
    // A load-skill-only or smalltalk-only batch must not arm a timer at all.
    const code = read(name);
    const actionsRequested = code.slice(
      code.indexOf('"actions.requested"'),
      code.indexOf('"turn.completed"'),
    );
    const guard = actionsRequested.search(/if\s*\(\s*!phrase\s*\)\s*return/);
    const arm = actionsRequested.search(ARM_KEY_PATTERN);
    assert.ok(guard !== -1, `${name}: must bail out when workPhraseFor returns null`);
    assert.ok(guard < arm, `${name}: the empty-phrase guard must precede ack.arm`);
  });

  test(`${name}: consults isProactiveTurn BEFORE arming`, () => {
    // run-outcome.ts's Jace-initiated hand-offs (terminal run outcome /
    // goal-loop message) mark their forwarded auth with
    // JACE_PROACTIVE_ATTRIBUTE. Those turns CALL TOOLS too, so actions.requested
    // does not filter them out by itself — the guard is still load-bearing, and
    // there is no human message behind them to acknowledge.
    const code = read(name);
    const actionsRequested = code.slice(
      code.indexOf('"actions.requested"'),
      code.indexOf('"turn.completed"'),
    );
    const guardIdx = actionsRequested.indexOf("isProactiveTurn(");
    const armIdx = actionsRequested.search(ARM_KEY_PATTERN);
    assert.ok(guardIdx !== -1, `${name}: actions.requested must consult isProactiveTurn`);
    assert.ok(
      guardIdx < armIdx,
      `${name}: isProactiveTurn must be consulted BEFORE ack.arm arms the ack`,
    );
  });

  test(`${name}: disarms the ack in turn.completed`, () => {
    const code = read(name);
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
}

// This non-override is load-bearing on EVERY channel including slack
// (overriding would clobber eve's own error message and drop its error id —
// see each channel's own header comment / the ack module's header comment).
for (const name of [...CHANNELS, "slack.ts"]) {
  test(`${name}: does NOT override turn.failed / session.failed (keeps Eve's error posts)`, () => {
    const code = read(name);
    assert.doesNotMatch(code, /["']turn\.failed["']/);
    assert.doesNotMatch(code, /["']session\.failed["']/);
  });
}

test("telegram + discord: typing.stop also sits below the tool-calls guard", () => {
  for (const name of ["telegram.ts", "discord.ts"]) {
    const body = read(name).slice(read(name).indexOf('"message.completed"'));
    const guard = body.indexOf('finishReason === "tool-calls"');
    const stop = body.indexOf("typing.stop(");
    assert.ok(stop > guard, `${name}: typing.stop must come AFTER the guard`);
  }
});

test("telegram: the ack posts via channel.telegram.post", () => {
  const code = read("telegram.ts");
  const actionsRequested = code.slice(
    code.indexOf('"actions.requested"'),
    code.indexOf('"turn.completed"'),
  );
  assert.match(actionsRequested, /channel\.telegram\.post\(\s*phrase\s*\)/);
});

test("discord: the ack is delivered via deliverDiscordBubble, not a bare channel.post", () => {
  const code = read("discord.ts");
  const actionsRequested = code.slice(
    code.indexOf('"actions.requested"'),
    code.indexOf('"turn.completed"'),
  );

  // The ack is a reply like any other, so it MUST take the interaction
  // followup path. channel.discord.post() alone needs View Channel + Send
  // Messages on this specific channel and dies with a swallowed 50001 in
  // private channels — that was the production bug fixed in #1463.
  assert.match(actionsRequested, /deliverDiscordBubble\(/);
  assert.match(actionsRequested, /content:\s*phrase/);
  assert.match(actionsRequested, /attributes:\s*resolveSessionAuthAttributes\(/);
  assert.match(actionsRequested, /postFollowup:\s*followupTransport/);
  // channel.discord.post may appear ONLY as the postViaBot fallback.
  assert.match(actionsRequested, /postViaBot:\s*\(\)\s*=>\s*channel\.discord\.post\(/);
});

test("discord: imports deliverDiscordBubble alongside deliverDiscordReply", () => {
  const code = read("discord.ts");
  assert.match(
    code,
    /import\s*{[^}]*deliverDiscordBubble[^}]*deliverDiscordReply[^}]*}\s*from\s*["']\.\.\/lib\/discord-followup\.core\.mjs["']|import\s*{[^}]*deliverDiscordReply[^}]*deliverDiscordBubble[^}]*}\s*from\s*["']\.\.\/lib\/discord-followup\.core\.mjs["']/,
  );
});

test("console: the ack posts through postConsoleChatReply, not a raw transport call", () => {
  const code = read("console.ts");
  const actionsRequested = code.slice(
    code.indexOf('"actions.requested"'),
    code.indexOf('"turn.completed"'),
  );
  assert.match(actionsRequested, /postConsoleChatReply\(/);
  assert.match(actionsRequested, /text:\s*phrase/);
  assert.match(actionsRequested, /workspaceId:\s*channel\.state\.workspaceId/);
  assert.match(actionsRequested, /conversationKey:\s*channel\.state\.conversationKey/);
});

// --- slack: the deliberate exception ------------------------------------

test("slack: declares NO actions.requested handler, leaving eve's native tool status intact", () => {
  // eve resolves one handler per event on slack (`events[e] ?? defaultEvents[e]`),
  // so declaring this would REPLACE a default that already sets the thread
  // typing status to `Running <toolName>...` — the same information our ack
  // carries, shown live and per-step without cluttering the thread. Reproducing
  // it would mean copying `truncateTypingStatus`/`stripTypingStatusMarkdown`
  // out of eve's #public/channels/slack/limits.js, which it does not re-export.
  const code = read("slack.ts");
  assert.doesNotMatch(code, /["']actions\.requested["']/);
});

test("slack: carries no ack wiring at all", () => {
  // Matched against imports and calls only, not the whole file: slack.ts's
  // header comment names ack-on-work.core.mjs to explain WHY it opts out, and
  // that explanation is the thing most worth keeping.
  const code = read("slack.ts");
  assert.doesNotMatch(code, /^\s*import[^;]*ack-on-work\.core\.mjs/m);
  assert.doesNotMatch(code, /createAckOnWork\(/);
  assert.doesNotMatch(code, /ack\.(arm|stop)\(/);
});

test("slack: still reproduces eve's default turn.started, which it DOES override", () => {
  // Unchanged by this work, and independently load-bearing: losing the state
  // clears makes reasoning.appended wrongly suppress the first status of a new
  // turn. See slack.ts's header comment.
  const code = read("slack.ts");
  const turnStarted = code.slice(code.indexOf('"turn.started"'));
  assert.match(turnStarted, /channel\.state\.pendingToolCallMessage\s*=\s*null/);
  assert.match(turnStarted, /channel\.state\.lastReasoningTypingAtMs\s*=\s*null/);
  assert.match(turnStarted, /channel\.state\.lastReasoningTypingStatus\s*=\s*null/);
  assert.match(turnStarted, /startTyping\(\s*["']Working\.\.\.["']\s*\)/);
});
