import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContextPackRegenerationWorker } from "../agent/lib/context_pack_regeneration_worker.core.mjs";
import { claimContextPackRegeneration, executeContextPackRegeneration } from "../agent/lib/context_pack_regeneration_console.mjs";

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
    return Response.json(calls.length === 1 ? claimBody : { result: { kind: "completed", status: "replaced" } });
  };
  const claim = await claimContextPackRegeneration({ workerId: "w", env, transport });
  await executeContextPackRegeneration({ claim, env, transport });
  assert.deepEqual(calls.map(({ body }) => body), [
    { workerId: "w" },
    { executionId: claimBody.claim.executionId, workerId: "w", leaseToken: claimBody.claim.leaseToken },
  ]);
  assert.deepEqual(calls.map(({ redirect }) => redirect), ["error", "error"]);
  assert.deepEqual(calls.map(({ authorization }) => authorization), ["Bearer secret", "Bearer secret"]);
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
  const [entrypoint, instrumentation] = await Promise.all([
    readFile(new URL("../scripts/context-pack-regeneration-worker.mjs", import.meta.url), "utf8"),
    readFile(new URL("../agent/instrumentation.ts", import.meta.url), "utf8"),
  ]);
  assert.match(entrypoint, /JACE_CONTEXT_PACK_REGENERATION_WORKER/);
  assert.match(entrypoint, /!== "1"/);
  assert.doesNotMatch(instrumentation, /context_pack_regeneration_worker/);
});
