// Pure, dependency-free core for minting a one-time connect-GitHub link via
// the console (issue #1263 PR ②) — Jace's other write action on the outside
// world, alongside create_issue, but a much narrower one (see
// agent/tools/send_connect_link.ts's doc-comment for why it carries no
// approval gate). No SDK, no network primitives of its own: the single HTTP
// call is an injected `transport` seam (real `fetch` with a timeout in the
// thin tool wrapper, a fake in tests), so every branch is unit-testable
// without a live server.
//
// Auth + config model: same as fetch_workspace_memory.core.mjs — Jace
// resolves its own console endpoint + bearer from JACE_CONSOLE_BASE_URL /
// JACE_CONSOLE_TOKEN, never the runner's ~/.agentrail/credentials.json.
//
// `eveSessionId` is the ONLY identifying input, and it is never model-
// supplied: the tool wrapper reads it off `ctx.session.id` — Eve's own
// session id for the conversation actually invoking this tool. From THIS
// caller, that means links are only ever minted for the calling
// conversation's own chat identity. At the HTTP layer the guarantee is
// narrower: the endpoint accepts any session-id string, so what the input
// change actually closes is the guessable (platform, platformUserId) vector
// — an opaque runtime session id replaces it, and the server adds tenant
// cross-checks on both the identity's and the session's workspace vs the
// bearer. A valid bearer minting for a never-connected intro identity
// remains an accepted, narrowed residual (compensating control: Jace only
// ever delivers links in-thread; redemption guards backstop stale links).
// See apps/console/app/api/v1/runner/connect-link/route.ts's doc-comment for
// the authoritative closes/residual statement, and #1295 for the open
// confirmations (session-id entropy, bearer scoping).
//
// On ANY failure — unset config, a blank eveSessionId, an unreachable
// console, or a non-2xx (the console's 404 covers "no chat identity yet",
// "already linked to someone else", and "linked to a different workspace"
// all indistinguishably, by design) — this returns ONE honest, generic
// failure string rather than a per-reason breakdown: unlike
// fetch_workspace_memory (diagnostic data Jace reads), this is a WRITE Jace
// is about to narrate mid-conversation, and a finer reason would risk
// leaking which of the console's indistinguishable 404 cases this was — the
// exact anti-enumeration property the route's 404 exists to protect.

export const CONNECT_LINK_PATH = "/api/v1/runner/connect-link";

export const FAILURE_MESSAGE = "couldn't mint a link for this conversation";

/**
 * Resolve the console endpoint + bearer from the environment. Trims both,
 * strips a trailing slash from the base URL, and reports which var(s) are
 * missing. Deliberately duplicated verbatim from fetch_workspace_memory.core.mjs
 * / fetch_run_evidence.core.mjs rather than shared: each core module here is
 * pure and dependency-free of the others by design.
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

/**
 * Build the connect-link mint URL. `eveSessionId` rides in the POST body,
 * never here — there is nothing to encode into the URL itself.
 *
 * @param {string} baseUrl — already trimmed + de-slashed
 * @returns {string}
 */
export function buildConnectLinkUrl(baseUrl) {
  return `${baseUrl}${CONNECT_LINK_PATH}`;
}

/**
 * Mint a one-time connect-GitHub link for the conversation identified by
 * `eveSessionId`, or the honest {@link FAILURE_MESSAGE} string. Single
 * attempt, no retry, never throws:
 *
 *   1. unset console config      → FAILURE_MESSAGE
 *   2. blank eveSessionId        → FAILURE_MESSAGE (defensive; the framework
 *                                   should never hand the tool an empty one)
 *   3. transport throws          → FAILURE_MESSAGE
 *   4. non-2xx status            → FAILURE_MESSAGE (covers the console's
 *                                   indistinguishable-by-design 404 AND every
 *                                   other error alike — see module comment)
 *   5. non-JSON / malformed body → FAILURE_MESSAGE
 *   6. success                   → { url, expiresAt }
 *
 * @param {{ eveSessionId: string, env?: Record<string, string|undefined>,
 *           transport: (url: string, init: { method: string, headers: Record<string,string>, body: string }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }> }} args
 * @returns {Promise<{ url: string, expiresAt: string } | string>}
 */
export async function sendConnectLink({ eveSessionId, env = {}, transport }) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return FAILURE_MESSAGE;

  const sessionId = String(eveSessionId ?? "").trim();
  if (!sessionId) return FAILURE_MESSAGE;

  const url = buildConnectLinkUrl(cfg.baseUrl);

  let res;
  try {
    res = await transport(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ eveSessionId: sessionId }),
    });
  } catch {
    // Network error / DNS / timeout — a single failed attempt, reported not retried.
    return FAILURE_MESSAGE;
  }

  const status = Number(res && res.status);
  if (status < 200 || status >= 300) return FAILURE_MESSAGE;

  let body;
  try {
    body = await res.json();
  } catch {
    return FAILURE_MESSAGE;
  }

  if (
    !body ||
    typeof body !== "object" ||
    typeof body.url !== "string" ||
    !body.url ||
    typeof body.expiresAt !== "string" ||
    !body.expiresAt
  ) {
    return FAILURE_MESSAGE;
  }

  return { url: body.url, expiresAt: body.expiresAt };
}
