// Structural test for the #1289 goal-loop wiring added to
// agent/channels/run-outcome.ts. Following this repo's convention
// (hosted-inbound-channel.test.mjs, telegram-channel.test.mjs): a `.ts` Eve
// channel module can't be imported directly under plain `node --test`, so
// the actual DECISION logic lives in and is fully exercised by
// goal_outcome_dispatch.core.test.mjs / run_outcome.core.test.mjs; this file
// only locks the WIRING — that the channel imports the pure dispatch core,
// gates on all three enrichment fields, wraps the call in its own
// `waitUntil` independent of the platform-notify forward, and never calls
// create_issue (or any mutating tool) directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const channelTsPath = fileURLToPath(new URL("../agent/channels/run-outcome.ts", import.meta.url));
const code = readFileSync(channelTsPath, "utf8");

// Strip `//` line comments and `/* */` block comments before matching the
// "never calls create_issue" assertion below — this file's own header
// comment explains the safety property IN PROSE (mentioning create_issue /
// consoleGatedApproval by name to describe what this code must NOT do),
// which would otherwise false-positive against a naive whole-file match.
// Mirrors no-second-write-path.test.mjs's own `stripComments` idiom.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const codeOnly = stripComments(code);

test("imports evaluateGoalOutcome from the pure goal_outcome_dispatch core", () => {
  assert.match(
    code,
    /import\s*\{\s*evaluateGoalOutcome\s*,\s*realTransport\s+as\s+goalEvaluateTransport\s*\}\s*from\s*["']\.\.\/lib\/goal_outcome_dispatch\.core\.mjs["']/,
  );
});

test("the existing platform-notify args.receive/waitUntil call is unchanged (still present, still unconditional)", () => {
  assert.match(code, /args\.waitUntil\(\s*args\.receive\(channel,\s*\{\s*message:\s*outcome\.message,/);
});

test("the goal-loop evaluation only runs when workspaceId/issueExternalId/outcome are ALL present", () => {
  assert.match(
    code,
    /if\s*\(\s*outcome\.workspaceId\s*&&\s*outcome\.issueExternalId\s*&&\s*outcome\.outcome\s*\)/,
  );
});

test("the goal-loop evaluation is wrapped in its OWN args.waitUntil — independent of the platform-notify forward above", () => {
  const matches = code.match(/args\.waitUntil\(/g) ?? [];
  assert.ok(matches.length >= 2, `expected at least 2 waitUntil calls (notify + goal-loop), found ${matches.length}`);
});

test("calls evaluateGoalOutcome with the injected realTransport (goalEvaluateTransport), never a bare fetch", () => {
  assert.match(code, /evaluateGoalOutcome\(\s*\{/);
  assert.match(code, /transport:\s*goalEvaluateTransport/);
});

test("a 'message' dispatch action re-uses the SAME channel/target/auth already resolved for the platform notify — never a second target resolution", () => {
  // The goal-loop's own args.receive call for a dispatched message must pass
  // outcome.target/outcome.auth — the exact same values the notify call
  // above uses — never a freshly-resolved target.
  const dispatchBlockStart = code.indexOf('dispatch.action === "message"');
  assert.notEqual(dispatchBlockStart, -1, "must branch on dispatch.action === 'message'");
  const dispatchBlock = code.slice(dispatchBlockStart, dispatchBlockStart + 300);
  assert.match(dispatchBlock, /target:\s*outcome\.target/);
  assert.match(dispatchBlock, /outcome\.auth/);
});

test("does NOT call create_issue or any mutating tool directly (code only, comments excluded — this file only ever sends a MESSAGE, never files an issue itself)", () => {
  assert.doesNotMatch(codeOnly, /create_issue/);
  assert.doesNotMatch(codeOnly, /runCreateIssue/);
  assert.doesNotMatch(codeOnly, /consoleGatedApproval/);
});
