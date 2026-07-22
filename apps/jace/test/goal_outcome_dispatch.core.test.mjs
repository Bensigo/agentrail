import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideGoalDispatch,
  buildReachedMessage,
  buildEscalationMessage,
  buildRefillMessage,
  goalStamp,
  evaluateGoalOutcome,
  buildEvaluateGoalUrl,
  resolveConsoleConfig,
} from "../agent/lib/goal_outcome_dispatch.core.mjs";

const GOAL = {
  objective: "reach 80% coverage",
  slug: "reach-80-coverage",
  issuesFiled: 3,
  maxIssues: 10,
  spendUsd: 12,
  maxSpendUsd: 50,
};

test("goalStamp renders 'Goal: <objective> (goal:<slug>)'", () => {
  assert.equal(goalStamp(GOAL), "Goal: reach 80% coverage (goal:reach-80-coverage)");
});

test("buildReachedMessage says REACHED and never files anything further", () => {
  const msg = buildReachedMessage(GOAL, "2/2 green outcomes");
  assert.match(msg, /REACHED/);
  assert.match(msg, /No further issues will be filed/);
  assert.match(msg, /goal:reach-80-coverage/);
});

test("buildEscalationMessage('leashed') says LEASHED and instructs no further filing", () => {
  const msg = buildEscalationMessage(GOAL, "issues filed 10/10", "leashed");
  assert.match(msg, /LEASHED/);
  assert.match(msg, /Do not file any further issues/);
});

test("buildEscalationMessage('stuck') says PAUSED (stuck rule)", () => {
  const msg = buildEscalationMessage(GOAL, "2 consecutive non-green outcomes", "stuck");
  assert.match(msg, /PAUSED \(stuck rule\)/);
  assert.match(msg, /Do not file any further issues/);
});

test("buildRefillMessage reports remaining leash and instructs create_issue with the goal stamp — never calls it itself", () => {
  const msg = buildRefillMessage(GOAL, "42", "green");
  assert.match(msg, /issue #42/);
  assert.match(msg, /green/);
  assert.match(msg, /7 issue\(s\) \/ \$38\.00/); // 10-3=7, 50-12=38
  assert.match(msg, /via create_issue/);
  assert.match(msg, /Goal: reach 80% coverage \(goal:reach-80-coverage\)/);
});

test("buildRefillMessage never reports negative remaining leash (defensive clamp)", () => {
  const overspent = { ...GOAL, issuesFiled: 12, spendUsd: 60 };
  const msg = buildRefillMessage(overspent, "42", "blocked");
  assert.match(msg, /0 issue\(s\) \/ \$0\.00/);
});

test("decideGoalDispatch: matched=false -> action:none", () => {
  assert.deepEqual(decideGoalDispatch({ matched: false }, { issueExternalId: "1", outcome: "green" }), {
    action: "none",
  });
});

test("decideGoalDispatch: malformed body -> action:none, never throws", () => {
  assert.deepEqual(decideGoalDispatch(null, { issueExternalId: "1", outcome: "green" }), { action: "none" });
  assert.deepEqual(decideGoalDispatch(undefined, { issueExternalId: "1", outcome: "green" }), {
    action: "none",
  });
  assert.deepEqual(decideGoalDispatch("not an object", { issueExternalId: "1", outcome: "green" }), {
    action: "none",
  });
  assert.deepEqual(decideGoalDispatch({ matched: true, goal: {} }, { issueExternalId: "1", outcome: "green" }), {
    action: "none",
  });
});

test("decideGoalDispatch: action='reached' -> a REACHED message", () => {
  const result = decideGoalDispatch(
    { matched: true, action: "reached", reason: "2/2 green outcomes", goal: GOAL },
    { issueExternalId: "42", outcome: "green" }
  );
  assert.equal(result.action, "message");
  assert.match(result.message, /REACHED/);
});

test("decideGoalDispatch: action='escalate_leashed' -> a LEASHED message", () => {
  const result = decideGoalDispatch(
    { matched: true, action: "escalate_leashed", reason: "issues filed 10/10", goal: GOAL },
    { issueExternalId: "42", outcome: "blocked" }
  );
  assert.equal(result.action, "message");
  assert.match(result.message, /LEASHED/);
});

test("decideGoalDispatch: action='escalate_stuck' -> a PAUSED message", () => {
  const result = decideGoalDispatch(
    { matched: true, action: "escalate_stuck", reason: "2 consecutive non-green", goal: GOAL },
    { issueExternalId: "42", outcome: "blocked" }
  );
  assert.equal(result.action, "message");
  assert.match(result.message, /PAUSED/);
});

test("decideGoalDispatch: action='refill' -> a refill nudge naming the SAME issue/outcome the caller evaluated", () => {
  const result = decideGoalDispatch(
    { matched: true, action: "refill", reason: "still active", goal: GOAL },
    { issueExternalId: "77", outcome: "green" }
  );
  assert.equal(result.action, "message");
  assert.match(result.message, /issue #77/);
  assert.match(result.message, /green/);
});

test("decideGoalDispatch: action='noop' (goal already terminal) -> action:none, never re-escalates", () => {
  const result = decideGoalDispatch(
    { matched: true, action: "noop", reason: "goal is already 'leashed'", goal: GOAL },
    { issueExternalId: "99", outcome: "green" }
  );
  assert.deepEqual(result, { action: "none" });
});

test("decideGoalDispatch: an unrecognized action value -> action:none (fail-safe, never throws)", () => {
  const result = decideGoalDispatch(
    { matched: true, action: "something_new", goal: GOAL },
    { issueExternalId: "1", outcome: "green" }
  );
  assert.deepEqual(result, { action: "none" });
});

// --- evaluateGoalOutcome: the HTTP orchestration layer ---

function fakeTransport(sequence) {
  const calls = [];
  let i = 0;
  return {
    calls,
    fn: async (url, init) => {
      calls.push({ url, init });
      const next = sequence[Math.min(i, sequence.length - 1)];
      i++;
      if (next.throws) throw next.throws;
      return { status: next.status, json: async () => next.body };
    },
  };
}

const ENV = { JACE_CONSOLE_BASE_URL: "https://console.example.com", JACE_CONSOLE_TOKEN: "tok" };

test("evaluateGoalOutcome POSTs to the evaluate endpoint with Bearer auth and the outcome payload", async () => {
  const transport = fakeTransport([{ status: 200, body: { matched: false } }]);
  const result = await evaluateGoalOutcome({
    workspaceId: "ws-1",
    issueExternalId: "42",
    outcome: "green",
    costUsd: 1.5,
    env: ENV,
    transport: transport.fn,
  });
  assert.deepEqual(result, { action: "none" });
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].url, buildEvaluateGoalUrl("https://console.example.com"));
  assert.equal(transport.calls[0].init.headers.Authorization, "Bearer tok");
  const sentBody = JSON.parse(transport.calls[0].init.body);
  assert.deepEqual(sentBody, { workspaceId: "ws-1", issueExternalId: "42", outcome: "green", costUsd: 1.5 });
});

test("evaluateGoalOutcome resolves action:none (never throws) when JACE_CONSOLE_BASE_URL/TOKEN are unset", async () => {
  const transport = fakeTransport([{ status: 200, body: {} }]);
  const result = await evaluateGoalOutcome({
    workspaceId: "ws-1",
    issueExternalId: "42",
    outcome: "green",
    env: {},
    transport: transport.fn,
  });
  assert.deepEqual(result, { action: "none" });
  assert.equal(transport.calls.length, 0, "must not attempt the HTTP call with no config");
});

test("evaluateGoalOutcome resolves action:none on a transport error (network blip)", async () => {
  const transport = fakeTransport([{ throws: new Error("ECONNREFUSED") }]);
  const result = await evaluateGoalOutcome({
    workspaceId: "ws-1",
    issueExternalId: "42",
    outcome: "green",
    env: ENV,
    transport: transport.fn,
  });
  assert.deepEqual(result, { action: "none" });
});

test("evaluateGoalOutcome resolves action:none on a non-2xx status", async () => {
  const transport = fakeTransport([{ status: 500, body: {} }]);
  const result = await evaluateGoalOutcome({
    workspaceId: "ws-1",
    issueExternalId: "42",
    outcome: "green",
    env: ENV,
    transport: transport.fn,
  });
  assert.deepEqual(result, { action: "none" });
});

test("evaluateGoalOutcome end-to-end: a real 'refill' response body produces the refill message", async () => {
  const transport = fakeTransport([
    {
      status: 200,
      body: { matched: true, action: "refill", reason: "still active", goal: GOAL },
    },
  ]);
  const result = await evaluateGoalOutcome({
    workspaceId: "ws-1",
    issueExternalId: "42",
    outcome: "green",
    env: ENV,
    transport: transport.fn,
  });
  assert.equal(result.action, "message");
  assert.match(result.message, /issue #42/);
});

test("resolveConsoleConfig reports missing vars", () => {
  assert.deepEqual(resolveConsoleConfig({}), {
    ok: false,
    missing: ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"],
  });
});
