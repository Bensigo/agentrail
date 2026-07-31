// Pure, dependency-free core for a capped textual usage search over a
// workspace's connected GitHub repo — one of the reviewer's four context
// tools that let it investigate beyond the diff alone, resolving
// callers/usages of a changed or removed exported symbol so blast radius is
// judged from evidence instead of a disclaimer (design:
// docs/superpowers/specs/2026-07-31-reviewer-judgment-engine-design.md §2).
// No SDK, no network primitives of its own: the single HTTP call is an
// injected `transport` seam (real `fetch` in the thin tool wrapper, a fake in
// tests), so every branch — including every degraded one — is
// unit-testable without a live server. Transcribes fetch_pr_diff.core.mjs's
// own structure exactly (PATH const, duplicated resolveConsoleConfig,
// URLSearchParams-built URL, the same classifyStatus table, degraded(),
// single-attempt fetch fn) — see that file's own doc-comment for the full
// reasoning behind the shared shape and the `eveSessionId` resolution note.
//
// Auth + config model: same as the sibling *.core.mjs modules across this
// app — Jace resolves its own console endpoint + bearer from
// JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN.
//
// `query` here is the caller-facing name (matching the tool's zod input
// field); the console route's own query-string parameter is the shorter `q`
// (matching runner/code-search's own contract) — this module's argument name
// and the URL key it lands in are deliberately different, not a typo.

export const CODE_SEARCH_PATH = "/api/v1/runner/code-search";

// Stable, cause-free notes for each degraded outcome. They describe the
// RETRIEVAL gap, never the search's contents — the reviewer must not turn a
// fetch problem into a fabricated claim about who calls what.
const DEGRADED_NOTES = {
  config_missing:
    "The console code-search endpoint is not configured for this Jace deployment (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); no search could be run.",
  bad_request:
    "The search request was malformed (missing/blank repo or query); no search could be run.",
  unreachable:
    "The console code-search endpoint could not be reached (network error); no search could be run. Do not retry from here.",
  unauthorized:
    "The console rejected the request (401/403) — the stored GitHub credentials for this workspace may be stale or revoked.",
  not_found:
    "The console found no session for this conversation, or this repo is not connected to the workspace (404).",
  conflict:
    "The workspace or its GitHub connection is not fully set up yet (409).",
  rate_limited: "GitHub's code-search rate limit was hit; no search could be run right now.",
  upstream_error: "The console or GitHub errored (5xx); no search could be run.",
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
 * Build the GET .../code-search URL. `eveSessionId` is what the console
 * resolves the real tenant from server-side (via the jace_sessions ledger);
 * `repo` scopes the search server-side; `query` rides as the route's own `q`
 * param.
 *
 * @param {string} baseUrl — already trimmed + de-slashed
 * @param {string} eveSessionId
 * @param {string} repo
 * @param {string} query
 * @returns {string}
 */
export function buildCodeSearchUrl(baseUrl, eveSessionId, repo, query) {
  const params = new URLSearchParams();
  params.set("eveSessionId", eveSessionId);
  params.set("repo", repo);
  params.set("q", query);
  return `${baseUrl}${CODE_SEARCH_PATH}?${params.toString()}`;
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
 * Run a capped textual code search, or a degraded result. Single attempt, no
 * retry, never throws:
 *
 *   1. blank eveSessionId/repo/query  -> degraded("bad_request")
 *   2. unset console config          -> degraded("config_missing", { missing })
 *   3. transport throws              -> degraded("unreachable")
 *   4. non-2xx status                -> degraded(<mapped reason>, { status })
 *   5. non-JSON body                 -> degraded("bad_body", { status })
 *   6. success                       -> { ok:true, totalCount, note, results }
 *
 * `results` is GitHub's own textual matches, never a compiled call graph —
 * the console's `note` field carries that caveat verbatim; this core does not
 * re-derive or reword it.
 *
 * @param {{ env?: Record<string, string|undefined>, eveSessionId: string,
 *           repo: string, query: string,
 *           transport: (url: string, init: { headers: Record<string,string> }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }> }} args
 */
export async function searchCode({ env = {}, eveSessionId, repo, query, transport }) {
  const sessionId = String(eveSessionId ?? "").trim();
  const repoTrimmed = String(repo ?? "").trim();
  const queryTrimmed = String(query ?? "").trim();
  if (!sessionId || !repoTrimmed || !queryTrimmed) {
    return degraded("bad_request");
  }

  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return degraded("config_missing", { missing: cfg.missing });

  const url = buildCodeSearchUrl(cfg.baseUrl, sessionId, repoTrimmed, queryTrimmed);

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
    totalCount: typeof body.totalCount === "number" ? body.totalCount : 0,
    note: typeof body.note === "string" ? body.note : "",
    results: Array.isArray(body.results) ? body.results : [],
  };
}
