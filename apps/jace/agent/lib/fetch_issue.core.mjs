// Pure, dependency-free core for root's fetch_issue tool — ONE GET to the
// console's runner/issue route, resolving a GitHub issue (its acceptance
// criteria live in the body) before QA-ing the work that closes it (spec:
// docs/superpowers/specs/2026-07-29-qa-ac-awareness-design.md). No SDK, no
// network primitives of its own: the single HTTP call is an injected
// `transport` seam (real `fetch` in the thin tool wrapper, a fake in tests),
// so every branch — including every degraded one — is unit-testable without
// a live server.
//
// ROOT tool: the wrapper sends ctx.session.id directly as eveSessionId (no
// session.parent indirection — contrast fetch_pr_diff.core.mjs, which runs
// inside a declared subagent's child session and must resolve
// ctx.session.parent?.rootSessionId instead).
//
// Auth + config model: same as the sibling *.core.mjs modules across this
// app — Jace resolves its own console endpoint + bearer from
// JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN.

export const ISSUE_PATH = "/api/v1/runner/issue";

// Stable, cause-free notes for each degraded outcome. They describe the
// RETRIEVAL gap, never the issue's contents — root must not turn a fetch
// problem into invented acceptance criteria.
const DEGRADED_NOTES = {
  config_missing:
    "The console issue endpoint is not configured for this Jace deployment (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); no issue could be fetched.",
  bad_request:
    "The issue request was malformed (missing/blank repo or issueNumber); no issue could be fetched.",
  unreachable:
    "The console issue endpoint could not be reached (network error); no issue could be fetched. Do not retry from here.",
  unauthorized:
    "The console rejected the request (401/403) — the stored GitHub credentials for this workspace may be stale or revoked.",
  not_found:
    "The console found no such issue in that repo (404) — the repo may not be connected to this workspace, or the number may belong to a pull request.",
  conflict:
    "The workspace or its GitHub connection is not fully set up yet (409).",
  rate_limited: "GitHub's rate limit was hit; no issue could be fetched right now.",
  upstream_error: "The console or GitHub errored (5xx); no issue could be fetched.",
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
 * Build the GET .../issue URL. `eveSessionId` is what the console resolves
 * the real tenant from server-side (via the jace_sessions ledger); `repo`
 * and `issueNumber` name which issue.
 *
 * @param {string} baseUrl — already trimmed + de-slashed
 * @param {string} eveSessionId
 * @param {string} repo
 * @param {number} issueNumber
 * @returns {string}
 */
export function buildIssueUrl(baseUrl, eveSessionId, repo, issueNumber) {
  const params = new URLSearchParams();
  params.set("eveSessionId", eveSessionId);
  params.set("repo", repo);
  params.set("issueNumber", String(issueNumber));
  return `${baseUrl}${ISSUE_PATH}?${params.toString()}`;
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
 * Fetch one GitHub issue, or a degraded result. Single attempt, no retry,
 * never throws:
 *
 *   1. blank eveSessionId/repo, or a
 *      non-positive-integer issueNumber   -> degraded("bad_request")
 *   2. unset console config              -> degraded("config_missing", { missing })
 *   3. transport throws                  -> degraded("unreachable")
 *   4. non-2xx status                    -> degraded(<mapped reason>, { status })
 *   5. non-JSON body                     -> degraded("bad_body", { status })
 *   6. success                           -> { ok:true, repo, issueNumber, number,
 *                                           title, body, state, bodyTruncated }
 *
 * @param {{ env?: Record<string, string|undefined>, eveSessionId: string,
 *           repo: string, issueNumber: number,
 *           transport: (url: string, init: { headers: Record<string,string> }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }> }} args
 */
export async function fetchIssue({ env = {}, eveSessionId, repo, issueNumber, transport }) {
  const sessionId = String(eveSessionId ?? "").trim();
  const repoTrimmed = String(repo ?? "").trim();
  const issueNum = Number(issueNumber);
  if (!sessionId || !repoTrimmed || !Number.isInteger(issueNum) || issueNum <= 0) {
    return degraded("bad_request");
  }

  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return degraded("config_missing", { missing: cfg.missing });

  const url = buildIssueUrl(cfg.baseUrl, sessionId, repoTrimmed, issueNum);

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
    issueNumber: issueNum,
    number: typeof body.number === "number" ? body.number : issueNum,
    title: typeof body.title === "string" ? body.title : "",
    body: typeof body.body === "string" ? body.body : "",
    state: typeof body.state === "string" ? body.state : "",
    bodyTruncated: body.bodyTruncated === true,
  };
}
