// Invariant test for the prod outage this arc fixed: jace's Slack channel
// (agent/channels/slack.ts) must declare an `events` handler for EVERY event
// eve's Slack channel can resolve a DEFAULT for, because eve resolves
// exactly ONE handler per event — `events[name] ?? defaultEvents[name]`
// (verified: node_modules/eve/dist/src/public/channels/slack/slackChannel.js's
// `m = {...defaultEvents, ...e.events, ...}` merge, plus the `turn.started` /
// `input.requested` / `authorization.required` special-cased fallbacks built
// on top of it). Leaving even one undeclared silently reinstates eve's
// default, and several of those defaults call the Slack Web API directly
// and UNCAUGHT — this is exactly what happened: `turn.failed`,
// `session.failed`, and `input.requested` were never overridden, their
// defaults' `channel.thread.post(...)` calls threw `SLACK_BOT_TOKEN is
// required.` on every turn, and the reply never went out.
//
// This test reads the REAL installed eve package (the compiled runtime, not
// its `.d.ts` or docs — this repo has been burned before by those
// disagreeing, see slack.ts's own header) to enumerate the actual default
// event names, then checks agent/channels/slack.ts declares a handler for
// every one of them. If eve is upgraded and adds a new Slack default event
// handler, this test fails LOUDLY instead of the fix silently rotting.
//
// Deliberately does NOT import eve's slack defaults module as a live module:
// `eve`'s package.json `exports` map only exposes the `./channels/slack`
// public entrypoint (index.js), which does not re-export `defaultEvents` or
// `defaultInputRequestedHandler` — reaching the compiled internals requires
// reading them as text, the same idiom discord-gateway-wiring.test.mjs uses
// for a file `node --test` cannot safely execute directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const defaultsJsPath = fileURLToPath(
  new URL(
    "../node_modules/eve/dist/src/public/channels/slack/defaults.js",
    import.meta.url,
  ),
);
const slackChannelJsPath = fileURLToPath(
  new URL(
    "../node_modules/eve/dist/src/public/channels/slack/slackChannel.js",
    import.meta.url,
  ),
);
const slackTsPath = fileURLToPath(new URL("../agent/channels/slack.ts", import.meta.url));

const defaultsSource = readFileSync(defaultsJsPath, "utf8");
const slackChannelSource = readFileSync(slackChannelJsPath, "utf8");
const slackTsSource = readFileSync(slackTsPath, "utf8");
const slackTsNoComments = slackTsSource
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

/** Every key eve's Slack `defaultEvents` object literal declares, extracted
 * from the compiled (minified, one-line) source between `const
 * defaultEvents={` and its closing `};export{defaultEvents`. Matches the
 * `async"key.name"(` method-shorthand shape the compiler emits. */
function extractDefaultEventsKeys(source) {
  const start = source.indexOf("const defaultEvents={");
  assert.ok(start !== -1, "could not find `const defaultEvents={` in eve's compiled defaults.js — has eve's build output changed shape?");
  const end = source.indexOf("};export{defaultEvents", start);
  assert.ok(end !== -1, "could not find the end of eve's defaultEvents object literal");
  const body = source.slice(start, end);
  const keys = [...body.matchAll(/async"([a-zA-Z0-9_.]+)"\(/g)].map((m) => m[1]);
  assert.ok(keys.length > 0, "extracted zero keys from eve's defaultEvents — extraction regex is stale");
  return keys;
}

/** `input.requested` is NOT part of the `defaultEvents` object — it's a
 * separately-exported factory (`defaultInputRequestedHandler`) that
 * `slackChannel.js` falls back to the same `?? default...()` way. Confirm
 * that wiring still exists (so we know to require an override for it too)
 * rather than hardcoding the event name from prose alone. */
function confirmsInputRequestedDefaultFallback(source) {
  return /"input\.requested":[^,]*defaultInputRequestedHandler\(\)/.test(source);
}

test("sanity: eve's compiled defaults.js still defines the event names this fix was built against", () => {
  const keys = extractDefaultEventsKeys(defaultsSource);
  for (const expected of [
    "turn.started",
    "reasoning.appended",
    "actions.requested",
    "message.completed",
    "turn.failed",
    "session.failed",
    "authorization.required",
    "authorization.completed",
  ]) {
    assert.ok(keys.includes(expected), `expected eve's defaultEvents to still declare "${expected}"`);
  }
});

test("sanity: slackChannel.js still resolves input.requested via defaultInputRequestedHandler() when undeclared", () => {
  assert.ok(
    confirmsInputRequestedDefaultFallback(slackChannelSource),
    "eve's slackChannel.js no longer falls back to defaultInputRequestedHandler() for input.requested — re-check whether it still needs an override",
  );
});

test("INVARIANT: agent/channels/slack.ts declares an events handler for every eve Slack default event", () => {
  const requiredEvents = extractDefaultEventsKeys(defaultsSource);
  if (confirmsInputRequestedDefaultFallback(slackChannelSource)) {
    requiredEvents.push("input.requested");
  }

  const missing = requiredEvents.filter((eventName) => {
    // A declared handler is either `async "name"(` (method shorthand) or
    // `"name": async` (property form) inside the events object — comments
    // are stripped first so a backtick-quoted mention in prose can't count
    // as a declaration.
    const methodShorthand = new RegExp(`async\\s*"${eventName.replace(/\./g, "\\.")}"\\s*\\(`);
    const propertyForm = new RegExp(`"${eventName.replace(/\./g, "\\.")}"\\s*:\\s*async`);
    return !methodShorthand.test(slackTsNoComments) && !propertyForm.test(slackTsNoComments);
  });

  assert.deepEqual(
    missing,
    [],
    `agent/channels/slack.ts is missing an events override for: ${missing.join(", ")}. ` +
      "Each of these has an eve Slack default that resolves and runs whenever this file " +
      "doesn't declare its own handler — several of those defaults call the Slack Web API " +
      "UNCAUGHT with no bot token configured, which is the exact outage this test guards " +
      "against. Add a deliberate no-op or console-routed override for it (see the other " +
      "handlers in that file for the pattern), never leave it undeclared.",
  );
});
