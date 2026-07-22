/**
 * The single source of truth for the console chat model picker (#1288) — the
 * models the chat header dropdown offers, and the env-driven routing map that
 * decides which of them actually resolve to a running Jace.
 *
 * WHY A ROUTING MAP (and not a per-turn model switch): a Jace/Eve process is
 * bound to ONE model at boot (`apps/jace/agent/agent.ts` -> `chooseModel`);
 * Eve's turn API (`receive(module, { message, target, auth })`) carries no
 * per-turn model override, so a single running Jace can only ever answer with
 * its one configured model. Multi-model is therefore a DEPLOY concern: stand
 * up a second Jace instance pinned to model X, then map `X -> that instance's
 * host` here. The console dispatcher (`lib/channel-dispatch.ts`) reads the map
 * and POSTs the turn to the mapped host's hosted-inbound door; an unmapped
 * model falls back to the default `EVE_HOST`.
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
 * e.g. `anthropic/claude-opus-4.8=http://127.0.0.1:2001,z-ai/glm-5.2=http://127.0.0.1:2002`.
 * `baseUrl` is the Jace host root (the dispatcher appends the hosted-inbound
 * path itself), so no trailing `/eve/...`.
 */

export interface ChatModel {
  /** Gateway model id — MUST match the model the target Jace instance is booted with. */
  id: string;
  /** Human label shown in the dropdown. */
  label: string;
}

/**
 * The model Jace actually runs today (`apps/jace/agent/lib/model.core.mjs`'s
 * `GATEWAY_MODEL_ID`). Its endpoint is the default `EVE_HOST`, so it is ALWAYS
 * enabled — the one option guaranteed to route to a running Jace out of the box.
 */
export const DEFAULT_CHAT_MODEL_ID = "anthropic/claude-sonnet-4.6";

/**
 * The models the picker offers. Ids/labels are the real gateway ids this repo
 * already references (`apps/console/lib/alignment/candidates.ts`'s
 * `MODEL_SEATS`) so a wired endpoint's model id lines up with a listed option.
 * The default is first. The rest are display options — they only become
 * selectable once an operator adds them to `CONSOLE_MODEL_ENDPOINTS` AND runs
 * a Jace pinned to that id.
 */
export const CHAT_MODELS: readonly ChatModel[] = [
  { id: DEFAULT_CHAT_MODEL_ID, label: "Claude Sonnet 4.6" },
  { id: "anthropic/claude-opus-4.8", label: "Claude Opus 4.8" },
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "z-ai/glm-5.2", label: "GLM 5.2" },
  { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "moonshotai/kimi-k3", label: "Kimi K3" },
  { id: "openai/gpt-5.1-codex", label: "GPT-5.1 Codex" },
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
