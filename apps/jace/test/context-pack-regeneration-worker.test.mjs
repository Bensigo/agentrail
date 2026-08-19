import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContextPackRegenerationWorker } from "../agent/lib/context_pack_regeneration_worker.core.mjs";
import {
  EXECUTION_REQUEST_TIMEOUT_MS,
  assertContextPackRegenerationWorkerConfig,
  assertContextPackRegenerationWorkerCredentialIsolation,
  claimContextPackRegeneration,
  executeContextPackRegeneration,
  renewContextPackRegenerationLease,
} from "../agent/lib/context_pack_regeneration_console.mjs";

test("execution transport outlives the bounded server execution budget", () => {
  assert.ok(EXECUTION_REQUEST_TIMEOUT_MS > 6 * 60 * 1000);
});

test("startup validates the complete worker configuration before polling", () => {
  assert.deepEqual(assertContextPackRegenerationWorkerConfig({
    JACE_CONSOLE_BASE_URL: "https://console.example",
    JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN: "worker-secret",
  }), {
    baseUrl: "https://console.example",
    token: "worker-secret",
  });
  assert.throws(
    () => assertContextPackRegenerationWorkerConfig({
      JACE_CONSOLE_BASE_URL: "ftp://console.example",
      JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN: "worker-secret",
    }),
    /not configured/u,
  );
});

test("idle polling does not execute", async () => {
  let executions = 0;
  const worker = createContextPackRegenerationWorker({ claim: async () => null, execute: async () => { executions += 1; } });
  assert.equal(await worker.runOnce(), null);
  assert.equal(executions, 0);
});

test("one claim triggers one opaque execution", async () => {
  const claim = { executionId: "e", workerId: "w", leaseToken: "t" };
  const seen = [];
  const worker = createContextPackRegenerationWorker({ claim: async () => claim, execute: async (value) => { seen.push(value); return "done"; } });
  assert.equal(await worker.runOnce(), "done");
  assert.deepEqual(seen, [claim]);
});

test("slow valid execution renews its opaque lease before returning", async () => {
  const claim = { executionId: "e", workerId: "w", leaseToken: "t" };
  const events = [];
  let renewalTick;
  let finishExecution;
  const executionDone = new Promise((resolve) => { finishExecution = resolve; });
  const worker = createContextPackRegenerationWorker({
    claim: async () => claim,
    execute: async () => {
      events.push("execute-started");
      await executionDone;
      events.push("execute-finished");
      return "done";
    },
    renew: async (value) => {
      events.push(`renewed:${value.executionId}`);
    },
    renewIntervalMs: 30_000,
    setIntervalFn: (callback) => {
      renewalTick = callback;
      return 1;
    },
    clearIntervalFn: () => { events.push("renewals-cleared"); },
  });
  const running = worker.runOnce();
  await Promise.resolve();
  await renewalTick();
  await renewalTick();
  finishExecution();
  assert.equal(await running, "done");
  assert.deepEqual(events, [
    "execute-started",
    "renewed:e",
    "renewed:e",
    "execute-finished",
    "renewals-cleared",
  ]);
});

test("transport sends only worker identity for claim and opaque lease for execution", async () => {
  const calls = [];
  const env = { JACE_CONSOLE_BASE_URL: "https://console.example", JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN: "secret" };
  const claimBody = { claim: {
    executionId: "11111111-1111-4111-8111-111111111111",
    workerId: "w",
    leaseToken: "a".repeat(43),
    attemptCount: 1,
    leaseExpiresAt: "2026-08-14T06:00:00.000Z",
  } };
  const transport = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), redirect: init.redirect, authorization: init.headers.Authorization });
    return Response.json(calls.length === 1
      ? claimBody
      : calls.length === 2
        ? { renewed: { leaseExpiresAt: "2026-08-14T06:01:00.000Z" } }
        : { result: { kind: "completed", status: "replaced" } });
  };
  const claim = await claimContextPackRegeneration({ workerId: "w", env, transport });
  await renewContextPackRegenerationLease({ claim, env, transport });
  await executeContextPackRegeneration({ claim, env, transport });
  assert.deepEqual(calls.map(({ body }) => body), [
    { workerId: "w" },
    { executionId: claimBody.claim.executionId, workerId: "w", leaseToken: claimBody.claim.leaseToken },
    { executionId: claimBody.claim.executionId, workerId: "w", leaseToken: claimBody.claim.leaseToken },
  ]);
  assert.deepEqual(calls.map(({ redirect }) => redirect), ["error", "error", "error"]);
  assert.deepEqual(calls.map(({ authorization }) => authorization), ["Bearer secret", "Bearer secret", "Bearer secret"]);
});

test("console configuration rejects unsafe bearer destinations and oversized tokens", async () => {
  for (const env of [
    { JACE_CONSOLE_BASE_URL: "ftp://console.example", JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN: "secret" },
    { JACE_CONSOLE_BASE_URL: "https://user@console.example", JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN: "secret" },
    { JACE_CONSOLE_BASE_URL: "https://console.example?next=other", JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN: "secret" },
    { JACE_CONSOLE_BASE_URL: "https://console.example", JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN: "x".repeat(4097) },
  ]) await assert.rejects(claimContextPackRegeneration({
    workerId: "w",
    env,
    transport: async () => { throw new Error("must not transport"); },
  }), /not configured/);
});

test("worker credential isolation rejects an environment containing the broad coordinator token", async () => {
  const env = {
    JACE_CONSOLE_BASE_URL: "https://console.example",
    JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN: "worker-secret",
    JACE_CONSOLE_TOKEN: "broad-secret-must-not-enter-worker",
  };
  assert.throws(
    () => assertContextPackRegenerationWorkerCredentialIsolation(env),
    (error) => error instanceof Error
      && /broad Jace coordinator credential/u.test(error.message)
      && !error.message.includes(env.JACE_CONSOLE_TOKEN),
  );
  await assert.rejects(claimContextPackRegeneration({
    workerId: "w",
    env,
    transport: async () => { throw new Error("must not transport"); },
  }), /broad Jace coordinator credential/);
});

test("persistent worker authentication failure stops polling and surfaces", async () => {
  const env = {
    JACE_CONSOLE_BASE_URL: "https://console.example",
    JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN: "wrong-secret",
  };
  let failure;
  try {
    await claimContextPackRegeneration({
      workerId: "w",
      env,
      transport: async () => Response.json({ error: "Unauthorized" }, { status: 401 }),
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  let timerCalls = 0;
  const worker = createContextPackRegenerationWorker({
    claim: async () => { throw failure; },
    execute: async () => { throw new Error("must not execute"); },
    setTimer: () => { timerCalls += 1; },
  });
  await assert.rejects(worker.start(), /authentication failed/u);
  assert.equal(timerCalls, 0);
});

test("claim rejects declared and streamed oversized responses", async () => {
  const env = { JACE_CONSOLE_BASE_URL: "https://console.example", JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN: "secret" };
  await assert.rejects(claimContextPackRegeneration({
    workerId: "w",
    env,
    transport: async () => new Response("{}", { status: 200, headers: { "content-length": "2049" } }),
  }), /byte limit/);
  await assert.rejects(claimContextPackRegeneration({
    workerId: "w",
    env,
    transport: async () => new Response(JSON.stringify({ claim: { padding: "x".repeat(4096) } }), { status: 200 }),
  }), /byte limit/);
});

test("claim rejects malformed, cross-worker, or extra fields", async () => {
  const env = { JACE_CONSOLE_BASE_URL: "https://console.example", JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN: "secret" };
  const valid = {
    executionId: "11111111-1111-4111-8111-111111111111",
    workerId: "w",
    leaseToken: "a".repeat(43),
    attemptCount: 1,
    leaseExpiresAt: "2026-08-14T06:00:00.000Z",
  };
  for (const claim of [
    { ...valid, executionId: "chosen" },
    { ...valid, workerId: "other" },
    { ...valid, workspaceId: "leaked" },
  ]) {
    await assert.rejects(claimContextPackRegeneration({
      workerId: "w",
      env,
      transport: async () => Response.json({ claim }),
    }), /claim response was invalid/);
  }
});

test("execute rejects oversized or widened terminal responses", async () => {
  const env = { JACE_CONSOLE_BASE_URL: "https://console.example", JACE_CONTEXT_PACK_REGENERATION_WORKER_TOKEN: "secret" };
  const claim = {
    executionId: "11111111-1111-4111-8111-111111111111",
    workerId: "w",
    leaseToken: "a".repeat(43),
  };
  await assert.rejects(executeContextPackRegeneration({
    claim,
    env,
    transport: async () => new Response(JSON.stringify({ result: { padding: "x".repeat(4096) } }), { status: 200 }),
  }), /byte limit/);
  await assert.rejects(executeContextPackRegeneration({
    claim,
    env,
    transport: async () => Response.json({ result: { kind: "completed", status: "replaced", recordId: "leaked" } }),
  }), /execution response was invalid/);
});

test("standalone worker is default-off and not launched inside Eve instrumentation", async () => {
  const [entrypoint, instrumentation, dockerfile] = await Promise.all([
    readFile(new URL("../scripts/context-pack-regeneration-worker.mjs", import.meta.url), "utf8"),
    readFile(new URL("../agent/instrumentation.ts", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
  ]);
  assert.match(entrypoint, /JACE_CONTEXT_PACK_REGENERATION_WORKER/);
  assert.match(entrypoint, /!== "1"/);
  assert.match(entrypoint, /assertContextPackRegenerationWorkerConfig\(process\.env\)[\s\S]*buildContextPackRegenerationWorker\(process\.env\)\.start\(\)/u);
  assert.doesNotMatch(instrumentation, /context_pack_regeneration_worker/);
  assert.match(dockerfile, /COPY --from=builder \/app\/scripts \.\/scripts/u);
});
