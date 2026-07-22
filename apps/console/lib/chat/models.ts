/**
 * The single source of truth for the console chat model picker (#1288) — the
 * models the chat header dropdown offers, and the env-driven routing map that
 * decides which of them actually resolve to a running Jace.
 *
 * WHY A ROUTING MAP (and not a per-turn model switch): a Jace/Eve process is
 * bound to ONE model at boot (`apps/jace/agent/agent.ts` -> `chooseModel`; in
 * prod that's the OpenRouter openai-compatible endpoint + a single
 * `JACE_MODEL_ID`). Eve's agent definition types the model as a fixed
 * `readonly model: LanguageModel` and its turn API (`receive(module, { message,
 * target, auth })`) carries no per-turn override — so a single running Jace can
 * only ever answer with its one configured model, EVEN THOUGH OpenRouter itself
 * serves every model on this list through the same key. Multi-model is
 * therefore a DEPLOY concern: run a second Jace instance whose `JACE_MODEL_ID`
 * is model X (same OpenRouter key), then map `X -> that instance's host` here.
 * The console dispatcher (`lib/channel-dispatch.ts`) reads the map and POSTs the
 * turn to the mapped host's hosted-inbound door; an unmapped model falls back
 * to the default `EVE_HOST` (the always-running default Jace).
 *
 * HONESTY RULE (no dead control): the dropdown only lets a member SELECT a
 * model that resolves to a real endpoint — the default model (whose endpoint
 * is the always-running default Jace) plus any model present in
 * `CONSOLE_MODEL_ENDPOINTS`. Every other listed model renders DISABLED with a
 * "not enabled" hint until an operator wires an endpoint for it. So until a
 * deployment configures more Jace instances, this is a one-model picker that
 * is upfront about it, never a switch that silently does nothing.
 *
 * `CONSOLE_MODEL_ENDPOINTS` format: comma-separated `modelId=baseUrl` pairs,
 * e.g. `anthropic/claude-sonnet-5=https://jace-claude.up.railway.app,moonshotai/kimi-k2=https://jace-kimi.up.railway.app`.
 * `baseUrl` is the Jace host root (the dispatcher appends the hosted-inbound
 * path itself), so no trailing `/eve/...`.
 */

export interface ChatModel {
  /** OpenRouter model id — MUST exactly match the `JACE_MODEL_ID` the target Jace instance is booted with. */
  id: string;
  /** Human label shown in the dropdown. */
  label: string;
}

/**
 * The model the DEFAULT Jace actually runs today — the `JACE_MODEL_ID` on the
 * primary `jace` service (OpenRouter `z-ai/glm-4.6`). Its endpoint is the
 * default `EVE_HOST`, so it is ALWAYS enabled — the one option guaranteed to
 * route to a running Jace out of the box. If the default service's
 * `JACE_MODEL_ID` ever changes, change this in lockstep (they MUST agree, or
 * the picker mislabels which model actually answers on the default host).
 */
export const DEFAULT_CHAT_MODEL_ID = "z-ai/glm-4.6";

/**
 * The models the picker offers — the exact OpenRouter ids each dedicated Jace
 * instance is booted with (`JACE_MODEL_ID`), so a wired `CONSOLE_MODEL_ENDPOINTS`
 * entry, the running instance, and the listed option all share one id. The
 * default (GLM 4.6, the always-on primary `jace`) is first; each of the others
 * becomes selectable once its instance is running AND mapped in
 * `CONSOLE_MODEL_ENDPOINTS`.
 */
export const CHAT_MODELS: readonly ChatModel[] = [
  { id: DEFAULT_CHAT_MODEL_ID, label: "GLM 4.6" },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "moonshotai/kimi-k2", label: "Kimi K2" },
  { id: "deepseek/deepseek-chat", label: "DeepSeek V3" },
];

/** True when `id` is one of the models the picker knows about. */
export function isKnownChatModelId(id: string): boolean {
  return CHAT_MODELS.some((m) => m.id === id);
}

/** The env subset this module reads — injectable so tests never touch real `process.env`. */
export interface ChatModelEnv {
  CONSOLE_MODEL_ENDPOINTS?: string | undefined;
  [key: string]: string | undefined;
}

/**
 * Parse `CONSOLE_MODEL_ENDPOINTS` into a `modelId -> baseUrl` map. Malformed
 * entries (no `=`, blank id, blank url) are skipped rather than throwing — a
 * typo in one entry must not take the whole picker down. The url has any
 * trailing slash stripped so the dispatcher can append its path cleanly.
 */
export function parseModelEndpoints(env: ChatModelEnv = process.env): Map<string, string> {
  const map = new Map<string, string>();
  const raw = env.CONSOLE_MODEL_ENDPOINTS;
  if (!raw) return map;
  for (const entry of raw.split(",")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const id = entry.slice(0, eq).trim();
    const url = entry.slice(eq + 1).trim().replace(/\/+$/, "");
    if (!id || !url) continue;
    map.set(id, url);
  }
  return map;
}

/**
 * The set of model ids that resolve to a running Jace: the default (always,
 * via `EVE_HOST`) plus every id wired in `CONSOLE_MODEL_ENDPOINTS`.
 */
export function enabledChatModelIds(env: ChatModelEnv = process.env): Set<string> {
  const enabled = new Set<string>([DEFAULT_CHAT_MODEL_ID]);
  for (const id of parseModelEndpoints(env).keys()) enabled.add(id);
  return enabled;
}

/** Whether a model id is selectable (routes to a real endpoint). */
export function isChatModelEnabled(id: string, env: ChatModelEnv = process.env): boolean {
  return enabledChatModelIds(env).has(id);
}

export interface ChatModelOption extends ChatModel {
  enabled: boolean;
}

/**
 * The picker's option list for the client: every known model, each flagged
 * `enabled` per the current routing config. Computed server-side (the page)
 * and passed down as a prop, so the routing env never reaches the browser.
 */
export function chatModelOptions(env: ChatModelEnv = process.env): ChatModelOption[] {
  const enabled = enabledChatModelIds(env);
  return CHAT_MODELS.map((m) => ({ ...m, enabled: enabled.has(m.id) }));
}
