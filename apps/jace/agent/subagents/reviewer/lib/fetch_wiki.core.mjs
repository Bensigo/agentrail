// Pure, dependency-free core for reading a workspace's connected repo's
// COMPILED WIKI (list/get/search) against the existing `runner/repo-wiki`
// route — one of the reviewer's four context tools that let it investigate
// beyond the diff alone, resolving the recorded conventions/structure a
// change should be judged against (design:
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
// UNLIKE root's own fetch_repo_wiki tool (agent/lib/fetch_repo_wiki.core.mjs)
// — which renders hardened, provenance-framed prose blocks because it feeds
// the coordinator's chat surface directly — this core stays RAW, matching
// every sibling in this directory: no hardenUntrusted, no rendering, no
// cross-core import. The reviewer's own untrusted-content handling lives at
// the prompt layer (instructions.md) and, as the enforced backstop, at
// root's write seam (post_pr_review hardens every field before it reaches
// GitHub) — never duplicated into this module (per this arc's read-only
// posture: "raw data out", the write seam is the backstop).
//
// MODE DERIVATION is this tool's own contract, distinct from root's version
// (which takes `mode` as an explicit input): the reviewer's `fetch_wiki` only
// exposes `slug`/`query` to the model, and this core derives which of the
// route's three modes to call — `slug` present -> "get", else `query`
// present -> "search", else -> "list" (slug wins if both are given: a
// specific-page request is more specific than a search request).
//
// Auth + config model: same as the sibling *.core.mjs modules across this
// app — Jace resolves its own console endpoint + bearer from
// JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN. Unlike its three siblings here,
// this route does not itself call GitHub (it reads AgentRail's own Postgres
// wiki store), so its unauthorized/conflict notes are worded without
// referencing "GitHub credentials"/"GitHub connection".

export const REPO_WIKI_PATH = "/api/v1/runner/repo-wiki";

// Stable, cause-free notes for each degraded outcome. They describe the
// RETRIEVAL gap, never the wiki's contents — the reviewer must not turn a
// fetch problem into a fabricated architecture claim.
const DEGRADED_NOTES = {
  config_missing:
    "The console repo-wiki endpoint is not configured for this Jace deployment (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); the repo wiki is not available.",
  bad_request:
    "The wiki request was malformed (missing/blank repo); the repo wiki is not available.",
  unreachable:
    "The console repo-wiki endpoint could not be reached (network error); the repo wiki is not available. Do not retry from here.",
  unauthorized:
    "The console rejected the request (401/403) — the configured JACE_CONSOLE_TOKEN may be invalid.",
  not_found:
    "The console found no wiki page at that slug, or this repo is not connected to the workspace (404).",
  conflict: "The workspace is not fully set up yet (409).",
  rate_limited: "The console's rate limit was hit; the repo wiki is not available right now.",
  upstream_error: "The console errored (5xx); the repo wiki is not available.",
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
 * Derive which of the route's three modes to call from the two model-facing
 * inputs: `slug` present (non-blank after trim) -> "get"; else `query`
 * present -> "search"; else -> "list". `slug` wins when both are given.
 *
 * @param {unknown} slug
 * @param {unknown} query
 * @returns {"get" | "search" | "list"}
 */
export function deriveWikiMode(slug, query) {
  if (typeof slug === "string" && slug.trim()) return "get";
  if (typeof query === "string" && query.trim()) return "search";
  return "list";
}

/**
 * Build the GET .../repo-wiki URL. `eveSessionId` is what the console
 * resolves the real tenant from server-side (via the jace_sessions ledger);
 * `repo` names which repo; `mode` is always carried; `slug` rides only when
 * `mode === "get"`, `query` only when `mode === "search"`.
 *
 * @param {string} baseUrl — already trimmed + de-slashed
 * @param {string} eveSessionId
 * @param {string} repo
 * @param {"get" | "search" | "list"} mode
 * @param {string} [slug]
 * @param {string} [query]
 * @returns {string}
 */
export function buildWikiUrl(baseUrl, eveSessionId, repo, mode, slug, query) {
  const params = new URLSearchParams();
  params.set("eveSessionId", eveSessionId);
  params.set("repo", repo);
  params.set("mode", mode);
  if (mode === "get" && slug) params.set("slug", slug);
  if (mode === "search" && query) params.set("query", query);
  return `${baseUrl}${REPO_WIKI_PATH}?${params.toString()}`;
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
 * Fetch the repo wiki in the derived mode, or a degraded result. Single
 * attempt, no retry, never throws:
 *
 *   1. blank eveSessionId/repo   -> degraded("bad_request")
 *   2. unset console config     -> degraded("config_missing", { missing })
 *   3. transport throws         -> degraded("unreachable")
 *   4. non-2xx status           -> degraded(<mapped reason>, { status })
 *   5. non-JSON body            -> degraded("bad_body", { status })
 *   6. success                  -> { ok:true, mode, repo, pages }
 *
 * There is no extra required argument for this core (`fetch_wiki` has no
 * required arg beyond eveSessionId/repo) — a call with neither `slug` nor
 * `query` is a legitimate `mode="list"` request, not an error.
 *
 * @param {{ env?: Record<string, string|undefined>, eveSessionId: string,
 *           repo: string, slug?: string, query?: string,
 *           transport: (url: string, init: { headers: Record<string,string> }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }> }} args
 */
export async function fetchWiki({ env = {}, eveSessionId, repo, slug, query, transport }) {
  const sessionId = String(eveSessionId ?? "").trim();
  const repoTrimmed = String(repo ?? "").trim();
  if (!sessionId || !repoTrimmed) {
    return degraded("bad_request");
  }

  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return degraded("config_missing", { missing: cfg.missing });

  const mode = deriveWikiMode(slug, query);
  const slugTrimmed = typeof slug === "string" ? slug.trim() : "";
  const queryTrimmed = typeof query === "string" ? query.trim() : "";
  const url = buildWikiUrl(cfg.baseUrl, sessionId, repoTrimmed, mode, slugTrimmed, queryTrimmed);

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
    mode: typeof body.mode === "string" ? body.mode : "",
    repo: typeof body.repo === "string" ? body.repo : "",
    pages: Array.isArray(body.pages) ? body.pages : [],
  };
}
