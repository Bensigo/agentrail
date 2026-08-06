// Pure, dependency-free core for reading ONE file or directory listing from a
// workspace's connected GitHub repo at a ref — one of the reviewer's four
// context tools that let it investigate beyond the diff alone (design:
// docs/superpowers/specs/2026-07-31-reviewer-judgment-engine-design.md §2).
// No SDK, no network primitives of its own: the single HTTP call is an
// injected `transport` seam (real `fetch` in the thin tool wrapper, a fake in
// tests), so every branch — including every degraded one — is
// unit-testable without a live server. Transcribes fetch_pr_diff.core.mjs's
// own structure exactly (PATH const, duplicated resolveConsoleConfig,
// URLSearchParams-built URL, the same classifyStatus table, degraded(),
// single-attempt fetch fn) — see that file's own doc-comment for the full
// reasoning behind the shared shape and the `eveSessionId` resolution note
// (this module, like its three siblings here, is called from the SAME
// reviewer subagent tool wrapper and stays equally agnostic to how
// `eveSessionId` was resolved).
//
// Auth + config model: same as the sibling *.core.mjs modules across this
// app — Jace resolves its own console endpoint + bearer from
// JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN.
//
// REF GUIDANCE (for the caller, not enforced here): the console's repo-file
// route resolves `ref` against GitHub's contents API — a branch, tag, or
// commit SHA; omitting it reads the repo's default branch. This core does
// not validate `ref`'s shape; an invalid ref simply degrades via the
// console's own 404/422 classification.

export const REPO_FILE_PATH = "/api/v1/runner/repo-file";

// Stable, cause-free notes for each degraded outcome. They describe the
// RETRIEVAL gap, never the file's contents — the reviewer must not turn a
// fetch problem into a fabricated claim about what a file contains.
const DEGRADED_NOTES = {
  config_missing:
    "The console repo-file endpoint is not configured for this Jace deployment (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); no file could be fetched.",
  bad_request:
    "The file request was malformed (missing/blank repo or path); no file could be fetched.",
  unreachable:
    "The console repo-file endpoint could not be reached (network error); no file could be fetched. Do not retry from here.",
  unauthorized:
    "The console rejected the request (401/403) — the shared JACE_CONSOLE_TOKEN this Jace deployment presents to the console may be invalid, rotated, or unset. This is a deployment configuration problem, not a workspace-specific one.",
  not_found:
    "The console found nothing at that path (it may not exist at that ref), or this repo is not connected to the workspace (404).",
  conflict:
    "The workspace isn't fully set up yet (no workspace, or no GitHub App installed), or the console rejected a previously-stored GitHub App installation as stale/revoked — either way, reconnect GitHub for this workspace from the console (409).",
  rate_limited: "GitHub's rate limit was hit; no file could be fetched right now.",
  upstream_error: "The console or GitHub errored (5xx); no file could be fetched.",
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
 * Build the GET .../repo-file URL. `eveSessionId` is what the console
 * resolves the real tenant from server-side (via the jace_sessions ledger);
 * `repo` and `path` name which file/directory; `ref` rides only when
 * non-blank (omitting it reads the repo's default branch).
 *
 * @param {string} baseUrl — already trimmed + de-slashed
 * @param {string} eveSessionId
 * @param {string} repo
 * @param {string} path
 * @param {string} [ref]
 * @returns {string}
 */
export function buildRepoFileUrl(baseUrl, eveSessionId, repo, path, ref) {
  const params = new URLSearchParams();
  params.set("eveSessionId", eveSessionId);
  params.set("repo", repo);
  params.set("path", path);
  if (ref) params.set("ref", ref);
  return `${baseUrl}${REPO_FILE_PATH}?${params.toString()}`;
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
 * Fetch one file's content or one directory's listing at a ref, or a
 * degraded result. Single attempt, no retry, never throws:
 *
 *   1. blank eveSessionId/repo/path   -> degraded("bad_request")
 *   2. unset console config          -> degraded("config_missing", { missing })
 *   3. transport throws              -> degraded("unreachable")
 *   4. non-2xx status                -> degraded(<mapped reason>, { status })
 *   5. non-JSON body                 -> degraded("bad_body", { status })
 *   6. success                       -> { ok:true, kind, content, entries,
 *                                        size, truncated, path, ref }
 *
 * `kind` is `"file"` or `"dir"` per the console's own response; a file body
 * carries `content`/`size`/`truncated` (entries defaults to `[]`), a dir body
 * carries `entries` (content/size/truncated default to their empty values) —
 * this core coerces every field unconditionally rather than branching on
 * `kind`, so a shape surprise degrades to an honest empty value instead of
 * throwing.
 *
 * @param {{ env?: Record<string, string|undefined>, eveSessionId: string,
 *           repo: string, path: string, ref?: string,
 *           transport: (url: string, init: { headers: Record<string,string> }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }> }} args
 */
export async function readRepoFile({ env = {}, eveSessionId, repo, path, ref, transport }) {
  const sessionId = String(eveSessionId ?? "").trim();
  const repoTrimmed = String(repo ?? "").trim();
  const pathTrimmed = String(path ?? "").trim();
  if (!sessionId || !repoTrimmed || !pathTrimmed) {
    return degraded("bad_request");
  }

  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return degraded("config_missing", { missing: cfg.missing });

  const refTrimmed = typeof ref === "string" ? ref.trim() : "";
  const url = buildRepoFileUrl(cfg.baseUrl, sessionId, repoTrimmed, pathTrimmed, refTrimmed);

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
    kind: typeof body.kind === "string" ? body.kind : "",
    content: typeof body.content === "string" ? body.content : "",
    entries: Array.isArray(body.entries) ? body.entries : [],
    size: typeof body.size === "number" ? body.size : 0,
    truncated: body.truncated === true,
    path: typeof body.path === "string" ? body.path : "",
    ref: typeof body.ref === "string" ? body.ref : "",
  };
}
