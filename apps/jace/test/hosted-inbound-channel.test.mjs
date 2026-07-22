// Structural test for the hosted-inbound door channel's wiring.
//
// agent/channels/hosted-inbound.ts is a `.ts` Eve channel module — `node
// --test` cannot import it directly (no TS loader is configured for the test
// run, and constructing a real `defineChannel()` route would require Eve's
// runtime context). Following this repo's convention (telegram-channel.test.mjs,
// skills.test.mjs, reporting-skills.test.mjs), the validation LOGIC lives in
// and is fully exercised by hosted-inbound.core.test.mjs; this test only locks
// the WIRING — that the channel actually validates via the pure core, AWAITS
// the cross-channel receive (no fire-and-forget), and returns the session id
// — by reading the source as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const channelTsPath = fileURLToPath(
  new URL("../agent/channels/hosted-inbound.ts", import.meta.url),
);
const code = readFileSync(channelTsPath, "utf8");

test("imports defineChannel/POST from eve/channels", () => {
  assert.match(code, /import\s*\{\s*defineChannel,\s*POST\s*\}\s*from\s*["']eve\/channels["']/);
});

test("imports the pure validator from agent/lib", () => {
  assert.match(
    code,
    /import\s*\{\s*normalizeHostedInbound\s*\}\s*from\s*["']\.\.\/lib\/hosted_inbound\.core\.mjs["']/,
  );
});

test("imports telegram/discord/slack channel modules (#1284/#1285: multi-channel CHANNELS map, mirroring run-outcome.ts)", () => {
  assert.match(code, /import\s+telegram\s+from\s*["']\.\/telegram\.js["']/);
  assert.match(code, /import\s+discord\s+from\s*["']\.\/discord\.js["']/);
  assert.match(code, /import\s+slack\s+from\s*["']\.\/slack\.js["']/);
});

test("declares exactly one POST(\"/eve/v1/hosted-inbound\") route — the LITERAL mount path (Eve mounts defineChannel routes at their literal declared path; /eve/v1/<id> is a built-in-adapter default, not a framework rewrite)", () => {
  const matches = code.match(/POST\(\s*["']\/eve\/v1\/hosted-inbound["']/g) ?? [];
  assert.equal(matches.length, 1);
});

test("does NOT declare a bare POST(\"/\") route (that path is unreachable at /eve/v1/hosted-inbound in every environment — verified via .eve/compile/compiled-agent-manifest.json's urlPath)", () => {
  assert.doesNotMatch(code, /POST\(\s*["']\/["']/);
});

test("validates the body through normalizeHostedInbound before receiving", () => {
  assert.match(code, /normalizeHostedInbound\(/);
});

test("returns 400 on a JSON parse failure and on a normalize failure", () => {
  // Two distinct catch sites: the req.json() parse, and normalizeHostedInbound.
  const fourHundreds = code.match(/\b400\b/g) ?? [];
  assert.ok(
    fourHundreds.length >= 2,
    `expected at least 2 occurrences of a 400 status, found ${fourHundreds.length}`,
  );
});

test("AWAITS args.receive(channelModule, ...) — the whole point is a synchronous sessionId in the response", () => {
  assert.match(code, /await\s+args\.receive\(\s*channelModule\s*,/);
});

test("selects the channel module from a CHANNELS map by normalized.channel, rejecting an unwired channel with 400", () => {
  assert.match(code, /CHANNELS\[\s*normalized\.channel\s*\]/);
  assert.match(code, /is not wired/);
});

test("does NOT call args.waitUntil (no fire-and-forget — annex-eve-internals.md consequence 1)", () => {
  assert.doesNotMatch(code, /args\.waitUntil\(/);
});

test("returns ok/sessionId/continuationToken from the received session", () => {
  assert.match(code, /sessionId\s*:\s*session\.id/);
  assert.match(code, /continuationToken\s*:\s*session\.continuationToken/);
  assert.match(code, /ok\s*:\s*true/);
});
