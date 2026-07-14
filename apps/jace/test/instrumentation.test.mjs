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
import { LangfuseOtelSpanAttributes } from "@langfuse/tracing";
import {
  AI_SDK_CONTEXT_PREFIX,
  buildOtelConfig,
  buildSpanProcessors,
  buildStepStartedResult,
  createSessionPromotingProcessor,
  deriveTraceName,
  extractMessageText,
  isLangfuseConfigured,
  LANGFUSE_SESSION_ID_ATTRIBUTE,
  LANGFUSE_TRACE_INPUT_ATTRIBUTE,
  LANGFUSE_TRACE_NAME_ATTRIBUTE,
  lastUserMessageText,
  promoteContextAttribute,
  resolveRootSessionId,
  sessionIdFromSpanAttributes,
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
    modelInput: { messages: [{ role: "user", content: "Fix the login bug" }] },
  });
  assert.deepEqual(result, {
    runtimeContext: {
      [LANGFUSE_SESSION_ID_ATTRIBUTE]: "sess_root",
      "jace.subagent": false,
      [LANGFUSE_TRACE_NAME_ATTRIBUTE]: "Fix the login bug",
      [LANGFUSE_TRACE_INPUT_ATTRIBUTE]: "Fix the login bug",
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
    modelInput: { messages: [{ role: "user", content: "Add a test" }] },
  });
  assert.deepEqual(result, {
    runtimeContext: {
      [LANGFUSE_SESSION_ID_ATTRIBUTE]: "sess_root",
      "jace.subagent": true,
      [LANGFUSE_TRACE_NAME_ATTRIBUTE]: "Add a test",
      [LANGFUSE_TRACE_INPUT_ATTRIBUTE]: "Add a test",
    },
  });
});

test("buildStepStartedResult honors an explicit sessionIdAttribute override (the real wrapper passes the live SDK enum value)", () => {
  const result = buildStepStartedResult({
    configured: true,
    session: { id: "sess_root" },
    channel: { kind: "http" },
    modelInput: { messages: [{ role: "user", content: "Ship it" }] },
    sessionIdAttribute: "langfuse.session.id", // the legacy compat key, just to prove it's not hard-coded
  });
  assert.deepEqual(result, {
    runtimeContext: {
      "langfuse.session.id": "sess_root",
      "jace.subagent": false,
      [LANGFUSE_TRACE_NAME_ATTRIBUTE]: "Ship it",
      [LANGFUSE_TRACE_INPUT_ATTRIBUTE]: "Ship it",
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

// ---------------------------------------------------------------------------
// Trace readability — pure text helpers for NAME/INPUT derivation.
// ---------------------------------------------------------------------------

test("extractMessageText: string content is returned as-is", () => {
  assert.equal(extractMessageText({ role: "user", content: "hello world" }), "hello world");
});

test("extractMessageText: concatenates text parts and ignores non-text parts", () => {
  const msg = {
    role: "user",
    content: [
      { type: "text", text: "a" },
      { type: "image", image: "…" },
      { type: "text", text: "b" },
    ],
  };
  assert.equal(extractMessageText(msg), "ab");
});

test("extractMessageText: undefined / non-array content → empty string", () => {
  assert.equal(extractMessageText(undefined), "");
  assert.equal(extractMessageText({}), "");
  assert.equal(extractMessageText({ content: 42 }), "");
});

test("lastUserMessageText: picks the LAST user-role message across a mixed thread and trims", () => {
  const messages = [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "tool", content: "result" },
    { role: "user", content: "  latest  " },
  ];
  assert.equal(lastUserMessageText(messages), "latest");
});

test("lastUserMessageText: empty string when there is no user message or input is not an array", () => {
  assert.equal(lastUserMessageText([{ role: "assistant", content: "x" }]), "");
  assert.equal(lastUserMessageText(undefined), "");
});

test("deriveTraceName: collapses whitespace, leaves a short string intact", () => {
  assert.equal(deriveTraceName("  Fix   the\nlogin bug  "), "Fix the login bug");
});

test("deriveTraceName: blank / whitespace-only → undefined (so caller can fall back)", () => {
  assert.equal(deriveTraceName(""), undefined);
  assert.equal(deriveTraceName("   \n\t "), undefined);
  assert.equal(deriveTraceName(undefined), undefined);
});

test("deriveTraceName: truncates a >96-char string to 96 chars ending in an ellipsis", () => {
  const long = "x".repeat(200);
  const name = deriveTraceName(long);
  assert.equal(name.length, 96);
  assert.ok(name.endsWith("…"), "truncated name must end with an ellipsis");
  assert.equal(name, "x".repeat(95) + "…");
});

// Anti-drift PINs — the core defaults must equal the live @langfuse/tracing enum.
test("PIN: LANGFUSE_TRACE_NAME_ATTRIBUTE equals the live @langfuse/tracing TRACE_NAME enum", () => {
  assert.equal(LANGFUSE_TRACE_NAME_ATTRIBUTE, LangfuseOtelSpanAttributes.TRACE_NAME);
});

test("PIN: LANGFUSE_TRACE_INPUT_ATTRIBUTE equals the live @langfuse/tracing TRACE_INPUT enum", () => {
  assert.equal(LANGFUSE_TRACE_INPUT_ATTRIBUTE, LangfuseOtelSpanAttributes.TRACE_INPUT);
});

// ---------------------------------------------------------------------------
// buildStepStartedResult — trace NAME/INPUT derivation.
// ---------------------------------------------------------------------------

test("buildStepStartedResult: long user message → NAME truncated with ellipsis, INPUT is the full text (name ≠ input)", () => {
  const long = "Refactor the authentication middleware " + "y".repeat(120);
  const result = buildStepStartedResult({
    configured: true,
    session: { id: "sess_root" },
    channel: { kind: "http" },
    modelInput: { messages: [{ role: "user", content: long }] },
  });
  const name = result.runtimeContext[LANGFUSE_TRACE_NAME_ATTRIBUTE];
  const input = result.runtimeContext[LANGFUSE_TRACE_INPUT_ATTRIBUTE];
  assert.equal(name.length, 96);
  assert.ok(name.endsWith("…"));
  assert.equal(input, long, "INPUT keeps the full (uncapped-at-this-length) user text");
  assert.notEqual(name, input, "the long case must have a distinct truncated name and full input");
});

test("buildStepStartedResult: INPUT is length-capped at inputMaxLength", () => {
  const huge = "z".repeat(9000);
  const result = buildStepStartedResult({
    configured: true,
    session: { id: "sess_root" },
    channel: { kind: "http" },
    modelInput: { messages: [{ role: "user", content: huge }] },
  });
  assert.equal(result.runtimeContext[LANGFUSE_TRACE_INPUT_ATTRIBUTE].length, 8000);
});

test("buildStepStartedResult: attachments-only / no user text → NAME falls back to channel.kind and NO input key", () => {
  const result = buildStepStartedResult({
    configured: true,
    session: { id: "sess_root" },
    channel: { kind: "telegram" },
    modelInput: { messages: [{ role: "user", content: [{ type: "image", image: "…" }] }] },
  });
  assert.equal(result.runtimeContext[LANGFUSE_TRACE_NAME_ATTRIBUTE], "telegram");
  assert.ok(
    !(LANGFUSE_TRACE_INPUT_ATTRIBUTE in result.runtimeContext),
    "no real user text → the trace input key must be absent, not empty",
  );
});

test("buildStepStartedResult: none of the emitted NAME/INPUT keys begin with the reserved eve. prefix", () => {
  const result = buildStepStartedResult({
    configured: true,
    session: { id: "sess_root" },
    channel: { kind: "subagent" },
    modelInput: { messages: [{ role: "user", content: "do the thing" }] },
  });
  for (const key of Object.keys(result.runtimeContext)) {
    assert.ok(!key.startsWith("eve."), `runtimeContext key "${key}" would be dropped by eve`);
  }
});

// ---------------------------------------------------------------------------
// #1198 — session-id promotion. The session id set via `runtimeContext` lands
// on spans under `ai.settings.context.session.id`, but Langfuse reads the
// top-level `session.id`. These lock the read + the promoting processor.
// ---------------------------------------------------------------------------

test("PIN: the core's default session-id key equals the live @langfuse/tracing enum (anti-drift)", () => {
  // instrumentation.ts wires BOTH the step.started stamp AND the promoting
  // processor to LangfuseOtelSpanAttributes.TRACE_SESSION_ID. The core's
  // LANGFUSE_SESSION_ID_ATTRIBUTE default must stay equal to that live enum, or
  // a future SDK rename would desync the key we stamp from the key we promote
  // into and silently reintroduce #1198 (traces back to sessionId: null).
  assert.equal(LANGFUSE_SESSION_ID_ATTRIBUTE, LangfuseOtelSpanAttributes.TRACE_SESSION_ID);
});

test("sessionIdFromSpanAttributes reads the AI-SDK-namespaced session id we set", () => {
  const attrs = { [`${AI_SDK_CONTEXT_PREFIX}${LANGFUSE_SESSION_ID_ATTRIBUTE}`]: "wrun_root_1" };
  assert.equal(sessionIdFromSpanAttributes(attrs), "wrun_root_1");
});

test("sessionIdFromSpanAttributes falls back to eve's framework session id", () => {
  const attrs = { [`${AI_SDK_CONTEXT_PREFIX}eve.session.id`]: "wrun_eve_1" };
  assert.equal(sessionIdFromSpanAttributes(attrs), "wrun_eve_1");
});

test("sessionIdFromSpanAttributes prefers OUR root-resolved id over eve's when both present", () => {
  const attrs = {
    [`${AI_SDK_CONTEXT_PREFIX}${LANGFUSE_SESSION_ID_ATTRIBUTE}`]: "wrun_root_1",
    [`${AI_SDK_CONTEXT_PREFIX}eve.session.id`]: "wrun_child_1",
  };
  assert.equal(sessionIdFromSpanAttributes(attrs), "wrun_root_1");
});

test("sessionIdFromSpanAttributes returns undefined when neither key is a non-blank string", () => {
  assert.equal(sessionIdFromSpanAttributes({}), undefined);
  assert.equal(sessionIdFromSpanAttributes({ [`${AI_SDK_CONTEXT_PREFIX}${LANGFUSE_SESSION_ID_ATTRIBUTE}`]: "   " }), undefined);
});

test("createSessionPromotingProcessor: onEnd promotes the namespaced id to the top-level key Langfuse reads, then delegates", () => {
  const seen = [];
  const inner = { onEnd: (s) => seen.push(s) };
  const proc = createSessionPromotingProcessor(inner);
  const span = { attributes: { [`${AI_SDK_CONTEXT_PREFIX}${LANGFUSE_SESSION_ID_ATTRIBUTE}`]: "wrun_root_1" } };
  proc.onEnd(span);
  assert.equal(span.attributes[LANGFUSE_SESSION_ID_ATTRIBUTE], "wrun_root_1", "top-level session.id must be set for Langfuse ingestion");
  assert.equal(seen.length, 1, "inner processor must still receive the span");
  assert.equal(seen[0], span, "the SAME (mutated) span object is forwarded, so the promoted attr is exported");
});

test("createSessionPromotingProcessor: onEnd never clobbers an already-set top-level session.id", () => {
  const proc = createSessionPromotingProcessor({ onEnd() {} });
  const span = {
    attributes: {
      [LANGFUSE_SESSION_ID_ATTRIBUTE]: "already_correct",
      [`${AI_SDK_CONTEXT_PREFIX}${LANGFUSE_SESSION_ID_ATTRIBUTE}`]: "wrun_root_1",
    },
  };
  proc.onEnd(span);
  assert.equal(span.attributes[LANGFUSE_SESSION_ID_ATTRIBUTE], "already_correct");
});

test("createSessionPromotingProcessor: onEnd is a no-op (no throw) when no session id is present", () => {
  let delegated = false;
  const proc = createSessionPromotingProcessor({ onEnd() { delegated = true; } });
  const span = { attributes: { "gen_ai.request.model": "x" } };
  proc.onEnd(span);
  assert.equal(span.attributes[LANGFUSE_SESSION_ID_ATTRIBUTE], undefined);
  assert.ok(delegated, "inner.onEnd must still be called");
});

test("createSessionPromotingProcessor: a frozen/immutable attributes object never breaks span export", () => {
  let delegated = false;
  const proc = createSessionPromotingProcessor({ onEnd() { delegated = true; } });
  // Object.freeze makes the assignment throw in strict mode — the processor
  // must swallow it and still export the span (never throw out of onEnd).
  const span = { attributes: Object.freeze({ [`${AI_SDK_CONTEXT_PREFIX}${LANGFUSE_SESSION_ID_ATTRIBUTE}`]: "wrun_root_1" }) };
  assert.doesNotThrow(() => proc.onEnd(span));
  assert.ok(delegated, "inner.onEnd must still be called even when promotion fails");
});

// ---------------------------------------------------------------------------
// Trace NAME/INPUT promotion — same namespaced→bare lift as session id.
// ---------------------------------------------------------------------------

test("promoteContextAttribute: promotes the AI-SDK-namespaced value to the bare top-level key", () => {
  const attrs = { [`${AI_SDK_CONTEXT_PREFIX}${LANGFUSE_TRACE_NAME_ATTRIBUTE}`]: "Fix the login bug" };
  promoteContextAttribute(attrs, LANGFUSE_TRACE_NAME_ATTRIBUTE);
  assert.equal(attrs[LANGFUSE_TRACE_NAME_ATTRIBUTE], "Fix the login bug");
});

test("promoteContextAttribute: never clobbers an already-set bare key", () => {
  const attrs = {
    [LANGFUSE_TRACE_NAME_ATTRIBUTE]: "already set",
    [`${AI_SDK_CONTEXT_PREFIX}${LANGFUSE_TRACE_NAME_ATTRIBUTE}`]: "from context",
  };
  promoteContextAttribute(attrs, LANGFUSE_TRACE_NAME_ATTRIBUTE);
  assert.equal(attrs[LANGFUSE_TRACE_NAME_ATTRIBUTE], "already set");
});

test("promoteContextAttribute: no-op when the source is blank/whitespace/missing", () => {
  const blank = { [`${AI_SDK_CONTEXT_PREFIX}${LANGFUSE_TRACE_INPUT_ATTRIBUTE}`]: "   " };
  promoteContextAttribute(blank, LANGFUSE_TRACE_INPUT_ATTRIBUTE);
  assert.equal(blank[LANGFUSE_TRACE_INPUT_ATTRIBUTE], undefined);

  const missing = {};
  promoteContextAttribute(missing, LANGFUSE_TRACE_INPUT_ATTRIBUTE);
  assert.equal(missing[LANGFUSE_TRACE_INPUT_ATTRIBUTE], undefined);

  assert.doesNotThrow(() => promoteContextAttribute(undefined, LANGFUSE_TRACE_NAME_ATTRIBUTE));
});

test("createSessionPromotingProcessor: onEnd promotes session id, trace name AND trace input, then forwards the same span", () => {
  const seen = [];
  const inner = { onEnd: (s) => seen.push(s) };
  const proc = createSessionPromotingProcessor(inner);
  const span = {
    attributes: {
      [`${AI_SDK_CONTEXT_PREFIX}${LANGFUSE_SESSION_ID_ATTRIBUTE}`]: "wrun_root_1",
      [`${AI_SDK_CONTEXT_PREFIX}${LANGFUSE_TRACE_NAME_ATTRIBUTE}`]: "Fix the login bug",
      [`${AI_SDK_CONTEXT_PREFIX}${LANGFUSE_TRACE_INPUT_ATTRIBUTE}`]: "Fix the login bug in the header",
    },
  };
  proc.onEnd(span);
  assert.equal(span.attributes[LANGFUSE_SESSION_ID_ATTRIBUTE], "wrun_root_1");
  assert.equal(span.attributes[LANGFUSE_TRACE_NAME_ATTRIBUTE], "Fix the login bug");
  assert.equal(span.attributes[LANGFUSE_TRACE_INPUT_ATTRIBUTE], "Fix the login bug in the header");
  assert.equal(seen.length, 1);
  assert.equal(seen[0], span, "the SAME mutated span is forwarded, so promoted attrs are exported");
});

test("createSessionPromotingProcessor: a frozen attributes object never breaks export even with name/input present", () => {
  let delegated = false;
  const proc = createSessionPromotingProcessor({ onEnd() { delegated = true; } });
  const span = {
    attributes: Object.freeze({
      [`${AI_SDK_CONTEXT_PREFIX}${LANGFUSE_TRACE_NAME_ATTRIBUTE}`]: "Fix the login bug",
    }),
  };
  assert.doesNotThrow(() => proc.onEnd(span));
  assert.ok(delegated, "inner.onEnd must still be called even when promotion fails");
});

test("createSessionPromotingProcessor: onEnd sets no name/input when the span carries none of the context keys", () => {
  let delegated = false;
  const proc = createSessionPromotingProcessor({ onEnd() { delegated = true; } });
  const span = { attributes: { "gen_ai.request.model": "x" } };
  proc.onEnd(span);
  assert.equal(span.attributes[LANGFUSE_TRACE_NAME_ATTRIBUTE], undefined);
  assert.equal(span.attributes[LANGFUSE_TRACE_INPUT_ATTRIBUTE], undefined);
  assert.ok(delegated);
});

test("createSessionPromotingProcessor: forwards onStart/forceFlush/shutdown to inner", async () => {
  const calls = [];
  const inner = {
    onStart: (s, c) => calls.push(["onStart", s, c]),
    forceFlush: () => { calls.push(["forceFlush"]); return Promise.resolve("flushed"); },
    shutdown: () => { calls.push(["shutdown"]); return Promise.resolve("down"); },
  };
  const proc = createSessionPromotingProcessor(inner);
  proc.onStart("span", "ctx");
  assert.deepEqual(calls[0], ["onStart", "span", "ctx"]);
  assert.equal(await proc.forceFlush(), "flushed");
  assert.equal(await proc.shutdown(), "down");
});

test("createSessionPromotingProcessor: tolerates an inner processor missing optional lifecycle methods", async () => {
  const proc = createSessionPromotingProcessor({});
  // none of these should throw
  proc.onStart({}, {});
  proc.onEnd({ attributes: {} });
  await proc.forceFlush();
  await proc.shutdown();
});
