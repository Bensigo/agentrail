// Pure, dependency-free core for creating a GitHub repository on the
// workspace's own GitHub account, on behalf of a conversation, via the
// console (issue #1265 PR ①: apps/console/app/api/v1/runner/repos/route.ts)
// — Jace's THIRD gated write action on the outside world, alongside
// create_issue and create_workspace (see agent/tools/create_repo.ts's
// doc-comment for why this carries approval: always(), same gate class).
// No SDK, no network primitives of its own: the single HTTP call is an
// injected `transport` seam (real `fetch` with a timeout in the thin tool
// wrapper, a fake in tests), so every branch is unit-testable without a live
// server.
//
// Auth + config model: same as create_workspace.core.mjs / fetch_workspace_
// memory.core.mjs / send_connect_link.core.mjs — Jace resolves its own
// console endpoint + bearer from JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN,
// never the runner's ~/.agentrail/credentials.json.
//
// `eveSessionId` is the ONLY identifying input, and it is never model-
// supplied: the tool wrapper reads it off `ctx.session.id` — Eve's own
// session id for the conversation actually invoking this tool. `name` (and,
// optionally, `private`) ARE model-supplied, but that's fine: the human
// approves the EXACT call before this ever runs (approval: always()).
// `private`, when omitted, is left out of the request body entirely so the
// console's own default (private) wins — this core never invents its own
// default, that would be a second source of truth for it.
//
// Failure handling mirrors create_workspace, with one addition for AC3: THIS
// endpoint's 409 family is honest by design — a human already approved this
// specific call in this specific conversation, so there is no anti-
// enumeration reason to hide which refusal happened. A 409's own `error`
// message is surfaced VERBATIM so Jace can relay it plainly, EXCEPT the
// name-taken case, which gets a short retry nudge appended (issue #1265
// AC3: "failure surfaces honestly in-thread with a retry path") — the other
// 409s (no workspace, no token, stale credentials) already tell the user
// what to do, so nothing is added. Every OTHER non-2xx outcome (400 name
// validation; 401 auth; 404 the endpoint's own deliberately-indistinguishable
// resolution-failure case; 500; 502 GitHub-call failures) collapses to ONE
// generic honest string, same posture as create_workspace's non-2xx
// handling.

export const CREATE_REPO_PATH = "/api/v1/runner/repos";

export const GENERIC_FAILURE_MESSAGE = "couldn't create the repo for this conversation";

// Matches the route's own name-taken 409 wording ("a repo named <name>
// already exists on your GitHub") without depending on the exact requested
// name — see apps/console/app/api/v1/runner/repos/route.ts's
// `isNameTakenError`, the source of truth this mirrors on the read side.
// None of the route's other 409 messages (no-workspace, no-token,
// stale-credentials) contain this phrase.
const NAME_TAKEN_RE = /already exists on your GitHub$/;
const NAME_TAKEN_RETRY_SUFFIX = " — pick another name and I'll try again";

/**
 * Resolve the console endpoint + bearer from the environment. Trims both,
 * strips a trailing slash from the base URL, and reports which var(s) are
 * missing. Deliberately duplicated verbatim from create_workspace.core.mjs /
 * send_connect_link.core.mjs / fetch_workspace_memory.core.mjs rather than
 * shared: each core module here is pure and dependency-free of the others by
 * design.
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
 * Build the create-repo URL. `eveSessionId` / `name` / `private` ride in the
 * POST body, never here — there is nothing to encode into the URL itself.
 *
 * @param {string} baseUrl — already trimmed + de-slashed
 * @returns {string}
 */
export function buildCreateRepoUrl(baseUrl) {
  return `${baseUrl}${CREATE_REPO_PATH}`;
}

/**
 * Create a GitHub repository for the conversation identified by
 * `eveSessionId`, named `name` (optionally `private`). Returns
 * `{ url, fullName, private, webhookCreated, onboardQueued }` on success, or
 * an honest failure string otherwise — never throws. Single attempt, no
 * retry (the console endpoint owns the GitHub call and the connect chain
 * internally).
 *
 *   1. unset console config           -> GENERIC_FAILURE_MESSAGE
 *   2. blank eveSessionId or name      -> GENERIC_FAILURE_MESSAGE (defensive;
 *                                          the framework / zod schema should
 *                                          never hand this a blank value)
 *   3. transport throws                -> GENERIC_FAILURE_MESSAGE
 *   4. status 409, name-taken shape    -> the response body's own `error`
 *                                          string PLUS a retry nudge (AC3)
 *   5. status 409, any other shape     -> the response body's own `error`
 *                                          string, VERBATIM (no-workspace /
 *                                          no-token / stale-credentials
 *                                          already tell the user what to do)
 *   6. status 409, malformed body      -> GENERIC_FAILURE_MESSAGE
 *   7. any other non-2xx status        -> GENERIC_FAILURE_MESSAGE (400, 401,
 *                                          404, 500, 502 alike — see module
 *                                          comment)
 *   8. non-JSON / malformed 2xx body   -> GENERIC_FAILURE_MESSAGE
 *   9. success                         -> { url, fullName, private,
 *                                          webhookCreated, onboardQueued }
 *
 * @param {{ eveSessionId: string, name: string, private?: boolean,
 *           env?: Record<string, string|undefined>,
 *           transport: (url: string, init: { method: string, headers: Record<string,string>, body: string }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }> }} args
 * @returns {Promise<{ url: string, fullName: string, private: boolean, webhookCreated: boolean, onboardQueued: boolean } | string>}
 */
export async function runCreateRepo({ eveSessionId, name, private: isPrivate, env = {}, transport }) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return GENERIC_FAILURE_MESSAGE;

  const sessionId = String(eveSessionId ?? "").trim();
  if (!sessionId) return GENERIC_FAILURE_MESSAGE;

  const trimmedName = String(name ?? "").trim();
  if (!trimmedName) return GENERIC_FAILURE_MESSAGE;

  const url = buildCreateRepoUrl(cfg.baseUrl);

  const requestBody = { eveSessionId: sessionId, name: trimmedName };
  if (typeof isPrivate === "boolean") {
    requestBody.private = isPrivate;
  }

  let res;
  try {
    res = await transport(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
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
        return NAME_TAKEN_RE.test(errorBody.error)
          ? `${errorBody.error}${NAME_TAKEN_RETRY_SUFFIX}`
          : errorBody.error;
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

  const repo = body && typeof body === "object" ? body.repo : null;
  if (
    !repo ||
    typeof repo !== "object" ||
    typeof repo.fullName !== "string" ||
    !repo.fullName ||
    typeof repo.url !== "string" ||
    !repo.url ||
    typeof repo.private !== "boolean" ||
    typeof body.webhookCreated !== "boolean" ||
    typeof body.onboardQueued !== "boolean"
  ) {
    return GENERIC_FAILURE_MESSAGE;
  }

  return {
    url: repo.url,
    fullName: repo.fullName,
    private: repo.private,
    webhookCreated: body.webhookCreated,
    onboardQueued: body.onboardQueued,
  };
}
