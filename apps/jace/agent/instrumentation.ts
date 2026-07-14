// Eve auto-discovers this file at server startup and owns OTel provider
// registration through its `setup` callback (the presence of a
// `defineInstrumentation` export here IMPLICITLY enables telemetry — there is
// no separate on/off flag). This wires Langfuse's span processor into that
// seam. All decision logic lives in `./lib/instrumentation.core.mjs` (pure,
// injected `createSpanProcessor`), so it's unit-tested without installing or
// mocking `@vercel/otel` / `@langfuse/otel` — see test/instrumentation.test.mjs.
//
// PINS (verified 2026-07-13, against installed package versions — see
// apps/jace/package.json):
//
// (a) `@langfuse/otel` is currently major v5 (installed 5.9.1, alongside
//     `@langfuse/tracing@5.9.1`; the plan's brief assumed an unpinned/older
//     major — the JS SDK moved v4 -> v5 recently, per
//     https://langfuse.com/docs/observability/sdk/typescript/setup). Per the
//     installed `@langfuse/otel/dist/index.d.ts` JSDoc, `LangfuseSpanProcessor`
//     reads `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL`
//     from `process.env` automatically for any constructor option left
//     unset — so `new LangfuseSpanProcessor()` with zero arguments is
//     correct once those three vars are set. `@vercel/otel` needs to be v2+
//     for `registerOTel`'s `spanProcessors` option to exist; installed here
//     is 2.1.3.
//
// (b) The plan's draft (`input.session.rootId ?? input.session.id`) guessed a
//     `rootId` property that does not exist. Verified instead against the
//     REAL installed type declarations
//     (node_modules/eve/dist/src/public/instrumentation/index.d.ts +
//     node_modules/eve/dist/src/channel/types.d.ts, eve@0.19.0):
//     `InstrumentationSession` has `id` (this session's own id) and an
//     optional `parent: SessionParent`, present only for delegated subagent
//     sessions; `parent.rootSessionId` denormalizes the top-of-dispatch-chain
//     session id so a subagent N levels deep attributes itself to the root
//     without walking the chain. Root sessions (no parent) ARE the root, so
//     `id` is used directly — see `resolveRootSessionId` in
//     instrumentation.core.mjs. Also verified: eve silently drops any
//     returned `runtimeContext` key beginning with `eve.` (framework-reserved)
//     — the plan's `"eve.subagent"` key would never have landed on a span;
//     this uses `"jace.subagent"` instead. And per
//     node_modules/@langfuse/core/dist/index.d.ts's `LangfuseOtelSpanAttributes`
//     enum, the CURRENT (v5) canonical session-id span attribute is
//     `TRACE_SESSION_ID = "session.id"`; `"langfuse.session.id"` still exists
//     but only as the legacy `TRACE_COMPAT_SESSION_ID` alias — this uses the
//     current primary key, read live off the enum (not hard-coded) so a
//     future SDK rename can't silently drift.
import { defineInstrumentation } from "eve/instrumentation";
import { registerOTel } from "@vercel/otel";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseOtelSpanAttributes } from "@langfuse/tracing";
import {
  buildOtelConfig,
  buildStepStartedResult,
  createSessionPromotingProcessor,
  isLangfuseConfigured,
} from "./lib/instrumentation.core.mjs";

export default defineInstrumentation({
  setup: ({ agentName }) => {
    registerOTel(
      buildOtelConfig({
        agentName,
        env: process.env,
        // #1198: wrap Langfuse's processor so the root session id (which Eve
        // can only place under `ai.settings.context.session.id` via
        // runtimeContext) is promoted to the top-level `session.id` Langfuse
        // reads — otherwise traces land session-less and the session-scoped
        // verdict scores have no visible session to attach to. Pass the SAME
        // live SDK enum the `step.started` hook uses below, so the key the
        // promoter reads/writes can never drift from the key that hook stamps
        // (a future `@langfuse/tracing` rename must move both, or neither).
        createSpanProcessor: () =>
          createSessionPromotingProcessor(new LangfuseSpanProcessor(), {
            sessionIdAttribute: LangfuseOtelSpanAttributes.TRACE_SESSION_ID,
            traceNameAttribute: LangfuseOtelSpanAttributes.TRACE_NAME,
            traceInputAttribute: LangfuseOtelSpanAttributes.TRACE_INPUT,
          }),
      }),
    );
  },
  events: {
    "step.started"(input) {
      return buildStepStartedResult({
        configured: isLangfuseConfigured(process.env),
        session: input.session,
        channel: input.channel,
        modelInput: input.modelInput,
        sessionIdAttribute: LangfuseOtelSpanAttributes.TRACE_SESSION_ID,
        traceNameAttribute: LangfuseOtelSpanAttributes.TRACE_NAME,
        traceInputAttribute: LangfuseOtelSpanAttributes.TRACE_INPUT,
      });
    },
  },
});
