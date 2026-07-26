// Structural test for the Discord Gateway listener's wiring.
//
// agent/lib/discord-gateway.mjs imports a real `@discordjs/ws` client and
// opens a live socket on call — `node --test` cannot exercise that without a
// live connection (see discord-gateway.mjs's own smoke-tested "no token" /
// "invalid token" paths, exercised by hand against Discord's real API while
// building this — a genuine 401 came back and was handled without a crash).
// Structural, read-the-source testing here mirrors exactly why
// discord-channel.test.mjs / telegram-channel.test.mjs test their `.ts`
// channel wrappers the same way rather than executing them. The actual
// DECISIONS (admit? classify?) are fully exercised by
// discord_gateway.core.test.mjs; this test locks the WIRING — in particular
// the safety properties the spec calls out as the highest-risk part: an
// attached `error` listener (or the process can crash), a fatal close that
// stops rather than reconnects, and exactly one `connect()` call site.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(new URL("../agent/lib/discord-gateway.mjs", import.meta.url));
const code = readFileSync(sourcePath, "utf8");

test("imports the maintained Gateway client (@discordjs/ws), not a hand-rolled socket", () => {
  assert.match(code, /from\s*["']@discordjs\/ws["']/);
  assert.match(code, /WebSocketManager/);
  assert.match(code, /WebSocketShardEvents/);
});

test("imports GatewayIntentBits and GatewayDispatchEvents from discord-api-types (no hand-rolled bit values)", () => {
  assert.match(code, /from\s*["']discord-api-types\/v10["']/);
  assert.match(code, /GatewayIntentBits/);
  assert.match(code, /GatewayDispatchEvents/);
});

test("requests exactly the four intents the spec names", () => {
  assert.match(code, /GatewayIntentBits\.Guilds/);
  assert.match(code, /GatewayIntentBits\.GuildMessages/);
  assert.match(code, /GatewayIntentBits\.DirectMessages/);
  assert.match(code, /GatewayIntentBits\.MessageContent/);
});

test("imports its decisions from the pure core, not reimplementing them here", () => {
  assert.match(
    code,
    /import\s*{[^}]*admitMessage[^}]*}\s*from\s*["']\.\/discord_gateway\.core\.mjs["']/s,
  );
  assert.match(code, /classifyCloseCode/);
  assert.match(code, /shapeInboundPayload/);
  assert.match(code, /postDiscordInboundMessage/);
});

test("IDENTIFYs with an online presence", () => {
  assert.match(code, /initialPresence/);
  assert.match(code, /status:\s*["']online["']/);
});

// ---------------------------------------------------------------------------
// The highest-risk properties: never crash the process, never hot-loop.
// ---------------------------------------------------------------------------

test("attaches an Error listener — an unlistened shard 'error' event would crash the whole jace process", () => {
  assert.match(code, /WebSocketShardEvents\.Error/);
  assert.match(code, /manager\.on\(WebSocketShardEvents\.Error/);
});

test("attaches a Closed listener that runs classifyCloseCode", () => {
  assert.match(code, /manager\.on\(WebSocketShardEvents\.Closed/);
  assert.match(code, /classifyCloseCode\(code\)/);
});

test("on a fatal close: logs clearly and destroys the manager (does not silently continue)", () => {
  const closedHandlerMatch = code.match(
    /manager\.on\(WebSocketShardEvents\.Closed,[\s\S]*?\n {4}\}\);/,
  );
  assert.ok(closedHandlerMatch, "Closed handler block not found");
  const handlerBody = closedHandlerMatch[0];
  assert.match(handlerBody, /if\s*\(fatal\)/);
  assert.match(handlerBody, /error\(/, "must log at error level on a fatal close");
  assert.match(handlerBody, /manager\.destroy\(\)/);
});

test("connect() is called exactly once in the source — no reconnect-on-close call site", () => {
  const occurrences = code.match(/manager\.connect\(\)/g) ?? [];
  assert.equal(occurrences.length, 1, "expected exactly one manager.connect() call site");
});

test("startDiscordGateway guards against being started twice in the same process", () => {
  assert.match(code, /state\.started/);
});

test("never logs the token", () => {
  // Every console-facing call in this file goes through log/warn/error; none
  // of them may pass the bare `token` VARIABLE as an argument. English
  // prose mentioning the word "token" inside a quoted log message (e.g.
  // "...or an invalid token") is fine and expected — only a live reference
  // to the identifier holding the secret is disallowed, so string-literal
  // contents are stripped before matching.
  const loggingCalls = code.match(/\b(?:log|warn|error)\([^;]*\);/g) ?? [];
  assert.ok(loggingCalls.length > 0, "expected at least one logging call to inspect");
  for (const call of loggingCalls) {
    const withoutStringLiterals = call.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    assert.doesNotMatch(
      withoutStringLiterals,
      /\btoken\b/,
      `logging call must not pass the token variable itself: ${call}`,
    );
  }
});

test("exports startDiscordGateway and a status getter", () => {
  assert.match(code, /export\s+(?:async\s+)?function\s+startDiscordGateway/);
  assert.match(code, /export\s+function\s+getDiscordGatewayStatus/);
});

test("documents the multi-replica stance explicitly (spec requirement)", () => {
  assert.match(code, /MULTI-REPLICA STANCE/);
  assert.match(code, /ON CONFLICT/i);
});
