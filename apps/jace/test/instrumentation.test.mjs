// Unit tests for Jace's Langfuse instrumentation seam (Task 7).
//
// `agent/instrumentation.ts` is a thin wrapper that imports the real
// `registerOTel` (@vercel/otel) and `LangfuseSpanProcessor` (@langfuse/otel)
// and calls into `agent/lib/instrumentation.core.mjs` for every decision. All
// SDK-facing behavior this test asserts on lives in that pure core — exactly
// the same "injected dependency, no module mocking" convention
// `fetch_run_evidence.core.mjs` uses for its `transport` seam and
// `model.core.mjs` uses for model selection. `node:test`'s module-mocking API
// (`t.mock.module`) needs `--experimental-test-module-mocks`, which this
// repo's plain `node --test test/*.test.mjs` script does not pass — so the
// core's injected `createSpanProcessor` factory stands in for a "stubbed
// registerOTel": it proves the exact `{ serviceName, spanProcessors }` object
// that would be handed to the real, side-effecting `registerOTel` (which
// mutates the global OTel tracer-provider singleton and is not safely
// callable more than once in a process), without needing to intercept
// `registerOTel` itself.
//
// The one thing worth exercising against the REAL wrapper file (not just the
// core) is its default-export shape — eve auto-discovers this file by that
// shape at server startup, so a shape regression is exactly what would slip
// through if only the core were tested.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOtelConfig,
  buildSpanProcessors,
  buildStepStartedResult,
  isLangfuseConfigured,
  LANGFUSE_SESSION_ID_ATTRIBUTE,
  resolveRootSessionId,
} from "../agent/lib/instrumentation.core.mjs";

const FAKE_LANGFUSE_ENV = {
  LANGFUSE_PUBLIC_KEY: "pk-fake",
  LANGFUSE_SECRET_KEY: "sk-fake",
  LANGFUSE_BASE_URL: "https://fake.langfuse.example.com",
};

// A stub processor factory that records how many times it was invoked, so
// tests can assert construction happened exactly once (or not at all) rather
// than merely asserting array length.
function fakeSpanProcessorFactory() {
  const calls = { count: 0 };
  const create = () => {
    calls.count += 1;
    return { kind: "fake-span-processor", instance: calls.count };
  };
  create.calls = calls;
  return create;
}

// ---------------------------------------------------------------------------
// (a) agent/instrumentation.ts default-exports { setup, events } — the real
// shape eve discovers at server startup.
// ---------------------------------------------------------------------------

test("agent/instrumentation.ts default-exports an object with a setup function", async () => {
  const mod = await import("../agent/instrumentation.ts");
  assert.equal(typeof mod.default, "object");
  assert.notEqual(mod.default, null);
  assert.equal(typeof mod.default.setup, "function");
  assert.equal(typeof mod.default.events["step.started"], "function");
});

// ---------------------------------------------------------------------------
// (b) No Langfuse env vars set → the config `setup` builds carries ZERO span
// processors (the explicit inert path — telemetry is enabled by this file's
// mere presence, so no-key must not silently construct a processor that will
// fail to export).
// ---------------------------------------------------------------------------

test("no LANGFUSE env vars set → isLangfuseConfigured is false", () => {
  assert.equal(isLangfuseConfigured({}), false);
  assert.equal(isLangfuseConfigured({ LANGFUSE_PUBLIC_KEY: "pk-only" }), false);
  // whitespace-only counts as unset
  assert.equal(
    isLangfuseConfigured({
      LANGFUSE_PUBLIC_KEY: "  ",
      LANGFUSE_SECRET_KEY: "sk",
      LANGFUSE_BASE_URL: "https://x",
    }),
    false,
  );
});

test("no LANGFUSE env vars set → setup's config carries an empty spanProcessors array, factory never called", () => {
  const createSpanProcessor = fakeSpanProcessorFactory();
  const config = buildOtelConfig({
    agentName: "jace",
    env: {},
    createSpanProcessor,
  });
  assert.deepEqual(config, { serviceName: "jace", spanProcessors: [] });
  assert.equal(createSpanProcessor.calls.count, 0);

  // buildSpanProcessors (the piece setup delegates to) agrees.
  assert.deepEqual(buildSpanProcessors({ env: {}, createSpanProcessor }), []);
});

// ---------------------------------------------------------------------------
// (c) Fake Langfuse env vars set → exactly ONE processor is constructed and
// passed.
// ---------------------------------------------------------------------------

test("fake LANGFUSE env vars set → isLangfuseConfigured is true", () => {
  assert.equal(isLangfuseConfigured(FAKE_LANGFUSE_ENV), true);
});

test("fake LANGFUSE env vars set → setup's config carries exactly one span processor, factory called once", () => {
  const createSpanProcessor = fakeSpanProcessorFactory();
  const config = buildOtelConfig({
    agentName: "jace",
    env: FAKE_LANGFUSE_ENV,
    createSpanProcessor,
  });
  assert.equal(config.serviceName, "jace");
  assert.equal(config.spanProcessors.length, 1);
  assert.deepEqual(config.spanProcessors[0], { kind: "fake-span-processor", instance: 1 });
  assert.equal(createSpanProcessor.calls.count, 1);
});

// ---------------------------------------------------------------------------
// events["step.started"] — session id lineage + subagent flag.
// ---------------------------------------------------------------------------

test("resolveRootSessionId: root session (no parent) uses its own id", () => {
  assert.equal(resolveRootSessionId({ id: "sess_root" }), "sess_root");
});

test("resolveRootSessionId: delegated subagent session uses parent.rootSessionId, not its own id", () => {
  assert.equal(
    resolveRootSessionId({
      id: "sess_child",
      parent: { rootSessionId: "sess_root", sessionId: "sess_child_parent", callId: "call_1", turn: { id: "t1", sequence: 0 } },
    }),
    "sess_root",
  );
});

test("buildStepStartedResult returns undefined when Langfuse isn't configured (contributes no context)", () => {
  const result = buildStepStartedResult({
    configured: false,
    session: { id: "sess_root" },
    channel: { kind: "http" },
  });
  assert.equal(result, undefined);
});

test("buildStepStartedResult carries the root session id under the current Langfuse session attribute for a root turn", () => {
  const result = buildStepStartedResult({
    configured: true,
    session: { id: "sess_root" },
    channel: { kind: "http" },
  });
  assert.deepEqual(result, {
    runtimeContext: {
      [LANGFUSE_SESSION_ID_ATTRIBUTE]: "sess_root",
      "jace.subagent": false,
    },
  });
});

test("buildStepStartedResult groups a delegated subagent turn under the ROOT session id and flags jace.subagent", () => {
  const result = buildStepStartedResult({
    configured: true,
    session: {
      id: "sess_child",
      parent: { rootSessionId: "sess_root", sessionId: "sess_parent", callId: "call_1", turn: { id: "t1", sequence: 0 } },
    },
    channel: { kind: "subagent" },
  });
  assert.deepEqual(result, {
    runtimeContext: {
      [LANGFUSE_SESSION_ID_ATTRIBUTE]: "sess_root",
      "jace.subagent": true,
    },
  });
});

test("buildStepStartedResult honors an explicit sessionIdAttribute override (the real wrapper passes the live SDK enum value)", () => {
  const result = buildStepStartedResult({
    configured: true,
    session: { id: "sess_root" },
    channel: { kind: "http" },
    sessionIdAttribute: "langfuse.session.id", // the legacy compat key, just to prove it's not hard-coded
  });
  assert.deepEqual(result, {
    runtimeContext: {
      "langfuse.session.id": "sess_root",
      "jace.subagent": false,
    },
  });
});

// ---------------------------------------------------------------------------
// No `eve.`-prefixed runtimeContext key — eve silently drops those.
// ---------------------------------------------------------------------------

test("no runtimeContext key begins with the framework-reserved eve. prefix", () => {
  const result = buildStepStartedResult({
    configured: true,
    session: { id: "sess_root" },
    channel: { kind: "subagent" },
  });
  for (const key of Object.keys(result.runtimeContext)) {
    assert.ok(!key.startsWith("eve."), `runtimeContext key "${key}" begins with the reserved "eve." prefix and would be silently dropped`);
  }
});
