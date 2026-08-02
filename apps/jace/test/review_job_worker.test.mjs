// Unit tests for the Arc B headless review-job worker's ASSEMBLER:
// apps/jace/agent/lib/review_job_worker.mjs. This file wires
// review_job_worker.core.mjs's pure loop to real transports
// (review_job_console.mjs) and a real eve session (eve/client) — see its own
// header comment for the full "session-minting problem" this resolves.
//
// ARC B REVIEW FIX WAVE (per-job session restructure): `claim` no longer
// carries or receives an `eveSessionId` — the core now calls it with NO
// arguments at all, and `createClaimFn`'s closure only needs to curry its
// own configured `workerId`. A NEW `createBindFn` curries the job/session
// pairing into a `bind({jobId, eveSessionId})` call instead, made AFTER a
// session is opened for an actual claimed job.
//
// `startReviewJobWorker` itself constructs a REAL `eve/client` `Client` and,
// on success, starts a REAL setInterval — calling it in a test would leave a
// live timer running (node --test does not wait for it, but it keeps the
// process alive) and would attempt real network calls the moment the
// interval first fires. So, exactly like discord-gateway-wiring.test.mjs
// tests agent/lib/discord-gateway.mjs (which opens a real socket on call),
// `startReviewJobWorker`'s OWN body is tested STRUCTURALLY (read the source,
// assert on its shape) rather than executed. Its separable, injectable
// pieces — buildWorkerId, createClaimFn, createBindFn, createCompleteFn,
// createOpenSessionFn — are fully exercised behaviorally with fakes, since
// none of them touch a real network or a real timer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EVE_HOST,
  SESSION_CREATE_TIMEOUT_MS,
  SESSION_BOOTSTRAP_SCHEMA,
  buildWorkerId,
  createClaimFn,
  createBindFn,
  createCompleteFn,
  createOpenSessionFn,
  resolveBootstrapTimeoutMs,
} from "../agent/lib/review_job_worker.mjs";

const sourcePath = fileURLToPath(new URL("../agent/lib/review_job_worker.mjs", import.meta.url));
const code = readFileSync(sourcePath, "utf8");

// ---------------------------------------------------------------------------
// buildWorkerId
// ---------------------------------------------------------------------------

test("buildWorkerId: review-worker-<hostname>-<pid>, using the injected overrides", () => {
  const id = buildWorkerId({ hostnameFn: () => "fake-host", pid: 4242 });
  assert.equal(id, "review-worker-fake-host-4242");
});

test("buildWorkerId: defaults to real os.hostname()/process.pid when not overridden (format only, values vary by machine)", () => {
  const id = buildWorkerId();
  assert.match(id, /^review-worker-.+-\d+$/);
});

// ---------------------------------------------------------------------------
// createClaimFn — fix wave: claim takes NO arguments; only workerId is curried
// ---------------------------------------------------------------------------

test("PIN: createClaimFn's closure takes no arguments and calls claimReviewJobFn with the configured workerId + env", async () => {
  const calls = [];
  const claimFn = createClaimFn({
    workerId: "review-worker-host-1-999",
    env: { JACE_CONSOLE_BASE_URL: "https://x", JACE_CONSOLE_TOKEN: "t" },
    claimReviewJobFn: async (args) => {
      calls.push(args);
      return null;
    },
  });

  // The core now calls claim() with NO arguments at all (review_job_worker.core.mjs's
  // own header comment: "no eveSessionId to carry at claim time anymore").
  await claimFn();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].workerId, "review-worker-host-1-999");
  assert.ok(!("eveSessionId" in calls[0]), "claim no longer carries an eveSessionId — that moved to bind()");
});

test("createClaimFn: forwards its configured env through unchanged", async () => {
  const env = { JACE_CONSOLE_BASE_URL: "https://x", JACE_CONSOLE_TOKEN: "t" };
  const calls = [];
  const claimFn = createClaimFn({ workerId: "w1", env, claimReviewJobFn: async (args) => calls.push(args) });
  await claimFn();
  assert.equal(calls[0].env, env);
});

test("createClaimFn: returns whatever the underlying claimReviewJobFn resolves (a job or null), unmodified", async () => {
  const job = { id: "job-1", repo: "a/b", prNumber: 1, headSha: "sha", event: "opened", workspaceId: "ws" };
  const claimFn = createClaimFn({ workerId: "w1", env: {}, claimReviewJobFn: async () => job });
  assert.deepEqual(await claimFn(), job);
});

test("createClaimFn: defaults claimReviewJobFn to the real claimReviewJob when not overridden", async () => {
  // Missing console config -> the real claimReviewJob throws fast, before
  // any network call — proves the default wiring reaches the real function
  // rather than silently no-op'ing.
  const claimFn = createClaimFn({ workerId: "w1", env: {} });
  await assert.rejects(() => claimFn(), /JACE_CONSOLE_BASE_URL/);
});

// ---------------------------------------------------------------------------
// createBindFn — NEW (fix wave): curries jobId/eveSessionId into bindReviewJobSession
// ---------------------------------------------------------------------------

test("PIN: createBindFn's closure calls bindReviewJobSessionFn with jobId, eveSessionId, and the configured env", async () => {
  const env = { JACE_CONSOLE_BASE_URL: "https://x", JACE_CONSOLE_TOKEN: "t" };
  const calls = [];
  const bindFn = createBindFn({ env, bindReviewJobSessionFn: async (args) => calls.push(args) });

  // The core calls bind() as `bind({jobId, eveSessionId})` (review_job_worker.core.mjs).
  await bindFn({ jobId: "job-1", eveSessionId: "session-abc" });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { jobId: "job-1", eveSessionId: "session-abc", env });
});

test("createBindFn: propagates the underlying bindReviewJobSessionFn's rejection unchanged (the core's bind() try/catch depends on this)", async () => {
  const bindFn = createBindFn({
    env: {},
    bindReviewJobSessionFn: async () => {
      throw new Error("console returned 409");
    },
  });
  await assert.rejects(() => bindFn({ jobId: "job-1", eveSessionId: "s1" }), /409/);
});

test("createBindFn: defaults bindReviewJobSessionFn to the real bindReviewJobSession when not overridden", async () => {
  const bindFn = createBindFn({ env: {} });
  await assert.rejects(() => bindFn({ jobId: "job-1", eveSessionId: "s1" }), /JACE_CONSOLE_BASE_URL/);
});

// ---------------------------------------------------------------------------
// createCompleteFn
// ---------------------------------------------------------------------------

test("createCompleteFn: forwards the core's complete(fields) call plus its configured env, unchanged", async () => {
  const env = { JACE_CONSOLE_BASE_URL: "https://x", JACE_CONSOLE_TOKEN: "t" };
  const calls = [];
  const completeFn = createCompleteFn({ env, completeReviewJobFn: async (args) => calls.push(args) });
  await completeFn({ jobId: "job-1", outcome: "posted", postedReviewUrl: "https://x/pr/1", verdict: "approve", summaryLine: "line" });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    jobId: "job-1",
    outcome: "posted",
    postedReviewUrl: "https://x/pr/1",
    verdict: "approve",
    summaryLine: "line",
    env,
  });
});

test("createCompleteFn: defaults completeReviewJobFn to the real completeReviewJob when not overridden", async () => {
  const completeFn = createCompleteFn({ env: {} });
  await assert.rejects(
    () => completeFn({ jobId: "job-1", outcome: "failed", error: "x" }),
    /JACE_CONSOLE_BASE_URL/,
  );
});

// ---------------------------------------------------------------------------
// createOpenSessionFn — the session-minting bootstrap (see the module's own
// header comment, "THE SESSION-MINTING PROBLEM", for the full mechanics).
// Unaffected by the fix wave's claim/bind split — openSession() is still
// called once per claimed job, just later in the tick than before.
// ---------------------------------------------------------------------------

/** A fake eve/client-shaped Client: `.session()` returns a fake ClientSession
 * whose `.send()` resolves to a fake MessageResponse (`{ result: () => ... }`),
 * matching the REAL eve/client shape this module drives. */
function fakeClient(sendImpl) {
  const sendCalls = [];
  return {
    sendCalls,
    session() {
      return {
        send: async (args) => {
          sendCalls.push(args);
          return { result: async () => sendImpl(args, sendCalls.length) };
        },
      };
    },
  };
}

test("createOpenSessionFn: happy path — bootstraps with the dedicated schema, returns {id, send, close} using the bootstrap's sessionId", async () => {
  const client = fakeClient(() => ({ status: "completed", sessionId: "sess-1", data: { ready: true } }));
  const openSession = createOpenSessionFn({ client });

  const session = await openSession();

  assert.equal(session.id, "sess-1");
  assert.equal(typeof session.send, "function");
  assert.equal(typeof session.close, "function");

  // The bootstrap call itself used the dedicated schema + a signal, not the
  // (unknown-at-open-time) review prompt.
  assert.equal(client.sendCalls.length, 1);
  assert.equal(client.sendCalls[0].outputSchema, SESSION_BOOTSTRAP_SCHEMA);
  assert.equal(typeof client.sendCalls[0].message, "string");
  assert.ok(client.sendCalls[0].message.length > 0);
  assert.ok(client.sendCalls[0].signal instanceof AbortSignal);
});

test("createOpenSessionFn: bootstrap status !== 'completed' (e.g. 'waiting') throws — no id is trusted from a non-terminal bootstrap", async () => {
  const client = fakeClient(() => ({ status: "waiting", sessionId: "sess-1", data: undefined }));
  const openSession = createOpenSessionFn({ client });
  await assert.rejects(() => openSession(), /waiting/);
});

test("createOpenSessionFn: bootstrap status 'failed' throws", async () => {
  const client = fakeClient(() => ({ status: "failed", sessionId: undefined, data: undefined }));
  const openSession = createOpenSessionFn({ client });
  await assert.rejects(() => openSession(), /failed/);
});

test("createOpenSessionFn: a completed bootstrap with no sessionId throws (defensive — should not happen per the SDK's own contract)", async () => {
  const client = fakeClient(() => ({ status: "completed", sessionId: undefined, data: { ready: true } }));
  const openSession = createOpenSessionFn({ client });
  await assert.rejects(() => openSession());
});

test("openSession() self-timeouts: a bootstrap that never resolves rejects within timeoutMs, never hangs the tick (Task 6 brief, obligation 1)", async () => {
  const client = {
    session() {
      return { send: () => new Promise(() => {}) }; // never settles — simulates a hung network call
    },
  };
  const openSession = createOpenSessionFn({ client, timeoutMs: 20 });

  const start = Date.now();
  await assert.rejects(() => openSession(), /timed out after 20ms/);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `expected a fast bounded rejection, took ${elapsed}ms`);
});

test("the returned session's send(): forwards {message, outputSchema} to the SAME underlying session and returns result.data", async () => {
  let call = 0;
  const client = fakeClient(() => {
    call += 1;
    if (call === 1) return { status: "completed", sessionId: "sess-1", data: { ready: true } };
    return { status: "completed", sessionId: "sess-1", data: { posted: true, reviewUrl: "https://x", verdict: "approve", blockers: [], summaryLine: "line" } };
  });
  const openSession = createOpenSessionFn({ client });
  const session = await openSession();

  const result = await session.send({ message: "review this PR", outputSchema: { type: "object" } });

  assert.deepEqual(result, { posted: true, reviewUrl: "https://x", verdict: "approve", blockers: [], summaryLine: "line" });
  assert.equal(client.sendCalls.length, 2, "one bootstrap send + one real send");
  assert.deepEqual(client.sendCalls[1], { message: "review this PR", outputSchema: { type: "object" } });
});

test("the returned session's send(): throws if the review turn runs under a DIFFERENT session id than the bootstrap minted (never silently report under the wrong binding)", async () => {
  let call = 0;
  const client = fakeClient(() => {
    call += 1;
    if (call === 1) return { status: "completed", sessionId: "sess-1", data: { ready: true } };
    return { status: "completed", sessionId: "sess-DIFFERENT", data: { posted: true } };
  });
  const openSession = createOpenSessionFn({ client });
  const session = await openSession();

  await assert.rejects(
    () => session.send({ message: "m", outputSchema: {} }),
    (err) => {
      assert.match(err.message, /sess-DIFFERENT/);
      assert.match(err.message, /sess-1/);
      return true;
    },
  );
});

test("the returned session's send(): throws if the turn produced no structured data (e.g. paused/failed mid-review) instead of reporting a false success", async () => {
  let call = 0;
  const client = fakeClient(() => {
    call += 1;
    if (call === 1) return { status: "completed", sessionId: "sess-1", data: { ready: true } };
    return { status: "waiting", sessionId: "sess-1", data: undefined };
  });
  const openSession = createOpenSessionFn({ client });
  const session = await openSession();
  await assert.rejects(() => session.send({ message: "m", outputSchema: {} }), /waiting/);
});

test("the returned session's send(): throws if the turn's status is NOT 'completed' even though data happens to be present (matches the bootstrap's own strict standard — status is the source of truth, not the presence of data)", async () => {
  let call = 0;
  const client = fakeClient(() => {
    call += 1;
    if (call === 1) return { status: "completed", sessionId: "sess-1", data: { ready: true } };
    // A "waiting" turn that nonetheless carries a data payload (e.g. a
    // partial/interim structured emission) must NOT be trusted — only a
    // genuinely terminal "completed" turn is.
    return { status: "waiting", sessionId: "sess-1", data: { posted: true, reviewUrl: "https://x", verdict: "approve", blockers: [], summaryLine: "line" } };
  });
  const openSession = createOpenSessionFn({ client });
  const session = await openSession();
  await assert.rejects(() => session.send({ message: "m", outputSchema: {} }), /waiting/);
});

test("the returned session's close(): resolves without throwing (eve/client's ClientSession has no server-side close call)", async () => {
  const client = fakeClient(() => ({ status: "completed", sessionId: "sess-1", data: { ready: true } }));
  const openSession = createOpenSessionFn({ client });
  const session = await openSession();
  await assert.doesNotReject(() => session.close());
});

// ---------------------------------------------------------------------------
// startReviewJobWorker — STRUCTURAL (see this file's header comment for why
// this isn't executed: it constructs a real Client and starts a real timer).
// ---------------------------------------------------------------------------

test("imports Client from eve/client, the core factory, the prompt/schema, and the console transports (claim/bind/complete)", () => {
  assert.match(code, /import\s*{\s*Client\s*}\s*from\s*["']eve\/client["']/);
  assert.match(code, /import\s*{\s*createReviewJobWorker\s*}\s*from\s*["']\.\/review_job_worker\.core\.mjs["']/);
  assert.match(code, /reviewJobPrompt/);
  assert.match(code, /REVIEW_JOB_RESULT_SCHEMA/);
  assert.match(code, /claimReviewJob/);
  assert.match(code, /bindReviewJobSession/);
  assert.match(code, /completeReviewJob/);
});

test("startReviewJobWorker wires bind: into the factory call (fix wave — the core now has a bind seam)", () => {
  const fnMatch = code.match(/export async function startReviewJobWorker\([\s\S]*?\n\}/);
  assert.ok(fnMatch, "startReviewJobWorker function not found");
  assert.match(fnMatch[0], /\bbind:\s*createBindFn\(/);
});

test("startReviewJobWorker guards against being started twice in the same process", () => {
  assert.match(code, /\bstarted\b/);
  const fnMatch = code.match(/export async function startReviewJobWorker\([\s\S]*?\n\}/);
  assert.ok(fnMatch, "startReviewJobWorker function not found");
  assert.match(fnMatch[0], /if\s*\(\s*started\s*\)/);
});

test("startReviewJobWorker constructs the Client with preserveCompletedSessions: true (required for the bootstrap-then-review continuity — see header comment)", () => {
  assert.match(code, /new Client\(\{[^}]*preserveCompletedSessions:\s*true/s);
});

test("startReviewJobWorker resolves EVE_HOST from env with the needs-approval-roundtrip.mjs default (http://127.0.0.1:2000)", () => {
  assert.equal(DEFAULT_EVE_HOST, "http://127.0.0.1:2000");
  assert.match(code, /env\.EVE_HOST/);
  assert.match(code, /DEFAULT_EVE_HOST/);
});

test("startReviewJobWorker calls worker.start()", () => {
  assert.match(code, /worker\.start\(\)/);
});

test("startReviewJobWorker's body never lets a synchronous failure escape (wrapped in try/catch, mirroring startDiscordGateway's own discipline)", () => {
  const fnMatch = code.match(/export async function startReviewJobWorker\([\s\S]*?\n\}/);
  assert.ok(fnMatch);
  assert.match(fnMatch[0], /try\s*{/);
  assert.match(fnMatch[0], /catch\s*\(/);
});

test("startReviewJobWorker does NOT itself check JACE_REVIEW_WORKER — that gate lives in instrumentation.ts per the brief's literal wiring", () => {
  // A bare string ban would also trip on this module's own header comment,
  // which explains (in prose) that it deliberately does NOT check this var
  // — so assert on the absence of an actual property-access pattern instead.
  assert.doesNotMatch(code, /\benv\.JACE_REVIEW_WORKER\b/);
  assert.doesNotMatch(code, /\bprocess\.env\.JACE_REVIEW_WORKER\b/);
});

test("exports startReviewJobWorker", () => {
  assert.match(code, /export\s+async\s+function\s+startReviewJobWorker/);
});

test("SESSION_CREATE_TIMEOUT_MS is exported and larger than the house 8000ms HTTP convention (this bounds a real model turn, not a REST call)", () => {
  assert.ok(SESSION_CREATE_TIMEOUT_MS > 8000);
});

test("documents that the bootstrap now runs once per claimed job (idle ticks are model-free), per the fix-wave review", () => {
  assert.match(code, /once per (?:claimed|actual) job/i);
  assert.match(code, /idle/i);
});

test("documents the mechanism as UNVERIFIED against a live eve server and names the recommended smoke test", () => {
  assert.match(code, /UNVERIFIED/);
  assert.match(code, /smoke test/i);
});

test("documents the binding-before-real-turn invariant explicitly", () => {
  assert.match(code, /binding.*before.*(?:real )?(?:review )?turn/is);
});

test("resolveBootstrapTimeoutMs: env override wins, garbage and non-positive fall back to the 120s default (Arc B smoke fix)", () => {
  assert.equal(resolveBootstrapTimeoutMs({}), SESSION_CREATE_TIMEOUT_MS);
  assert.equal(SESSION_CREATE_TIMEOUT_MS, 120_000);
  assert.equal(resolveBootstrapTimeoutMs({ JACE_REVIEW_BOOTSTRAP_TIMEOUT_MS: "45000" }), 45000);
  assert.equal(resolveBootstrapTimeoutMs({ JACE_REVIEW_BOOTSTRAP_TIMEOUT_MS: "not-a-number" }), SESSION_CREATE_TIMEOUT_MS);
  assert.equal(resolveBootstrapTimeoutMs({ JACE_REVIEW_BOOTSTRAP_TIMEOUT_MS: "0" }), SESSION_CREATE_TIMEOUT_MS);
  assert.equal(resolveBootstrapTimeoutMs({ JACE_REVIEW_BOOTSTRAP_TIMEOUT_MS: "-5" }), SESSION_CREATE_TIMEOUT_MS);
});
