// Regression test for the #1288 cross-service reply bug: once the console
// dispatcher could reach Jace (Railway networking fixed separately), every
// console chat turn still failed with:
//
//   Error: args.receive(): the channel passed as the first argument is not
//   registered in this agent's channels/. Import the channel module's
//   default export from agent/channels/<name>.ts and pass that value.
//
// Jace saved the member's message (role: "user") but never replied — no
// role: "jace" row ever landed.
//
// Root cause, traced through the INSTALLED eve@0.19.0 package's
// `channel/cross-channel-receive.js` (dist): `args.receive(module, ...)`
// resolves its target in two steps —
//   1. `resolveTargetByReference` — find `module` by OBJECT REFERENCE among
//      the channels eve's compiled-artifacts graph registered.
//   2. Only if that fails: `resolveTargetByRouteFingerprint` — match by the
//      channel's sorted `METHOD path` route set instead. This is a
//      deliberate accommodation for a bundled/serverless deployment, where
//      each route can compile as its own isolated entry point, so a channel
//      module imported from a DIFFERENT file (`hosted-inbound.ts` importing
//      `./console.js`) is not guaranteed to be the SAME object instance the
//      graph registered for "console".
// `createRouteFingerprint` in that same module returns `null` when
// `routes.length === 0` — so step 2 is a no-op for a route-less channel.
// `agent/channels/console.ts` used to declare `routes: []` (by design: it
// has no native inbound webhook, it is only ever reached via the
// `receive()` cross-channel hand-off) — so it had NO fallback at all. If the
// bundled deployment's reference match ever failed (step 1), there was
// nothing left to catch it.
//
// The fix (this channel's own file) gives console.ts exactly one stub route
// solely so it has a non-empty, UNIQUE fingerprint for step 2 to find.
//
// Unlike the sibling `*-channel.test.mjs` files in this directory, this test
// imports the REAL channel modules directly rather than regex-matching
// source text — Node >=24 (this app's own `engines` pin) strips TypeScript
// types natively, so a plain `import("../agent/channels/console.ts")` here
// actually executes `defineChannel({...})` and returns the real compiled
// shape. (The OLDER text-only convention in this directory predates that:
// `hosted-inbound.ts` and `run-outcome.ts` import sibling channels via
// `.js`-suffixed specifiers, the TypeScript "emit as .js" idiom — plain Node
// ESM resolution does not remap those back to the `.ts` source the way
// Eve's own dev/build toolchain does, so THOSE two specifically still are
// not directly importable here; this test sticks to the ones that are.)
//
// This test CANNOT reproduce the actual multi-bundle object-reference
// mismatch itself — that only exists under Eve's own compiled-artifacts
// runtime (`eve dev` / `eve build` / `eve start`), which this sandbox has no
// access to. It pins the two structural conditions
// `resolveTargetByRouteFingerprint` / `createRouteFingerprint` require for
// their fallback to find a channel at all: a NON-EMPTY route set, and a
// fingerprint that is UNIQUE among every other registered channel (a
// collision throws a DIFFERENT eve error — "matches multiple registered
// channels by route shape"). Live end-to-end verification (a real console
// message getting a real Jace reply) happens against prod, separately.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// NOTE: `.ts` extensions here, not `.js` — plain Node ESM resolution (no
// loader) does not remap a `.js`-suffixed specifier back to a `.ts` sibling
// (that TypeScript "emit as .js" idiom is what `hosted-inbound.ts`/
// `run-outcome.ts` use, and it's exactly why THOSE two aren't directly
// importable here — see this file's header comment). Importing the real
// `.ts` file directly is what makes this test possible at all.
import console_ from "../agent/channels/console.ts";
import telegram from "../agent/channels/telegram.ts";
import discord from "../agent/channels/discord.ts";
import slack from "../agent/channels/slack.ts";
import imessage from "../agent/channels/imessage.ts";

/** `null` for a route-less channel — mirrors eve's own `createRouteFingerprint` exactly (routes.length === 0 → null, else the sorted "METHOD path" set, joined). */
function fingerprint(channel) {
  if (!channel.routes || channel.routes.length === 0) return null;
  return channel.routes
    .map((r) => `${String(r.method).toUpperCase()} ${r.path}`)
    .sort()
    .join("\n");
}

const DIRECTLY_IMPORTABLE_SIBLINGS = { telegram, discord, slack, imessage };

test("console channel declares at least one route (a route-less channel has NO fallback match in eve's args.receive resolver)", () => {
  assert.ok(Array.isArray(console_.routes), "console.ts must export a routes array");
  assert.ok(
    console_.routes.length > 0,
    "console.ts must declare at least one route so eve's route-fingerprint fallback can find it when the object-reference match fails (see this file's header comment)",
  );
});

test("console channel's route(s) are well-formed: every route has a method and a path", () => {
  for (const route of console_.routes) {
    assert.equal(typeof route.method, "string");
    assert.ok(route.method.length > 0);
    assert.equal(typeof route.path, "string");
    assert.ok(route.path.startsWith("/"), `route path "${route.path}" should be an absolute path`);
  }
});

test("console channel's route fingerprint is unique among every directly-importable sibling channel (a collision throws 'matches multiple registered channels by route shape')", () => {
  const consoleFp = fingerprint(console_);
  assert.ok(consoleFp !== null);
  for (const [name, channel] of Object.entries(DIRECTLY_IMPORTABLE_SIBLINGS)) {
    assert.notEqual(
      fingerprint(channel),
      consoleFp,
      `console's route fingerprint collides with ${name}'s`,
    );
  }
});

test("console channel's stub route path does not appear in hosted-inbound.ts or run-outcome.ts (the two channels not directly importable here — see header comment)", () => {
  const consolePath = console_.routes[0].path;
  for (const rel of ["../agent/channels/hosted-inbound.ts", "../agent/channels/run-outcome.ts"]) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    const code = readFileSync(p, "utf8");
    assert.ok(
      !code.includes(consolePath),
      `${rel} must not declare the same route path as console.ts (${consolePath})`,
    );
  }
});

test("console channel still declares receive() — the cross-channel hand-off target hosted-inbound.ts calls args.receive() against", () => {
  assert.equal(typeof console_.receive, "function");
});

test("hosted-inbound.ts imports and wires console.ts's default export under channel: \"console\" (the object identity eve's resolver tries FIRST, before the route-fingerprint fallback)", () => {
  const p = fileURLToPath(new URL("../agent/channels/hosted-inbound.ts", import.meta.url));
  const code = readFileSync(p, "utf8");
  assert.match(code, /import\s+console_\s+from\s*["']\.\/console\.js["']/);
  assert.match(code, /console\s*:\s*console_/);
});
