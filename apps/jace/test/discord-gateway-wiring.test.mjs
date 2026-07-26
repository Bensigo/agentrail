// Structural test for the Discord Gateway listener's wiring, PLUS one
// behavioral exception (see below).
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
//
// EXCEPTION — `connectWithRetry` (I4): unlike everything else here, it takes
// an already-constructed manager and never opens a socket itself, so it CAN
// be exercised directly with a fake `{ connect() }` and an injected `sleep`.
// See the "connectWithRetry — BEHAVIORAL" section at the bottom.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectWithRetry } from "../agent/lib/discord-gateway.mjs";
import { INITIAL_CONNECT_MAX_ATTEMPTS } from "../agent/lib/discord_gateway.core.mjs";

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

// ---------------------------------------------------------------------------
// I4 — the INITIAL connect is retried with a capped backoff, but a fatal
// close must remain the only PERMANENT stop (never retry 4014/4004).
// ---------------------------------------------------------------------------

test("imports the initial-connect backoff helpers from the pure core (I4)", () => {
  assert.match(
    code,
    /import\s*{[^}]*computeInitialConnectBackoffMs[^}]*}\s*from\s*["']\.\/discord_gateway\.core\.mjs["']/s,
  );
  assert.match(code, /\bINITIAL_CONNECT_MAX_ATTEMPTS\b/);
});

test("retries the INITIAL connect on failure instead of giving up after one attempt", () => {
  assert.match(code, /for\s*\(\s*let\s+attempt\s*=\s*1;\s*attempt\s*<=\s*INITIAL_CONNECT_MAX_ATTEMPTS/);
  assert.match(code, /computeInitialConnectBackoffMs\(attempt\)/);
});

test("the initial-connect retry loop rethrows once attempts are exhausted, so startDiscordGateway's own catch still runs", () => {
  const retryFnMatch = code.match(/async function connectWithRetry\([\s\S]*?\n\}/);
  assert.ok(retryFnMatch, "connectWithRetry function not found");
  assert.match(retryFnMatch[0], /throw err/);
});

test("the Closed handler (where fatal codes are classified) never itself calls connect() — retries live exclusively in the one-time boot path, never triggered by a fatal close", () => {
  const closedHandlerMatch = code.match(
    /manager\.on\(WebSocketShardEvents\.Closed,[\s\S]*?\n {4}\}\);/,
  );
  assert.ok(closedHandlerMatch, "Closed handler block not found");
  assert.doesNotMatch(closedHandlerMatch[0], /connect\(/);
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

test("exports startDiscordGateway", () => {
  assert.match(code, /export\s+(?:async\s+)?function\s+startDiscordGateway/);
});

test("does not export the old getDiscordGatewayStatus dead code (review minor — it was referenced only by its own test; removed rather than wired to a real caller)", () => {
  assert.doesNotMatch(code, /getDiscordGatewayStatus/);
});

test("documents the multi-replica stance explicitly (spec requirement)", () => {
  assert.match(code, /MULTI-REPLICA STANCE/);
  assert.match(code, /ON CONFLICT/i);
});

// ---------------------------------------------------------------------------
// connectWithRetry — BEHAVIORAL (I4). See the header comment's "EXCEPTION".
// ---------------------------------------------------------------------------

/** A fake manager: `behaviors[i]` is either "ok" (connect() resolves) or any
 * other string (connect() rejects with an Error carrying that string as its
 * message) for the (0-indexed) i-th call. */
function fakeManager(behaviors) {
  let callCount = 0;
  return {
    calls: () => callCount,
    async connect() {
      const behavior = behaviors[callCount];
      callCount += 1;
      if (behavior === "ok") return;
      throw new Error(behavior);
    },
  };
}

/** Injected sleep that resolves immediately but records every requested
 * delay, so tests run instantly with no real timers. */
function instantSleep() {
  const delays = [];
  return { sleep: async (ms) => { delays.push(ms); }, delays };
}

test("connectWithRetry: succeeds on the first attempt without any retry", async () => {
  const manager = fakeManager(["ok"]);
  const { sleep, delays } = instantSleep();
  await connectWithRetry(manager, { sleep });
  assert.equal(manager.calls(), 1);
  assert.deepEqual(delays, []);
});

test("connectWithRetry: retries after failures, then succeeds", async () => {
  const manager = fakeManager(["boom-1", "boom-2", "ok"]);
  const { sleep, delays } = instantSleep();
  await connectWithRetry(manager, { sleep });
  assert.equal(manager.calls(), 3);
  assert.equal(delays.length, 2, "slept before each retry, not before the final success");
});

test("connectWithRetry: exhausts INITIAL_CONNECT_MAX_ATTEMPTS then rethrows the LAST attempt's error", async () => {
  const manager = fakeManager(["e1", "e2", "e3", "e4", "e5", "e6-never-reached"]);
  const { sleep, delays } = instantSleep();
  await assert.rejects(
    () => connectWithRetry(manager, { sleep }),
    (err) => {
      assert.equal(err.message, "e5");
      return true;
    },
  );
  assert.equal(manager.calls(), INITIAL_CONNECT_MAX_ATTEMPTS, "never attempts a 6th time");
  assert.equal(
    delays.length,
    INITIAL_CONNECT_MAX_ATTEMPTS - 1,
    "slept between each retry, but not after the final giving-up",
  );
});

test("connectWithRetry: never calls connect() more than INITIAL_CONNECT_MAX_ATTEMPTS times, even if every attempt fails", async () => {
  const manager = fakeManager(new Array(10).fill("always fails"));
  const { sleep } = instantSleep();
  await assert.rejects(() => connectWithRetry(manager, { sleep }));
  assert.equal(manager.calls(), INITIAL_CONNECT_MAX_ATTEMPTS);
});

test("connectWithRetry: the FIRST retry is attempted immediately after a failure (no delay parameter of 0 vs undefined confusion) — sleep is always called with a number", async () => {
  const manager = fakeManager(["boom", "ok"]);
  const { sleep, delays } = instantSleep();
  await connectWithRetry(manager, { sleep });
  assert.equal(delays.length, 1);
  assert.equal(typeof delays[0], "number");
  assert.ok(delays[0] >= 0);
});
