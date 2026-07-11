// Pure, dependency-free model selection for Jace's Eve agent.
//
// Jace resolves its language model from the environment so the SAME app runs
// unchanged in production (Vercel AI Gateway string id) and against any
// self-hosted OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, LiteLLM, ...).
// This module makes ONLY the decision — no SDK import, no network — so it is
// unit-testable without installing the AI SDK. `agent.ts` turns the decision
// into a concrete model (a string for the gateway, or an
// `@ai-sdk/openai-compatible` instance for a custom endpoint).

/** Production default: a string model id that routes through the Vercel AI Gateway. */
export const GATEWAY_MODEL_ID = "anthropic/claude-sonnet-4.6";

/**
 * A cheaper, haiku-class gateway model id. Subagents whose job is small,
 * bounded, and mechanical (e.g. the `triage` diagnostician, which only reads a
 * failure bundle and shapes it into a fixed schema) pass this as the
 * `gatewayModelId` override so they run on the cheap tier in production while
 * root Jace stays on the stronger default. It only affects the gateway path;
 * in self-hosted openai-compatible mode the operator's `JACE_MODEL_ID` governs.
 */
export const HAIKU_GATEWAY_MODEL_ID = "anthropic/claude-haiku-4.5";

/** Default model id used when an OpenAI-compatible endpoint is configured without one. */
export const DEFAULT_COMPATIBLE_MODEL_ID = "gemma4:latest";

/**
 * Default context-window size (tokens) reported to Eve for a custom
 * OpenAI-compatible model. Eve resolves gateway models' windows from the AI
 * Gateway catalog, but a self-hosted model has no catalog entry — and Eve
 * REFUSES TO BOOT if it cannot resolve one (it needs the window to compile the
 * compaction trigger). So in openai-compatible mode we always supply a value.
 * This only shifts WHEN compaction fires (thresholdPercent × window); operators
 * set `JACE_MODEL_CONTEXT_WINDOW_TOKENS` to match their model / Ollama `num_ctx`.
 * 8192 is Ollama's common default context length.
 */
export const DEFAULT_COMPATIBLE_CONTEXT_WINDOW_TOKENS = 8192;

/**
 * Parse a positive-integer token count, falling back to the default when unset,
 * blank, non-numeric, zero, or negative. Requires the WHOLE trimmed value to be
 * digits — a strict parse, so `"12.5abc"` (which `parseInt` would salvage to 12)
 * is rejected as garbage rather than silently truncated.
 *
 * @param {string|number|undefined} raw
 * @returns {number}
 */
function parseContextWindowTokens(raw) {
  const s = String(raw ?? "").trim();
  if (!/^\d+$/.test(s)) return DEFAULT_COMPATIBLE_CONTEXT_WINDOW_TOKENS;
  const n = Number(s);
  return n > 0 ? n : DEFAULT_COMPATIBLE_CONTEXT_WINDOW_TOKENS;
}

/**
 * Decide which model Jace should use, from environment variables.
 *
 * - No `JACE_MODEL_BASE_URL` (the default): use the AI Gateway string id
 *   `GATEWAY_MODEL_ID` — the production path. Eve resolves the context window
 *   from the gateway catalog, so none is returned here.
 * - `JACE_MODEL_BASE_URL` set: use an OpenAI-compatible endpoint at that URL,
 *   with model `JACE_MODEL_ID` (default `DEFAULT_COMPATIBLE_MODEL_ID`), an
 *   optional bearer `JACE_MODEL_API_KEY` (omitted when unset — Ollama needs
 *   none), and `contextWindowTokens` (from `JACE_MODEL_CONTEXT_WINDOW_TOKENS`,
 *   default `DEFAULT_COMPATIBLE_CONTEXT_WINDOW_TOKENS`) that `agent.ts` forwards
 *   to Eve as `modelContextWindowTokens` so Eve can boot without a catalog entry.
 *
 * An optional `gatewayModelId` override lets a subagent pick a different gateway
 * model (e.g. a haiku-class tier) WITHOUT changing the self-hosted path: the
 * override applies only to the gateway branch, so an operator who points Jace at
 * an OpenAI-compatible endpoint still gets exactly the model they configured for
 * every agent. Omitting `opts` (the root/existing callers) is unchanged.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{ gatewayModelId?: string }} [opts]
 * @returns {{ kind: "gateway", modelId: string }
 *          | { kind: "openai-compatible", baseURL: string, modelId: string, contextWindowTokens: number, apiKey?: string, name: string }}
 */
export function chooseModel(env = {}, opts = {}) {
  const gatewayModelId =
    String(opts.gatewayModelId ?? "").trim() || GATEWAY_MODEL_ID;
  const baseURL = String(env.JACE_MODEL_BASE_URL ?? "").trim();
  if (!baseURL) {
    return { kind: "gateway", modelId: gatewayModelId };
  }
  const modelId =
    String(env.JACE_MODEL_ID ?? "").trim() || DEFAULT_COMPATIBLE_MODEL_ID;
  const rawKey = String(env.JACE_MODEL_API_KEY ?? "").trim();
  const choice = {
    kind: "openai-compatible",
    baseURL,
    modelId,
    contextWindowTokens: parseContextWindowTokens(
      env.JACE_MODEL_CONTEXT_WINDOW_TOKENS,
    ),
    name: "jace-openai-compatible",
  };
  if (rawKey) choice.apiKey = rawKey;
  return choice;
}
