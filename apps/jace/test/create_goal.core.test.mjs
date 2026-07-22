// Unit tests for the create_goal core (issue #1289). No SDK, no live
// network: the single HTTP call is an injected `transport` seam, so every
// branch — success and every failure — is exercised deterministically.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CREATE_GOAL_PATH,
  GENERIC_FAILURE_MESSAGE,
  resolveConsoleConfig,
  buildCreateGoalUrl,
  runCreateGoal,
} from "../agent/lib/create_goal.core.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
};

function fakeTransport(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

test("resolveConsoleConfig resolves + trims + de-slashes when both vars are set", () => {
  const cfg = resolveConsoleConfig({
    JACE_CONSOLE_BASE_URL: "  https://c.example.com/  ",
    JACE_CONSOLE_TOKEN: "  tok  ",
  });
  assert.deepEqual(cfg, { ok: true, baseUrl: "https://c.example.com", token: "tok" });
});

test("buildCreateGoalUrl joins the path", () => {
  assert.equal(buildCreateGoalUrl("https://c.example.com"), "https://c.example.com" + CREATE_GOAL_PATH);
});

test("runCreateGoal: config unset -> GENERIC_FAILURE_MESSAGE, no HTTP attempt", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({}) }));
  const result = await runCreateGoal({
    eveSessionId: "eve-1",
    objective: "reach 80% coverage",
    env: {},
    transport,
  });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
  assert.equal(transport.calls.length, 0);
});

test("runCreateGoal: blank eveSessionId -> GENERIC_FAILURE_MESSAGE (defensive)", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({}) }));
  const result = await runCreateGoal({ eveSessionId: "  ", objective: "x", env: ENV, transport });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
});

test("runCreateGoal: blank objective -> GENERIC_FAILURE_MESSAGE (defensive)", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({}) }));
  const result = await runCreateGoal({ eveSessionId: "eve-1", objective: "   ", env: ENV, transport });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
});

test("runCreateGoal: transport throws -> GENERIC_FAILURE_MESSAGE, single attempt (no retry)", async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    throw new Error("ECONNREFUSED");
  };
  const result = await runCreateGoal({
    eveSessionId: "eve-1",
    objective: "reach 80% coverage",
    env: ENV,
    transport,
  });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
  assert.equal(calls, 1);
});

test("runCreateGoal: 409 with connected:false surfaces the structured 'no repo connected' shape", async () => {
  const transport = fakeTransport(() => ({
    status: 409,
    json: async () => ({ connected: false, message: "connect a repo first" }),
  }));
  const result = await runCreateGoal({
    eveSessionId: "eve-1",
    objective: "reach 80% coverage",
    env: ENV,
    transport,
  });
  assert.deepEqual(result, { connected: false, message: "connect a repo first" });
});

test("runCreateGoal: 409 with a plain error string surfaces it verbatim", async () => {
  const transport = fakeTransport(() => ({
    status: 409,
    json: async () => ({ error: "this conversation has no workspace yet — create one first" }),
  }));
  const result = await runCreateGoal({
    eveSessionId: "eve-1",
    objective: "reach 80% coverage",
    env: ENV,
    transport,
  });
  assert.equal(result, "this conversation has no workspace yet — create one first");
});

test("runCreateGoal: any other non-2xx (400/401/500) collapses to GENERIC_FAILURE_MESSAGE", async () => {
  for (const status of [400, 401, 500]) {
    const transport = fakeTransport(() => ({ status, json: async () => ({}) }));
    const result = await runCreateGoal({
      eveSessionId: "eve-1",
      objective: "reach 80% coverage",
      env: ENV,
      transport,
    });
    assert.equal(result, GENERIC_FAILURE_MESSAGE, `status ${status}`);
  }
});

test("runCreateGoal: malformed 2xx body -> GENERIC_FAILURE_MESSAGE", async () => {
  const transport = fakeTransport(() => ({ status: 201, json: async () => ({ goalId: 123 }) }));
  const result = await runCreateGoal({
    eveSessionId: "eve-1",
    objective: "reach 80% coverage",
    env: ENV,
    transport,
  });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
});

test("runCreateGoal: success returns { goalId, objective, slug, status } and sends the trimmed objective + optional overrides", async () => {
  const transport = fakeTransport(() => ({
    status: 201,
    json: async () => ({ goalId: "goal-1", objective: "reach 80% coverage", slug: "reach-80-coverage", status: "active" }),
  }));
  const result = await runCreateGoal({
    eveSessionId: "eve-1",
    objective: "  reach 80% coverage  ",
    checkThreshold: 5,
    maxIssues: 8,
    maxSpendUsd: 40,
    env: ENV,
    transport,
  });
  assert.deepEqual(result, {
    goalId: "goal-1",
    objective: "reach 80% coverage",
    slug: "reach-80-coverage",
    status: "active",
  });
  const sentBody = JSON.parse(transport.calls[0].init.body);
  assert.deepEqual(sentBody, {
    eveSessionId: "eve-1",
    objective: "reach 80% coverage",
    checkThreshold: 5,
    maxIssues: 8,
    maxSpendUsd: 40,
  });
  assert.equal(transport.calls[0].init.headers.Authorization, "Bearer tok-secret-123");
});

test("runCreateGoal: omits optional overrides from the request body entirely when not given", async () => {
  const transport = fakeTransport(() => ({
    status: 201,
    json: async () => ({ goalId: "goal-1", objective: "x", slug: "x", status: "active" }),
  }));
  await runCreateGoal({ eveSessionId: "eve-1", objective: "x", env: ENV, transport });
  const sentBody = JSON.parse(transport.calls[0].init.body);
  assert.deepEqual(sentBody, { eveSessionId: "eve-1", objective: "x" });
});
