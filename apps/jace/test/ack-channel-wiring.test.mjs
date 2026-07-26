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

for (const name of CHANNELS) {
  test(`${name}: imports the ack module and instantiates it`, () => {
    const code = read(name);
    assert.match(
      code,
      /import\s*{[^}]*createAckOnSilence[^}]*ACK_TEXT[^}]*}\s*from\s*["']\.\.\/lib\/ack-on-silence\.core\.mjs["']/,
    );
    assert.match(code, /const\s+ack\s*=\s*createAckOnSilence\(/);
  });

  test(`${name}: arms the ack in turn.started and disarms it in turn.completed`, () => {
    const code = read(name);
    const turnStarted = code.slice(code.indexOf('"turn.started"'));
    assert.match(turnStarted.slice(0, 400), /ack\.start\(/);
    const turnCompleted = code.slice(code.indexOf('"turn.completed"'));
    assert.match(turnCompleted.slice(0, 300), /ack\.stop\(/);
  });

  test(`${name}: stops the ack BELOW the tool-calls guard, not above it`, () => {
    // A `tool-calls` message.completed fires mid-turn while the turn keeps
    // working. Stopping above the guard would suppress the ack on exactly the
    // slow, tool-calling turns that most need it.
    const code = read(name);
    const body = code.slice(code.indexOf('"message.completed"'));
    const guard = body.indexOf('finishReason === "tool-calls"');
    const stop = body.indexOf("ack.stop(");
    assert.ok(guard !== -1, "message.completed must keep eve's default guard");
    assert.ok(stop !== -1, "message.completed must stop the ack");
    assert.ok(stop > guard, "ack.stop must come AFTER the tool-calls guard");
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
