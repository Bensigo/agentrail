// Pure, dependency-free core for fetching a PR's metadata + diff from the
// AgentRail console — the ONE read the reviewer subagent needs to judge a
// pull request. No SDK, no network primitives of its own: the single HTTP
// call is an injected `transport` seam (real `fetch` in the thin tool
// wrapper, a fake in tests), so every branch — including every degraded one
// — is unit-testable without a live server.
//
// Auth + config model: same as the sibling *.core.mjs modules across this
// app — Jace resolves its own console endpoint + bearer from
// JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN.
//
// `eveSessionId` here is NOT `ctx.session.id` read directly the way root's
// tools do it — this core is called from a DECLARED SUBAGENT's tool
// (tools/fetch_pr_diff.ts), and eve gives every delegated subagent its own
// CHILD session (node_modules/eve/docs/subagents.mdx: "Each delegated
// subagent spins up its own child session"). The tool wrapper resolves the
// value THIS module receives as `eveSessionId` from
// `ctx.session.parent?.rootSessionId ?? ctx.session.id` — see that file's
// own doc-comment for the full reasoning. This module itself stays agnostic
// to that distinction: it just sends whatever string it's given.

export const PR_REVIEW_PATH = "/api/v1/runner/pr-review";

// Stable, cause-free notes for each degraded outcome. They describe the
// RETRIEVAL gap, never the PR's contents — the reviewer must not turn a
// fetch problem into a fabricated review.
const DEGRADED_NOTES = {
  config_missing:
    "The console PR-review endpoint is not configured for this Jace deployment (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); no diff could be fetched.",
  bad_request:
    "The diff request was malformed (missing/blank repo or prNumber); no diff could be fetched.",
  unreachable:
    "The console PR-review endpoint could not be reached (network error); no diff could be fetched. Do not retry from here.",
  unauthorized:
    "The console rejected the request (401/403) — the stored GitHub credentials for this workspace may be stale or revoked.",
  not_found:
    "The console found no PR, or this repo is not connected to the workspace (404).",
  conflict:
    "The workspace or its GitHub connection is not fully set up yet (409).",
  rate_limited: "GitHub's rate limit was hit; no diff could be fetched right now.",
  upstream_error: "The console or GitHub errored (5xx); no diff could be fetched.",
  unexpected_status: "The console returned an unexpected status.",
  bad_body: "The console responded, but the body was not valid JSON.",
};

/**
 * Resolve the console endpoint + bearer from the environment. Trims both,
 * strips a trailing slash from the base URL, and reports which var(s) are
 * missing. Deliberately duplicated verbatim from the sibling *.core.mjs
 * modules rather than shared: each core module here is pure and
 * dependency-free of the others by design.
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
 * Build the GET .../pr-review URL. `eveSessionId` is what the console
 * resolves the real tenant from server-side (via the jace_sessions ledger);
 * `repo` and `prNumber` name which PR.
 *
 * @param {string} baseUrl — already trimmed + de-slashed
 * @param {string} eveSessionId
 * @param {string} repo
 * @param {number} prNumber
 * @returns {string}
 */
export function buildPrDiffUrl(baseUrl, eveSessionId, repo, prNumber) {
  const params = new URLSearchParams();
  params.set("eveSessionId", eveSessionId);
  params.set("repo", repo);
  params.set("prNumber", String(prNumber));
  return `${baseUrl}${PR_REVIEW_PATH}?${params.toString()}`;
}

/**
 * Map an HTTP status to an outcome. 2xx -> ok; everything else -> a specific
 * degraded reason. No status triggers a retry — a failed fetch is reported,
 * not re-attempted.
 * @param {number} status
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 400) return { ok: false, reason: "bad_request" };
  if (status === 401 || status === 403) return { ok: false, reason: "unauthorized" };
  if (status === 404) return { ok: false, reason: "not_found" };
  if (status === 409) return { ok: false, reason: "conflict" };
  if (status === 429) return { ok: false, reason: "rate_limited" };
  if (status >= 500) return { ok: false, reason: "upstream_error" };
  return { ok: false, reason: "unexpected_status" };
}

/**
 * Build a degraded result. Always carries `ok:false` + `degraded:true` + a
 * stable `reason` + a cause-free `note`; extra fields (e.g. `missing`,
 * `status`) ride along. Deliberately carries NO free-form error text from
 * the transport, so nothing untrusted or secret-shaped can ride out.
 * @param {string} reason
 * @param {Record<string, unknown>} [extra]
 */
export function degraded(reason, extra = {}) {
  return {
    ok: false,
    degraded: true,
    reason,
    note: DEGRADED_NOTES[reason] ?? DEGRADED_NOTES.unexpected_status,
    ...extra,
  };
}

/**
 * Fetch a PR's metadata + diff, or a degraded result. Single attempt, no
 * retry, never throws:
 *
 *   1. blank eveSessionId/repo, or a
 *      non-positive-integer prNumber   -> degraded("bad_request")
 *   2. unset console config           -> degraded("config_missing", { missing })
 *   3. transport throws               -> degraded("unreachable")
 *   4. non-2xx status                 -> degraded(<mapped reason>, { status })
 *   5. non-JSON body                  -> degraded("bad_body", { status })
 *   6. success                        -> { ok:true, repo, prNumber, title,
 *                                        author, baseRef, headRef, body,
 *                                        changedFiles, truncated, omittedPaths }
 *
 * @param {{ env?: Record<string, string|undefined>, eveSessionId: string,
 *           repo: string, prNumber: number,
 *           transport: (url: string, init: { headers: Record<string,string> }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }> }} args
 */
export async function fetchPrDiff({ env = {}, eveSessionId, repo, prNumber, transport }) {
  const sessionId = String(eveSessionId ?? "").trim();
  const repoTrimmed = String(repo ?? "").trim();
  const prNum = Number(prNumber);
  if (!sessionId || !repoTrimmed || !Number.isInteger(prNum) || prNum <= 0) {
    return degraded("bad_request");
  }

  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return degraded("config_missing", { missing: cfg.missing });

  const url = buildPrDiffUrl(cfg.baseUrl, sessionId, repoTrimmed, prNum);

  let res;
  try {
    res = await transport(url, {
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" },
    });
  } catch {
    // Network error / DNS / timeout — a single failed attempt, reported not retried.
    return degraded("unreachable");
  }

  const status = Number(res && res.status);
  const cls = classifyStatus(status);
  if (!cls.ok) return degraded(cls.reason, { status });

  let body;
  try {
    body = await res.json();
  } catch {
    return degraded("bad_body", { status });
  }
  if (!body || typeof body !== "object") return degraded("bad_body", { status });

  return {
    ok: true,
    repo: repoTrimmed,
    prNumber: prNum,
    title: typeof body.title === "string" ? body.title : "",
    author: typeof body.author === "string" ? body.author : "",
    baseRef: typeof body.baseRef === "string" ? body.baseRef : "",
    headRef: typeof body.headRef === "string" ? body.headRef : "",
    body: typeof body.body === "string" ? body.body : "",
    changedFiles: Array.isArray(body.changedFiles) ? body.changedFiles : [],
    truncated: body.truncated === true,
    omittedPaths: Array.isArray(body.omittedPaths) ? body.omittedPaths : [],
  };
}
