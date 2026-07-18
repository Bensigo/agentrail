// Pure, dependency-free core for creating a workspace from a conversation via
// the console (issue #1264 PR ①) — Jace's other GATED write action on the
// outside world, alongside create_issue (see agent/tools/create_workspace.ts's
// doc-comment for why this carries the console-gated approval, same gate class as
// create_issue). No SDK, no network primitives of its own: the single HTTP
// call is an injected `transport` seam (real `fetch` with a timeout in the
// thin tool wrapper, a fake in tests), so every branch is unit-testable
// without a live server.
//
// Auth + config model: same as fetch_workspace_memory.core.mjs /
// send_connect_link.core.mjs — Jace resolves its own console endpoint +
// bearer from JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN, never the runner's
// ~/.agentrail/credentials.json.
//
// `eveSessionId` is the ONLY identifying input, and it is never model-
// supplied: the tool wrapper reads it off `ctx.session.id` — Eve's own
// session id for the conversation actually invoking this tool. `name` IS
// model-supplied, but that's fine: the human approves the EXACT name before
// this ever runs (console-gated approval).
//
// Failure handling deliberately differs from send_connect_link: THIS
// endpoint's 409 family (apps/console/app/api/v1/runner/workspaces/route.ts)
// is honest by design — a human already approved this specific call in this
// specific conversation, so there is no anti-enumeration reason to hide which
// refusal happened. A 409's own `error` message is surfaced VERBATIM so Jace
// can relay it plainly ("this conversation already has a workspace") instead
// of a vague "something went wrong". Every OTHER non-2xx outcome (400 name
// validation — should not happen given the tool's own zod schema already
// enforces 1-80 chars, but handled the same regardless; 401 auth; 404 the
// endpoint's own DELIBERATELY indistinguishable resolution-failure case,
// covering both "no session" and "no chat identity" so this tool must never
// treat it as a distinct case; 500) collapses to ONE generic honest string,
// same posture as send_connect_link's non-2xx handling.

export const CREATE_WORKSPACE_PATH = "/api/v1/runner/workspaces";

export const GENERIC_FAILURE_MESSAGE = "couldn't create the workspace for this conversation";

/**
 * Resolve the console endpoint + bearer from the environment. Trims both,
 * strips a trailing slash from the base URL, and reports which var(s) are
 * missing. Deliberately duplicated verbatim from send_connect_link.core.mjs /
 * fetch_workspace_memory.core.mjs rather than shared: each core module here is
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
 * Build the create-workspace URL. `eveSessionId` / `name` ride in the POST
 * body, never here — there is nothing to encode into the URL itself.
 *
 * @param {string} baseUrl — already trimmed + de-slashed
 * @returns {string}
 */
export function buildCreateWorkspaceUrl(baseUrl) {
  return `${baseUrl}${CREATE_WORKSPACE_PATH}`;
}

/**
 * Create a workspace for the conversation identified by `eveSessionId`, named
 * `name`. Returns `{ workspaceId, name, url }` on success, or an honest
 * failure string otherwise — never throws. Single attempt, no retry (the
 * console endpoint owns its own slug-collision retry internally).
 *
 *   1. unset console config           -> GENERIC_FAILURE_MESSAGE
 *   2. blank eveSessionId or name     -> GENERIC_FAILURE_MESSAGE (defensive;
 *                                         the framework / zod schema should
 *                                         never hand this a blank value)
 *   3. transport throws               -> GENERIC_FAILURE_MESSAGE
 *   4. status 409                     -> the response body's own `error`
 *                                         string, VERBATIM, when present;
 *                                         GENERIC_FAILURE_MESSAGE otherwise
 *                                         (malformed body / non-JSON)
 *   5. any other non-2xx status       -> GENERIC_FAILURE_MESSAGE (400, 401,
 *                                         404, 500 alike — see module comment)
 *   6. non-JSON / malformed 2xx body  -> GENERIC_FAILURE_MESSAGE
 *   7. success                        -> { workspaceId, name, url }
 *
 * @param {{ eveSessionId: string, name: string, env?: Record<string, string|undefined>,
 *           transport: (url: string, init: { method: string, headers: Record<string,string>, body: string }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }> }} args
 * @returns {Promise<{ workspaceId: string, name: string, url: string } | string>}
 */
export async function runCreateWorkspace({ eveSessionId, name, env = {}, transport }) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return GENERIC_FAILURE_MESSAGE;

  const sessionId = String(eveSessionId ?? "").trim();
  if (!sessionId) return GENERIC_FAILURE_MESSAGE;

  const trimmedName = String(name ?? "").trim();
  if (!trimmedName) return GENERIC_FAILURE_MESSAGE;

  const url = buildCreateWorkspaceUrl(cfg.baseUrl);

  let res;
  try {
    res = await transport(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ eveSessionId: sessionId, name: trimmedName }),
    });
  } catch {
    // Network error / DNS / timeout — a single failed attempt, reported not retried.
    return GENERIC_FAILURE_MESSAGE;
  }

  const status = Number(res && res.status);

  if (status < 200 || status >= 300) {
    if (status === 409) {
      let errorBody;
      try {
        errorBody = await res.json();
      } catch {
        return GENERIC_FAILURE_MESSAGE;
      }
      if (errorBody && typeof errorBody === "object" && typeof errorBody.error === "string" && errorBody.error) {
        return errorBody.error;
      }
    }
    return GENERIC_FAILURE_MESSAGE;
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return GENERIC_FAILURE_MESSAGE;
  }

  if (
    !body ||
    typeof body !== "object" ||
    typeof body.workspaceId !== "string" ||
    !body.workspaceId ||
    typeof body.name !== "string" ||
    !body.name ||
    typeof body.url !== "string" ||
    !body.url
  ) {
    return GENERIC_FAILURE_MESSAGE;
  }

  return { workspaceId: body.workspaceId, name: body.name, url: body.url };
}
