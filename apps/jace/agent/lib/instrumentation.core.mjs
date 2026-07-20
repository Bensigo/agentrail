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
//     root and delegated subagent alike — groups into one Langfuse session,
//     plus (#1339 PR②) the classified chat intent as a trace tag, reusing the
//     SAME canonical `classifyIntent` #1339 PR① uses for routing — so the
//     tag Langfuse groups spend by can never silently drift from the
//     boundary root's own delegation policy actually enforces.

import { classifyIntent } from "./intent-classifier.core.mjs";

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
 * The current (v5) canonical Langfuse OTel span attributes for TRACE-level name
 * and input — `LangfuseOtelSpanAttributes.TRACE_NAME` / `.TRACE_INPUT` in
 * `@langfuse/core` (re-exported from `@langfuse/tracing`), verified against the
 * installed `@langfuse/core` type declarations on 2026-07-14. Setting these on
 * ANY observation upserts the enclosing TRACE's name/input (same class as
 * `session.id`), which is why they ride the same context-bearing-span promotion
 * path #1198 uses — see `promoteContextAttribute` below. Exported only as the
 * DEFAULTS so this module needs no SDK import; the real wrapper passes the live
 * enum values explicitly so a future SDK rename can't silently drift.
 *
 * @type {string}
 */
export const LANGFUSE_TRACE_NAME_ATTRIBUTE = "langfuse.trace.name";
/** @type {string} */
export const LANGFUSE_TRACE_INPUT_ATTRIBUTE = "langfuse.trace.input";

/**
 * The current (v5) canonical Langfuse OTel span attribute for TRACE-level
 * tags — `LangfuseOtelSpanAttributes.TRACE_TAGS` in `@langfuse/core`
 * (`"langfuse.trace.tags"`), value type `string[]` (a genuine array
 * attribute, not a JSON/comma-separated string — verified against Langfuse's
 * OpenTelemetry integration docs, 2026-07-20, and empirically against eve's
 * own compiled runtime-context flattener: an array value assigned to a
 * `step.started` runtimeContext key is copied verbatim onto the span
 * attribute, never stringified — see `@ai-sdk/otel`'s context-flattening
 * function in eve's bundle). #1339 PR② uses this to carry the classified
 * chat intent (`["intent:chit-chat"]` / `["intent:capable"]`) so Langfuse's
 * Metrics API v2 can group `totalCost` by `tags` for the spend-by-intent
 * view. Exported only as the DEFAULT so this module needs no SDK import; the
 * real wrapper passes the live enum value explicitly so a future SDK rename
 * can't silently drift (same convention as session id / name / input above).
 *
 * @type {string}
 */
export const LANGFUSE_TRACE_TAGS_ATTRIBUTE = "langfuse.trace.tags";

/**
 * Extract concatenated text from a `ModelMessage`'s content. A user
 * `ModelMessage.content` is either a plain string or an array of parts; only
 * text parts (`{ type: "text", text: string }`) contribute — file/image parts
 * are ignored (verified against eve's bundled @ai-sdk message types).
 *
 * @param {{ content?: unknown } | undefined} message
 * @returns {string}
 */
export function extractMessageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
  }
  return "";
}

/**
 * Text of the last `role === "user"` message in a model input's `messages`
 * array — the current turn's initiating message. Stable across all steps of a
 * turn (only tool/assistant roles get appended mid-turn) and, across a
 * multi-turn conversation, resolves to the latest user message. Trimmed.
 *
 * @param {readonly { role?: string, content?: unknown }[] | undefined} messages
 * @returns {string}
 */
export function lastUserMessageText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return extractMessageText(messages[i]).trim();
  }
  return "";
}

/**
 * Human-readable trace name derived from arbitrary text: whitespace-collapsed
 * and truncated to `maxLength` chars (with a trailing ellipsis when cut).
 * Returns `undefined` when the text is blank, so a caller can fall back.
 *
 * @param {unknown} text
 * @param {{ maxLength?: number }} [opts]
 * @returns {string|undefined}
 */
export function deriveTraceName(text, { maxLength = 96 } = {}) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

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
 * Also derives a human-readable trace NAME and, when the turn carries real user
 * text, a trace INPUT — both stamped as runtimeContext keys so they ride the
 * same context-bearing-span promotion path as `session.id` (see
 * `promoteContextAttribute`). NAME is guaranteed non-empty: the last user
 * message's text, else the channel kind (which normalizes to `"unknown"` at
 * worst). INPUT is emitted only when there IS user text, length-capped to bound
 * payload duplication across the turn's spans.
 *
 * #1339 PR②: also stamps a TAGS array (single element, `"intent:<class>"`)
 * from `classifyIntent(userText)` — the SAME classifier PR①'s routing policy
 * is written against, so the tag Langfuse groups spend by is never a second,
 * independently-drifting definition of "chit-chat". This is the classifier's
 * PREDICTION for the turn's initiating message, not a confirmation that root
 * actually delegated to the smalltalk subagent — for a smalltalk subagent
 * step this is the same text root relayed in, so it correctly reads
 * "intent:chit-chat" there too. Always present (never conditional on
 * userText, unlike INPUT): an attachments-only/no-text turn still gets
 * `classifyIntent("")` → `"capable"`, consistent with AC2's fail-safe.
 *
 * @param {{
 *   configured: boolean,
 *   session: { id?: string, parent?: { rootSessionId?: string } } | undefined,
 *   channel: { kind?: string } | undefined,
 *   modelInput?: { messages?: readonly { role?: string, content?: unknown }[] } | undefined,
 *   sessionIdAttribute?: string,
 *   traceNameAttribute?: string,
 *   traceInputAttribute?: string,
 *   tagsAttribute?: string,
 *   inputMaxLength?: number,
 * }} params
 * @returns {{ runtimeContext: Record<string, string|boolean|readonly string[]|undefined> } | undefined}
 */
export function buildStepStartedResult({
  configured,
  session,
  channel,
  modelInput,
  sessionIdAttribute = LANGFUSE_SESSION_ID_ATTRIBUTE,
  traceNameAttribute = LANGFUSE_TRACE_NAME_ATTRIBUTE,
  traceInputAttribute = LANGFUSE_TRACE_INPUT_ATTRIBUTE,
  tagsAttribute = LANGFUSE_TRACE_TAGS_ATTRIBUTE,
  inputMaxLength = 8000,
}) {
  if (!configured) return undefined;
  const userText = lastUserMessageText(modelInput?.messages);
  const runtimeContext = {
    [sessionIdAttribute]: resolveRootSessionId(session),
    "jace.subagent": channel?.kind === "subagent",
    [tagsAttribute]: [`intent:${classifyIntent(userText)}`],
  };
  // NAME (guaranteed): user text, else channel kind (worst case "unknown").
  const name = deriveTraceName(userText) ?? deriveTraceName(channel?.kind);
  if (name) runtimeContext[traceNameAttribute] = name;
  // INPUT (optional): only when there's real user text; length-capped.
  if (userText) {
    runtimeContext[traceInputAttribute] =
      userText.length > inputMaxLength ? userText.slice(0, inputMaxLength) : userText;
  }
  return { runtimeContext };
}

// ---------------------------------------------------------------------------
// #1198 — session-id promotion.
//
// `events["step.started"]` returns `runtimeContext`, and per Eve's
// instrumentation guide those values ride onto AI SDK spans under the AI SDK's
// OWN namespace: a returned key `"session.id"` lands on the span as
// `ai.settings.context.session.id`, NOT as a top-level `session.id`. Langfuse's
// OTLP ingestion reads the top-level `session.id` (v5
// `LangfuseOtelSpanAttributes.TRACE_SESSION_ID`) to set a trace's `sessionId`;
// it does not look under `ai.settings.context.`. So the session id was on every
// span but in the wrong namespace, every Jace trace landed with `sessionId:
// null`, and the session-scoped verdict scores (which key on `ctx.session.id`)
// had no visible session to attach to — invisible in the dashboard despite
// existing in the API. `runtimeContext` is the only session-aware seam Eve
// exposes and it can only ever produce `ai.settings.context.*`, so the fix is
// to promote the value into the key Langfuse reads, on the span, before export.

/** The prefix the AI SDK adds to every `runtimeContext` key when it projects
 *  runtime context onto a span (verified live: our `"session.id"` context key
 *  is observed on spans as `ai.settings.context.session.id`). */
export const AI_SDK_CONTEXT_PREFIX = "ai.settings.context.";

/**
 * Read the root session id out of a span's attributes, looking under the AI SDK
 * runtime-context namespace. Prefers the id WE set (`sessionIdAttribute`, i.e.
 * the root-resolved id that matches the score's `sessionId`) and falls back to
 * Eve's framework `eve.session.id`. Returns `undefined` when neither is a
 * non-blank string.
 *
 * @param {Record<string, unknown>} [attributes]
 * @param {string} [sessionIdAttribute] the un-prefixed runtimeContext key
 * @returns {string|undefined}
 */
export function sessionIdFromSpanAttributes(
  attributes = {},
  sessionIdAttribute = LANGFUSE_SESSION_ID_ATTRIBUTE,
) {
  const candidates = [
    `${AI_SDK_CONTEXT_PREFIX}${sessionIdAttribute}`,
    `${AI_SDK_CONTEXT_PREFIX}eve.session.id`,
  ];
  for (const key of candidates) {
    const value = attributes[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/**
 * Promote one AI-SDK-namespaced context attribute (`ai.settings.context.<bareKey>`)
 * to the bare top-level key Langfuse reads. No-op if the bare key is already set
 * (never clobber) or the source is neither a non-blank string NOR a non-empty
 * array (#1339 PR②: `langfuse.trace.tags` is a genuine `string[]` attribute,
 * not a string — see `LANGFUSE_TRACE_TAGS_ATTRIBUTE`'s own doc for why an
 * array survives this lift intact rather than needing to be joined/parsed).
 * Mutates `attributes` in place. Used for trace name/input/tags, which —
 * unlike session id — have no `eve.*` framework fallback, so a plain
 * namespaced→bare lift is all they need.
 *
 * @param {Record<string, unknown>|undefined} attributes
 * @param {string} bareKey the un-prefixed key Langfuse reads (e.g. "langfuse.trace.name")
 * @returns {void}
 */
export function promoteContextAttribute(attributes, bareKey) {
  if (!attributes || attributes[bareKey]) return;
  const value = attributes[`${AI_SDK_CONTEXT_PREFIX}${bareKey}`];
  if (typeof value === "string" && value.trim()) {
    attributes[bareKey] = value;
  } else if (Array.isArray(value) && value.length > 0) {
    attributes[bareKey] = value;
  }
}

/**
 * Wrap a real OTel span processor (the `LangfuseSpanProcessor`) so every span
 * it exports carries the top-level attributes Langfuse reads — session id (via
 * #1198's `eve.session.id`-fallback path) plus trace name/input (via the
 * generic `promoteContextAttribute` lift) — promoted from their
 * AI-SDK-namespaced runtime-context attributes. (Name is a slight misnomer now
 * that it promotes name/input too; kept to avoid blast radius.) The promotion
 * happens in `onEnd`, mutating the span's final `attributes` object in place
 * before delegating — that object is what the processor serializes to OTLP, so
 * the promoted keys reach Langfuse's ingestion and set the trace's
 * sessionId/name/input.
 *
 * Deliberately dependency-free and structural: it touches only
 * `span.attributes` (a plain object) and forwards the processor lifecycle to
 * `inner`, so it is unit-tested with fake spans and a fake inner processor —
 * no `@opentelemetry/sdk-trace-base` import here (same injected-seam
 * convention as `buildSpanProcessors`' `createSpanProcessor`).
 *
 * @param {{ onStart?: Function, onEnd?: Function, forceFlush?: Function, shutdown?: Function }} inner
 * @param {{ sessionIdAttribute?: string, traceNameAttribute?: string, traceInputAttribute?: string, tagsAttribute?: string }} [opts]
 * @returns {{ onStart: Function, onEnd: Function, forceFlush: Function, shutdown: Function }}
 */
export function createSessionPromotingProcessor(
  inner,
  {
    sessionIdAttribute = LANGFUSE_SESSION_ID_ATTRIBUTE,
    traceNameAttribute = LANGFUSE_TRACE_NAME_ATTRIBUTE,
    traceInputAttribute = LANGFUSE_TRACE_INPUT_ATTRIBUTE,
    tagsAttribute = LANGFUSE_TRACE_TAGS_ATTRIBUTE,
  } = {},
) {
  return {
    onStart(span, parentContext) {
      inner?.onStart?.(span, parentContext);
    },
    onEnd(span) {
      // A span processor must never throw — that would break telemetry export
      // for the whole span. Promotion is best-effort: any failure (e.g. a
      // frozen attributes object) is swallowed so the span still exports, just
      // without the promoted attributes.
      try {
        const attributes = span?.attributes;
        if (attributes) {
          // Session id keeps its special eve.session.id fallback path.
          if (!attributes[sessionIdAttribute]) {
            const sessionId = sessionIdFromSpanAttributes(attributes, sessionIdAttribute);
            if (sessionId) attributes[sessionIdAttribute] = sessionId;
          }
          // Trace name/input/tags: plain namespaced→bare lift (no eve.* fallback).
          promoteContextAttribute(attributes, traceNameAttribute);
          promoteContextAttribute(attributes, traceInputAttribute);
          promoteContextAttribute(attributes, tagsAttribute);
        }
      } catch {
        // no-op: never let attribute promotion break span export
      }
      inner?.onEnd?.(span);
    },
    forceFlush() {
      return inner?.forceFlush ? inner.forceFlush() : Promise.resolve();
    },
    shutdown() {
      return inner?.shutdown ? inner.shutdown() : Promise.resolve();
    },
  };
}
