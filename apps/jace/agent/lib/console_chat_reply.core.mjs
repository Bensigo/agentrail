// Pure, dependency-free core for Jace's console-chat WORKER SENDER (#1288
// PR②) — the console-facing half of `agent/channels/console.ts`'s
// `message.completed` handler. Jace has no direct Postgres access (this repo
// deliberately excludes apps/jace from its pnpm workspace — see that channel
// file's own header comment), so a completed console-chat reply becomes a
// `jace_messages` row by POSTing back to the console's own
// `POST /api/v1/runner/chat-reply` — an authenticated HTTP call, not a DB
// write, mirroring how every other channel delivers its reply (just to the
// console's own storage instead of an external platform API).
//
// Unlike this directory's TOOL-facing core modules (create_workspace.core.mjs,
// fetch_workspace_memory.core.mjs, send_connect_link.core.mjs, ...) — which
// never throw and instead return a degraded/failure value the model can
// relay — this mirrors imessage.ts's `buildImessageHandle().post()` /
// telegram.ts's `channel.telegram.post()` instead: it's called from a
// channel's `message.completed` EVENT HANDLER, not a tool a model calls, so
// there is no "hand the model a clean string" contract. A delivery failure
// here THROWS, same as every other channel's post — the caller lets it
// propagate unguarded.
//
// Same env resolution as every other Jace->console core module
// (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); deliberately duplicated
// verbatim rather than shared — see create_workspace.core.mjs's own note on
// why each core module here stays dependency-free of the others.

export const CHAT_REPLY_PATH = "/api/v1/runner/chat-reply";

/**
 * Resolve the console endpoint + bearer from the environment. Trims both,
 * strips a trailing slash from the base URL, and reports which var(s) are
 * missing.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ ok: true, baseUrl: string, token: string } | { ok: false, missing: string[] }}
 */
export function resolveConsoleConfig(env = {}) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  const missing = [];
  if (!baseUrl) missing.push("JACE_CONSOLE_BASE_URL");
  if (!token) missing.push("JACE_CONSOLE_TOKEN");
  if (missing.length) return { ok: false, missing };
  return { ok: true, baseUrl, token };
}

/** Build the chat-reply URL. */
export function buildChatReplyUrl(baseUrl) {
  return `${baseUrl}${CHAT_REPLY_PATH}`;
}

/**
 * POST a completed console-chat reply back to the console so it lands as a
 * `jace_messages` row. Throws on ANY failure (unset config, a network error,
 * or a non-2xx response) — the caller (`agent/channels/console.ts`'s
 * `message.completed` handler) lets it propagate, exactly like every other
 * channel's post().
 *
 * @param {{ workspaceId: string, conversationKey: string, text: string,
 *           env?: Record<string, string|undefined>,
 *           transport: (url: string, init: { method: string, headers: Record<string,string>, body: string }) =>
 *             Promise<{ status: number }> }} args
 * @returns {Promise<void>}
 */
export async function postConsoleChatReply({ workspaceId, conversationKey, text, env = {}, transport }) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) {
    throw new Error(
      `console chat reply: missing ${cfg.missing.join(", ")} — cannot deliver Jace's reply.`,
    );
  }

  const res = await transport(buildChatReplyUrl(cfg.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify({ workspaceId, conversationKey, text }),
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`console chat reply: console returned ${res.status}`);
  }
}
