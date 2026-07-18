// Unit tests for consoleGatedApproval (issue #1273 PR ②) — the approval fn
// that replaces Eve's stock `always()` HITL for create_issue/create_workspace/
// create_repo. No SDK, no live network, no real waiting: transport/sleep/now
// are injected seams, so every branch — success, denial, expiry, and every
// infrastructure failure — is exercised deterministically and fast.
//
// THE SAFETY LINE this file exists to prove: no path through
// runConsoleGatedApproval/consoleGatedApproval ever resolves to "approved"
// except an explicit approved reply from the console's poll. Every other
// outcome — config missing, transport throw, non-2xx, malformed body, TTL
// expiry, or a malformed ctx — resolves to an explicit denial, and the
// function never throws.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVALS_PATH,
  APPROVED_REASON,
  DENIED_REASON,
  EXPIRED_REASON,
  INFRA_FAILURE_REASON,
  resolveConsoleConfig,
  buildApprovalsUrl,
  buildApprovalStatusUrl,
  hashToolInput,
  deriveIdempotencyKey,
  nextBackoffDelay,
  runConsoleGatedApproval,
  consoleGatedApproval,
} from "../agent/lib/console_gated_approval.core.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
};

// A fake transport that records every call and replies from a queue of
// responders (one per call; the last responder repeats if the queue runs
// dry) — lets a single test drive POST-then-multiple-GETs deterministically.
function fakeTransport(...responders) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url, init });
    const responder = responders[Math.min(i, responders.length - 1)];
    i += 1;
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

// A fake sleep that never really waits — records the requested delay so
// backoff-sequence tests can assert on it without the test taking minutes.
function fakeSleep() {
  const delays = [];
  const fn = async (ms) => {
    delays.push(ms);
  };
  fn.delays = delays;
  return fn;
}

// A fake clock: starts at t0 and advances by `stepMs` on every call after
// the first (call 1 returns t0, establishing the deadline; later calls
// simulate elapsed time). Advancing a huge step lets the TTL test jump past
// the 30-minute deadline without any real waiting.
function fakeClock(startMs, stepMs = 0) {
  let calls = 0;
  return () => {
    const t = startMs + calls * stepMs;
    calls += 1;
    return t;
  };
}

// ---------------------------------------------------------------------------
// resolveConsoleConfig / buildApprovalsUrl / buildApprovalStatusUrl
// ---------------------------------------------------------------------------

test("resolveConsoleConfig resolves + trims + de-slashes when both vars are set", () => {
  const cfg = resolveConsoleConfig({
    JACE_CONSOLE_BASE_URL: "  https://c.example.com/  ",
    JACE_CONSOLE_TOKEN: "  tok  ",
  });
  assert.deepEqual(cfg, { ok: true, baseUrl: "https://c.example.com", token: "tok" });
});

test("resolveConsoleConfig reports exactly which vars are missing", () => {
  assert.deepEqual(resolveConsoleConfig({}), {
    ok: false,
    missing: ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"],
  });
  assert.deepEqual(resolveConsoleConfig({ JACE_CONSOLE_BASE_URL: "https://c" }), {
    ok: false,
    missing: ["JACE_CONSOLE_TOKEN"],
  });
});

test("buildApprovalsUrl joins the base url and the approvals path", () => {
  assert.equal(buildApprovalsUrl("https://c.example.com"), `https://c.example.com${APPROVALS_PATH}`);
  assert.equal(APPROVALS_PATH, "/api/v1/runner/approvals");
});

test("buildApprovalStatusUrl joins the base url, the approvals path, and the approvalId", () => {
  assert.equal(
    buildApprovalStatusUrl("https://c.example.com", "approval-1"),
    `https://c.example.com${APPROVALS_PATH}/approval-1`
  );
});

test("buildApprovalStatusUrl encodes an approvalId that needs it", () => {
  assert.equal(
    buildApprovalStatusUrl("https://c.example.com", "a/b c"),
    `https://c.example.com${APPROVALS_PATH}/a%2Fb%20c`
  );
});

// ---------------------------------------------------------------------------
// hashToolInput / deriveIdempotencyKey
// ---------------------------------------------------------------------------

test("hashToolInput is deterministic for the same logical input", () => {
  const a = hashToolInput({ title: "Add dark mode", acceptanceCriteria: ["x"] });
  const b = hashToolInput({ title: "Add dark mode", acceptanceCriteria: ["x"] });
  assert.equal(a, b);
});

test("hashToolInput differs for different input", () => {
  const a = hashToolInput({ title: "Add dark mode" });
  const b = hashToolInput({ title: "Add light mode" });
  assert.notEqual(a, b);
});

test("hashToolInput treats undefined/null the same as an empty object", () => {
  assert.equal(hashToolInput(undefined), hashToolInput({}));
  assert.equal(hashToolInput(null), hashToolInput({}));
});

test("deriveIdempotencyKey is STABLE across retries of the same logical call (same session/turn/tool/input)", () => {
  const args = {
    eveSessionId: "eve-session-1",
    turnId: "turn-1",
    toolName: "create_issue",
    toolInput: { title: "Add dark mode" },
  };
  assert.equal(deriveIdempotencyKey(args), deriveIdempotencyKey({ ...args }));
});

test("deriveIdempotencyKey is DISTINCT across a genuinely new call — different toolInput within the SAME turn", () => {
  // The collision this guards against: the model calling the same gated tool
  // twice in one turn (e.g. two different create_issue calls for two
  // different slices) must never be treated as a retry of each other, or a
  // human's approval of slice 1 would silently rubber-stamp slice 2 too.
  const base = { eveSessionId: "eve-session-1", turnId: "turn-1", toolName: "create_issue" };
  const keyA = deriveIdempotencyKey({ ...base, toolInput: { title: "Slice A" } });
  const keyB = deriveIdempotencyKey({ ...base, toolInput: { title: "Slice B" } });
  assert.notEqual(keyA, keyB);
});

test("deriveIdempotencyKey is DISTINCT across different turns (same tool/input, new turn)", () => {
  const base = { eveSessionId: "eve-session-1", toolName: "create_issue", toolInput: { title: "x" } };
  const keyTurn1 = deriveIdempotencyKey({ ...base, turnId: "turn-1" });
  const keyTurn2 = deriveIdempotencyKey({ ...base, turnId: "turn-2" });
  assert.notEqual(keyTurn1, keyTurn2);
});

test("deriveIdempotencyKey is DISTINCT across different sessions and different tools", () => {
  const base = { turnId: "turn-1", toolInput: { title: "x" } };
  const bySession = deriveIdempotencyKey({ ...base, eveSessionId: "s1", toolName: "create_issue" });
  const byOtherSession = deriveIdempotencyKey({ ...base, eveSessionId: "s2", toolName: "create_issue" });
  const byOtherTool = deriveIdempotencyKey({ ...base, eveSessionId: "s1", toolName: "create_workspace" });
  assert.notEqual(bySession, byOtherSession);
  assert.notEqual(bySession, byOtherTool);
});

// ---------------------------------------------------------------------------
// nextBackoffDelay — 2s -> 5s -> 10s cap, jittered
// ---------------------------------------------------------------------------

test("nextBackoffDelay follows the 2s -> 5s -> 10s(cap) sequence, each within [base, base+250ms) jitter", () => {
  const d0 = nextBackoffDelay(0);
  const d1 = nextBackoffDelay(1);
  const d2 = nextBackoffDelay(2);
  const d5 = nextBackoffDelay(5); // beyond the sequence length — stays capped at 10s
  assert.ok(d0 >= 2000 && d0 < 2250, `attempt 0 delay ${d0} out of [2000,2250)`);
  assert.ok(d1 >= 5000 && d1 < 5250, `attempt 1 delay ${d1} out of [5000,5250)`);
  assert.ok(d2 >= 10000 && d2 < 10250, `attempt 2 delay ${d2} out of [10000,10250)`);
  assert.ok(d5 >= 10000 && d5 < 10250, `attempt 5 delay ${d5} out of [10000,10250) (cap)`);
});

// ---------------------------------------------------------------------------
// runConsoleGatedApproval — body shape, config, POST-time terminal statuses
// ---------------------------------------------------------------------------

const BASE_ARGS = {
  eveSessionId: "eve-session-1",
  toolName: "create_issue",
  toolInput: { title: "Add dark mode" },
  idempotencyKey: "eve-session-1:turn-1:create_issue:abc123",
};

test("resolves APPROVED immediately from the POST response with no GET at all (idempotent-replay-already-approved)", async () => {
  const transport = fakeTransport(async () => ({
    status: 201,
    json: async () => ({ approvalId: "approval-1", status: "approved" }),
  }));
  const sleep = fakeSleep();

  const result = await runConsoleGatedApproval({
    ...BASE_ARGS,
    env: ENV,
    transport,
    sleep,
    now: fakeClock(0, 1000),
  });

  assert.deepEqual(result, { type: "approved", reason: APPROVED_REASON });
  assert.equal(transport.calls.length, 1); // POST only
  assert.equal(sleep.delays.length, 0);

  const { url, init } = transport.calls[0];
  assert.equal(url, `https://console.example.com${APPROVALS_PATH}`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer tok-secret-123");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), {
    eveSessionId: "eve-session-1",
    toolName: "create_issue",
    toolInput: { title: "Add dark mode" },
    idempotencyKey: "eve-session-1:turn-1:create_issue:abc123",
  });
});

test("resolves DENIED immediately from the POST response with no GET at all (idempotent-replay-already-denied)", async () => {
  const transport = fakeTransport(async () => ({
    status: 201,
    json: async () => ({ approvalId: "approval-1", status: "denied" }),
  }));
  const result = await runConsoleGatedApproval({
    ...BASE_ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, { type: "denied", reason: DENIED_REASON });
  assert.equal(transport.calls.length, 1);
});

test("resolves DENIED with the expiry reason immediately from the POST response (idempotent-replay-already-expired)", async () => {
  const transport = fakeTransport(async () => ({
    status: 201,
    json: async () => ({ approvalId: "approval-1", status: "expired" }),
  }));
  const result = await runConsoleGatedApproval({
    ...BASE_ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, { type: "denied", reason: EXPIRED_REASON });
  assert.equal(transport.calls.length, 1);
});

// ---------------------------------------------------------------------------
// runConsoleGatedApproval — the poll loop
// ---------------------------------------------------------------------------

test("a broken clock that never advances (now() always returns the same value) still terminates — MAX_POLL_ATTEMPTS backstop, not just the TTL", async () => {
  // A clock this broken can never trip the TTL comparison (now() >= deadline
  // never becomes true), and this transport never resolves to a terminal
  // status either — the ONLY thing that can stop this loop is the hard
  // iteration ceiling. This is a direct regression test for the bug an
  // earlier draft of this same suite hit for real (a zero-step fake clock
  // paired with an always-pending transport spun until the test process
  // ran out of heap) — see MAX_POLL_ATTEMPTS' own comment in the source.
  const transport = fakeTransport(
    async () => ({ status: 201, json: async () => ({ approvalId: "approval-1", status: "pending" }) }),
    async () => ({ status: 200, json: async () => ({ status: "pending" }) })
  );
  const result = await runConsoleGatedApproval({
    ...BASE_ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: () => 0, // never advances — TTL math alone can never end this loop
  });
  assert.deepEqual(result, { type: "denied", reason: EXPIRED_REASON });
});

test("polls GET with backoff until approved — pending twice then approved", async () => {
  const transport = fakeTransport(
    async () => ({ status: 201, json: async () => ({ approvalId: "approval-1", status: "pending" }) }),
    async () => ({ status: 200, json: async () => ({ status: "pending" }) }),
    async () => ({ status: 200, json: async () => ({ status: "pending" }) }),
    async () => ({ status: 200, json: async () => ({ status: "approved" }) })
  );
  const sleep = fakeSleep();

  const result = await runConsoleGatedApproval({
    ...BASE_ARGS,
    env: ENV,
    transport,
    sleep,
    now: fakeClock(0, 1000),
  });

  assert.deepEqual(result, { type: "approved", reason: APPROVED_REASON });
  assert.equal(transport.calls.length, 4); // POST + 3 GETs
  assert.equal(sleep.delays.length, 3);
  assert.ok(sleep.delays[0] >= 2000 && sleep.delays[0] < 2250, `${sleep.delays[0]}`);
  assert.ok(sleep.delays[1] >= 5000 && sleep.delays[1] < 5250, `${sleep.delays[1]}`);
  assert.ok(sleep.delays[2] >= 10000 && sleep.delays[2] < 10250, `${sleep.delays[2]}`);

  // Each GET must hit the status endpoint with the approvalId from the POST,
  // bearer-authenticated the same as the POST.
  const getCall = transport.calls[1];
  assert.equal(getCall.url, `https://console.example.com${APPROVALS_PATH}/approval-1`);
  assert.equal(getCall.init.method, "GET");
  assert.equal(getCall.init.headers.Authorization, "Bearer tok-secret-123");
});

test("polls GET until denied", async () => {
  const transport = fakeTransport(
    async () => ({ status: 201, json: async () => ({ approvalId: "approval-1", status: "pending" }) }),
    async () => ({ status: 200, json: async () => ({ status: "denied" }) })
  );
  const result = await runConsoleGatedApproval({
    ...BASE_ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, { type: "denied", reason: DENIED_REASON });
});

test("TTL exceeded -> denied with the expiry reason, no throw, no infinite loop", async () => {
  const transport = fakeTransport(
    async () => ({ status: 201, json: async () => ({ approvalId: "approval-1", status: "pending" }) }),
    async () => ({ status: 200, json: async () => ({ status: "pending" }) })
  );
  const sleep = fakeSleep();
  // First now() call establishes the deadline (t=0 -> deadline = 30min).
  // Advance by 20 minutes each subsequent call so the THIRD check (after one
  // full pending poll) is already past the 30-minute deadline.
  const now = fakeClock(0, 20 * 60 * 1000);

  const result = await runConsoleGatedApproval({
    ...BASE_ARGS,
    env: ENV,
    transport,
    sleep,
    now,
  });

  assert.deepEqual(result, { type: "denied", reason: EXPIRED_REASON });
});

// ---------------------------------------------------------------------------
// runConsoleGatedApproval — infrastructure failure paths (fail closed)
// ---------------------------------------------------------------------------

test("config missing -> denied, transport never called", async () => {
  const transport = fakeTransport(async () => ({ status: 201, json: async () => ({}) }));
  const result = await runConsoleGatedApproval({ ...BASE_ARGS, env: {}, transport, sleep: fakeSleep() });
  assert.deepEqual(result, { type: "denied", reason: INFRA_FAILURE_REASON });
  assert.equal(transport.calls.length, 0);
});

test("POST transport throws (network error) -> denied, single attempt, no poll", async () => {
  const transport = fakeTransport(async () => {
    throw new Error("ECONNREFUSED 10.0.0.1:443 — secret-looking internal detail");
  });
  const result = await runConsoleGatedApproval({
    ...BASE_ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, { type: "denied", reason: INFRA_FAILURE_REASON });
  assert.equal(transport.calls.length, 1);
});

test("POST non-2xx -> denied", async () => {
  for (const status of [400, 401, 404, 500]) {
    const transport = fakeTransport(async () => ({ status, json: async () => ({}) }));
    const result = await runConsoleGatedApproval({
      ...BASE_ARGS,
      env: ENV,
      transport,
      sleep: fakeSleep(),
      now: fakeClock(0, 1000),
    });
    assert.deepEqual(result, { type: "denied", reason: INFRA_FAILURE_REASON }, `status ${status}`);
  }
});

test("POST 200 with non-JSON body -> denied", async () => {
  const transport = fakeTransport(async () => ({
    status: 201,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  }));
  const result = await runConsoleGatedApproval({
    ...BASE_ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, { type: "denied", reason: INFRA_FAILURE_REASON });
});

test("POST 200 with a body missing approvalId/status -> denied", async () => {
  const transport = fakeTransport(async () => ({ status: 201, json: async () => ({ approvalId: "a1" }) }));
  const result = await runConsoleGatedApproval({
    ...BASE_ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, { type: "denied", reason: INFRA_FAILURE_REASON });
});

test("GET transport throws mid-poll -> denied, does not keep retrying", async () => {
  const transport = fakeTransport(
    async () => ({ status: 201, json: async () => ({ approvalId: "approval-1", status: "pending" }) }),
    async () => {
      throw new Error("socket hang up");
    }
  );
  const result = await runConsoleGatedApproval({
    ...BASE_ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, { type: "denied", reason: INFRA_FAILURE_REASON });
  assert.equal(transport.calls.length, 2); // POST + the one failing GET, no third call
});

test("GET non-2xx mid-poll -> denied", async () => {
  const transport = fakeTransport(
    async () => ({ status: 201, json: async () => ({ approvalId: "approval-1", status: "pending" }) }),
    async () => ({ status: 500, json: async () => ({}) })
  );
  const result = await runConsoleGatedApproval({
    ...BASE_ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, { type: "denied", reason: INFRA_FAILURE_REASON });
});

test("GET 200 with a malformed/missing status mid-poll -> denied", async () => {
  const transport = fakeTransport(
    async () => ({ status: 201, json: async () => ({ approvalId: "approval-1", status: "pending" }) }),
    async () => ({ status: 200, json: async () => ({}) })
  );
  const result = await runConsoleGatedApproval({
    ...BASE_ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, { type: "denied", reason: INFRA_FAILURE_REASON });
});

test("blank eveSessionId/toolName/idempotencyKey -> denied, transport never called (defensive)", async () => {
  const transport = fakeTransport(async () => ({ status: 201, json: async () => ({}) }));
  const result = await runConsoleGatedApproval({
    eveSessionId: "  ",
    toolName: "create_issue",
    toolInput: {},
    idempotencyKey: "k",
    env: ENV,
    transport,
    sleep: fakeSleep(),
  });
  assert.deepEqual(result, { type: "denied", reason: INFRA_FAILURE_REASON });
  assert.equal(transport.calls.length, 0);
});

test("an unexpected internal throw (a broken injected fake) still resolves to denied, never propagates", async () => {
  const transport = () => {
    throw "not even an Error instance"; // eslint-disable-line no-throw-literal
  };
  const result = await runConsoleGatedApproval({
    ...BASE_ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, { type: "denied", reason: INFRA_FAILURE_REASON });
});

// ---------------------------------------------------------------------------
// no secrets in any reason string, ever
// ---------------------------------------------------------------------------

test("no reason string ever carries the bearer token or the console base URL", async () => {
  const cases = [
    async () =>
      runConsoleGatedApproval({ ...BASE_ARGS, env: {}, transport: fakeTransport(), sleep: fakeSleep() }),
    async () =>
      runConsoleGatedApproval({
        ...BASE_ARGS,
        env: ENV,
        transport: fakeTransport(async () => ({ status: 500, json: async () => ({}) })),
        sleep: fakeSleep(),
        now: fakeClock(0, 1000),
      }),
    async () =>
      runConsoleGatedApproval({
        ...BASE_ARGS,
        env: ENV,
        transport: fakeTransport(async () => ({ status: 201, json: async () => ({ approvalId: "a1", status: "denied" }) })),
        sleep: fakeSleep(),
        now: fakeClock(0, 1000),
      }),
  ];
  for (const run of cases) {
    const result = await run();
    assert.doesNotMatch(result.reason, /tok-secret-123/);
    assert.doesNotMatch(result.reason, /console\.example\.com/);
  }
});

// ---------------------------------------------------------------------------
// consoleGatedApproval(ctx) — the thin wrapper the tools actually wire
// ---------------------------------------------------------------------------

function fakeCtx({ sessionId = "eve-session-1", turnId = "turn-1", toolName = "create_issue", toolInput = { title: "x" } } = {}) {
  return {
    session: { id: sessionId, turn: { id: turnId, sequence: 1 }, auth: { current: null, initiator: null } },
    toolName,
    toolInput,
    approvedTools: new Set(),
  };
}

test("consoleGatedApproval(ctx) extracts session.id/toolName/toolInput/session.turn.id and derives the same idempotencyKey deriveIdempotencyKey would", async () => {
  const ctx = fakeCtx();
  const transport = fakeTransport(async () => ({
    status: 201,
    json: async () => ({ approvalId: "approval-1", status: "approved" }),
  }));

  await consoleGatedApproval(ctx, { env: ENV, transport, sleep: fakeSleep(), now: fakeClock(0, 1000) });

  const { init } = transport.calls[0];
  const sentBody = JSON.parse(init.body);
  assert.equal(sentBody.eveSessionId, "eve-session-1");
  assert.equal(sentBody.toolName, "create_issue");
  assert.deepEqual(sentBody.toolInput, { title: "x" });
  assert.equal(
    sentBody.idempotencyKey,
    deriveIdempotencyKey({
      eveSessionId: "eve-session-1",
      turnId: "turn-1",
      toolName: "create_issue",
      toolInput: { title: "x" },
    })
  );
});

test("consoleGatedApproval(ctx) resolves approved/denied per the console's decision, end to end", async () => {
  const approvedTransport = fakeTransport(async () => ({
    status: 201,
    json: async () => ({ approvalId: "approval-1", status: "approved" }),
  }));
  const approved = await consoleGatedApproval(fakeCtx(), {
    env: ENV,
    transport: approvedTransport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(approved, { type: "approved", reason: APPROVED_REASON });

  const deniedTransport = fakeTransport(async () => ({
    status: 201,
    json: async () => ({ approvalId: "approval-2", status: "denied" }),
  }));
  const denied = await consoleGatedApproval(fakeCtx(), {
    env: ENV,
    transport: deniedTransport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(denied, { type: "denied", reason: DENIED_REASON });
});

test("consoleGatedApproval NEVER throws, even given a malformed/empty ctx", async () => {
  for (const badCtx of [{}, { session: {} }, { session: { id: "s" } }, null, undefined]) {
    const result = await consoleGatedApproval(badCtx, { env: ENV, transport: fakeTransport(), sleep: fakeSleep() });
    assert.equal(result.type, "denied");
    assert.equal(typeof result.reason, "string");
  }
});

test("consoleGatedApproval(ctx) with NO overrides at all — the real production call shape — never throws even with empty real env", async () => {
  const ORIGINAL_BASE = process.env.JACE_CONSOLE_BASE_URL;
  const ORIGINAL_TOKEN = process.env.JACE_CONSOLE_TOKEN;
  delete process.env.JACE_CONSOLE_BASE_URL;
  delete process.env.JACE_CONSOLE_TOKEN;
  try {
    const result = await consoleGatedApproval(fakeCtx());
    assert.deepEqual(result, { type: "denied", reason: INFRA_FAILURE_REASON });
  } finally {
    if (ORIGINAL_BASE === undefined) delete process.env.JACE_CONSOLE_BASE_URL;
    else process.env.JACE_CONSOLE_BASE_URL = ORIGINAL_BASE;
    if (ORIGINAL_TOKEN === undefined) delete process.env.JACE_CONSOLE_TOKEN;
    else process.env.JACE_CONSOLE_TOKEN = ORIGINAL_TOKEN;
  }
});
