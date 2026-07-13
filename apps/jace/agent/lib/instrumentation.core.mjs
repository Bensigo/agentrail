// Pure, dependency-free core for Jace's `agent/instrumentation.ts` (Eve's OTel
// setup seam). No SDK import, no network primitives of its own: the one real
// dependency this needs — constructing a `LangfuseSpanProcessor` — is an
// injected `createSpanProcessor` factory (the real one in the thin wrapper, a
// fake in tests), matching how `fetch_run_evidence.core.mjs` injects its
// `transport` and `model.core.mjs` takes plain env in. That keeps this module
// unit-testable without installing/mocking `@vercel/otel` or `@langfuse/otel`.
//
// Two responsibilities:
//  1. Decide whether Langfuse is configured (all three env vars set), and, if
//     so, build the `spanProcessors` array `agent/instrumentation.ts` hands to
//     `registerOTel`. When unconfigured this MUST be an empty array — Eve
//     enables telemetry by `instrumentation.ts`'s mere presence, so the
//     no-key path has to be explicitly inert, not merely "processor errors out".
//  2. Resolve the per-step runtime context merged onto AI SDK telemetry spans
//     (`events["step.started"]`), carrying the root session id so every turn —
//     root and delegated subagent alike — groups into one Langfuse session.

/**
 * True iff all three Langfuse env vars are set to a non-blank value.
 * Whitespace-only is treated as unset (mirrors resolveConsoleConfig's trim
 * convention in fetch_run_evidence.core.mjs).
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function isLangfuseConfigured(env = {}) {
  return Boolean(
    String(env.LANGFUSE_PUBLIC_KEY ?? "").trim() &&
      String(env.LANGFUSE_SECRET_KEY ?? "").trim() &&
      String(env.LANGFUSE_BASE_URL ?? "").trim(),
  );
}

/**
 * Build the `spanProcessors` array for `registerOTel`. Zero processors when
 * Langfuse isn't configured (the explicit inert path); otherwise exactly one,
 * built by the injected factory so this module never imports `@langfuse/otel`
 * itself.
 *
 * @param {{ env?: Record<string, string|undefined>, createSpanProcessor: () => unknown }} params
 * @returns {unknown[]}
 */
export function buildSpanProcessors({ env = {}, createSpanProcessor }) {
  return isLangfuseConfigured(env) ? [createSpanProcessor()] : [];
}

/**
 * Build the full config object `agent/instrumentation.ts`'s `setup` hands to
 * `registerOTel({ serviceName, spanProcessors })`. Exposed separately from
 * {@link buildSpanProcessors} so a test can assert the exact argument shape
 * `registerOTel` would receive without needing to intercept the real,
 * side-effecting `registerOTel` call itself (which mutates the global OTel
 * tracer-provider singleton and isn't safely callable twice in one process).
 *
 * @param {{ agentName: string, env?: Record<string, string|undefined>, createSpanProcessor: () => unknown }} params
 * @returns {{ serviceName: string, spanProcessors: unknown[] }}
 */
export function buildOtelConfig({ agentName, env = {}, createSpanProcessor }) {
  return {
    serviceName: agentName,
    spanProcessors: buildSpanProcessors({ env, createSpanProcessor }),
  };
}

/**
 * The current (v5) canonical Langfuse OTel span attribute for trace-level
 * session id — `LangfuseOtelSpanAttributes.TRACE_SESSION_ID` in
 * `@langfuse/core` (re-exported from `@langfuse/tracing`), verified against
 * the installed `@langfuse/otel@5.9.1` / `@langfuse/tracing@5.9.1` type
 * declarations on 2026-07-13. `"langfuse.session.id"` still exists as
 * `TRACE_COMPAT_SESSION_ID`, a legacy alias — `"session.id"` is primary.
 * Exported here only as the DEFAULT for `sessionIdAttribute` below so this
 * module needs no SDK import to be unit-testable; the real wrapper passes the
 * live enum value explicitly so a future SDK rename can't silently drift.
 *
 * @type {string}
 */
export const LANGFUSE_SESSION_ID_ATTRIBUTE = "session.id";

/**
 * Resolve the session id that should group an entire dispatch tree (the root
 * session plus every delegated subagent run) into one Langfuse session.
 *
 * Per eve@0.19.0's `InstrumentationSession` type
 * (node_modules/eve/dist/src/public/instrumentation/index.d.ts +
 * node_modules/eve/dist/src/channel/types.d.ts): there is no `session.rootId`.
 * A root session has `id` and no `parent`; a delegated subagent session has
 * both its own `id` AND `parent.rootSessionId`, denormalized at every dispatch
 * site so a subagent N levels deep attributes itself to the top user-facing
 * session without walking the chain. Root sessions ARE the root, so `id` is
 * used directly there.
 *
 * @param {{ id?: string, parent?: { rootSessionId?: string } } | undefined} session
 * @returns {string|undefined}
 */
export function resolveRootSessionId(session) {
  return session?.parent?.rootSessionId ?? session?.id;
}

/**
 * Build the `events["step.started"]` result: the runtime context merged onto
 * this attempt's AI SDK telemetry span (and inherited by its children).
 *
 * Returns `undefined` when Langfuse isn't configured — contributing no
 * context, matching eve's documented "return undefined to contribute no
 * context" contract.
 *
 * NOTE: eve silently drops any returned runtimeContext key beginning with
 * `eve.` (reserved for framework-owned context) — the plan's draft example
 * used `"eve.subagent"`, which would never have landed. This uses
 * `"jace.subagent"` instead.
 *
 * @param {{
 *   configured: boolean,
 *   session: { id?: string, parent?: { rootSessionId?: string } } | undefined,
 *   channel: { kind?: string } | undefined,
 *   sessionIdAttribute?: string,
 * }} params
 * @returns {{ runtimeContext: Record<string, string|boolean|undefined> } | undefined}
 */
export function buildStepStartedResult({
  configured,
  session,
  channel,
  sessionIdAttribute = LANGFUSE_SESSION_ID_ATTRIBUTE,
}) {
  if (!configured) return undefined;
  return {
    runtimeContext: {
      [sessionIdAttribute]: resolveRootSessionId(session),
      "jace.subagent": channel?.kind === "subagent",
    },
  };
}
