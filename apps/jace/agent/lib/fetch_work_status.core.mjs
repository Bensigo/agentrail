// Pure, dependency-free core for fetching work status (recent runs + queue
// entries, optionally scoped to a `ref`) from the AgentRail console — the
// read that lets Jace answer "how's that going / did it land / where are we
// on X" from real, workspace-scoped data. No SDK, no network primitives of
// its own: the single HTTP call is an injected `transport` seam (real
// `fetch` in the thin tool wrapper, a fake in tests), so every branch —
// including every degraded one — is unit-testable without a live server.
//
// Auth + config model: same as the sibling *.core.mjs modules across this
// app (e.g. fetch_pr_diff.core.mjs) — Jace resolves its own console
// endpoint + bearer from JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN.
//
// `eveSessionId` here is NOT necessarily `ctx.session.id` read directly —
// see fetch_pr_diff.core.mjs's doc-comment for the subagent child-session
// caveat. This module stays agnostic to that distinction: it just sends
// whatever string it's given.

import { hardenUntrusted } from "./sanitize-untrusted.core.mjs";

export const WORK_STATUS_PATH = "/api/v1/runner/work-status";

// Untrusted-content caps applied on the Jace side, matching every other
// untrusted-render seam in this app (see fetch_backlog.core.mjs's
// TITLE_MAX_LEN/BODY_MAX_LEN). `title` (a GitHub issue/PR title) and
// `parkReason` (a guardrail's own wording) are both third-party-writable on
// a public repo; `branch` is attacker-influenceable too (a PR branch name).
const TITLE_MAX_LEN = 300;
const PARK_REASON_MAX_LEN = 600;
const BRANCH_MAX_LEN = 200;

// Stable, cause-free notes for each degraded outcome. They describe the
// RETRIEVAL gap, never the work itself — the caller must not turn a fetch
// problem into a fabricated status update.
//
// `not_found` and `bad_request` are deliberately NOT written to assert a
// single cause (Important 1): this Jace deployment can deploy before the
// console PR that serves this route lands, so a 404 here is
// indistinguishable, from the client alone, between "the route doesn't
// exist yet on this console deployment" and "this conversation has no
// workspace". Asserting the latter as fact would be a fabricated claim
// about the human's account.
const DEGRADED_NOTES = {
  config_missing:
    "The console work-status endpoint is not configured for this Jace deployment (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); no status could be fetched.",
  bad_request:
    "The status request was rejected as malformed (400, or a missing eveSessionId caught before the request was even sent); no status could be fetched.",
  unreachable:
    "The console work-status endpoint could not be reached (network error); no status could be fetched. Do not retry from here.",
  unauthorized:
    "The console rejected the request (401/403) — this Jace deployment's console token may be stale.",
  not_found:
    "The console returned 404 for the work-status read — either this console deployment does not serve that route yet, or this conversation is not linked to a workspace. No status could be fetched.",
  conflict:
    "This conversation has no workspace yet (409) — connect one first.",
  rate_limited: "The console is rate limiting; no status could be fetched right now.",
  upstream_error: "The console errored (5xx); no status could be fetched.",
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
 * Build the GET .../work-status URL. `eveSessionId` is what the console
 * resolves the real tenant from server-side (via the jace_sessions ledger);
 * `ref` optionally scopes to a specific run/issue/PR — when blank, the `ref`
 * param is omitted entirely (list mode). `limit` optionally requests a page
 * size — when omitted/null, the `limit` param is omitted entirely and the
 * route applies its own default (50). The route owns the 1..200 clamp; this
 * function never clamps, it only forwards whatever the caller passed.
 *
 * @param {string} baseUrl — already trimmed + de-slashed
 * @param {string} eveSessionId
 * @param {string} [ref]
 * @param {number} [limit]
 * @returns {string}
 */
export function buildWorkStatusUrl(baseUrl, eveSessionId, ref, limit) {
  const params = new URLSearchParams();
  params.set("eveSessionId", eveSessionId);
  const refTrimmed = String(ref ?? "").trim();
  if (refTrimmed) params.set("ref", refTrimmed);
  if (limit !== undefined && limit !== null) params.set("limit", String(limit));
  return `${baseUrl}${WORK_STATUS_PATH}?${params.toString()}`;
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
 * Harden one field if it's a string; pass non-strings (notably `null` — e.g.
 * an un-parked entry's `parkReason`) through UNCHANGED. Distinguishing "no
 * value" from "" matters here: collapsing `parkReason: null` to `""` would
 * blur "not parked" into "parked with an empty reason".
 * @param {unknown} value
 * @param {number} maxLen
 */
function hardenField(value, maxLen) {
  if (typeof value !== "string") return value;
  return hardenUntrusted(value, { maxLen });
}

/**
 * Project one console `runs` row, hardening the untrusted, third-party-
 * writable fields (`title` — a GitHub issue/PR title, `branch` — attacker-
 * influenceable) before the model ever reads them. Mirrors
 * fetch_backlog.core.mjs's `projectIssue` treatment of issue titles. Every
 * other field rides through as the console sent it.
 * @param {unknown} raw
 */
function projectRun(raw) {
  if (!raw || typeof raw !== "object") return raw;
  return {
    ...raw,
    title: hardenField(raw.title, TITLE_MAX_LEN),
    branch: hardenField(raw.branch, BRANCH_MAX_LEN),
  };
}

/**
 * Project one console `queueEntries` row, hardening `title` and
 * `parkReason` (a guardrail's own wording, or free text on a dependency
 * park) before the model ever reads them. Same treatment as
 * {@link projectRun}.
 * @param {unknown} raw
 */
function projectQueueEntry(raw) {
  if (!raw || typeof raw !== "object") return raw;
  return {
    ...raw,
    title: hardenField(raw.title, TITLE_MAX_LEN),
    parkReason: hardenField(raw.parkReason, PARK_REASON_MAX_LEN),
  };
}

/**
 * Fetch work status (recent runs + queue entries, optionally scoped to a
 * ref), or a degraded result. Single attempt, no retry, never throws:
 *
 *   1. blank eveSessionId        -> degraded("bad_request")
 *   2. unset console config      -> degraded("config_missing", { missing })
 *   3. transport throws          -> degraded("unreachable")
 *   4. non-2xx status            -> degraded(<mapped reason>, { status })
 *   5. non-JSON / non-object body -> degraded("bad_body", { status })
 *   6. success                   -> { ok:true, ref, resolvedAs, generatedAt,
 *                                     limit, runs, queueEntries, truncated }
 *
 * `limit` is an optional passthrough (list mode only, ignored by the route
 * when `ref` is set): when supplied it rides on the query string as-is; when
 * omitted, no `limit` param is sent and the route falls back to its own
 * default. This function never clamps the value itself — the route owns the
 * 1..200 clamp, so re-clamping here would just be a second, driftable copy
 * of that policy.
 *
 * @param {{ env?: Record<string, string|undefined>, eveSessionId: string,
 *           ref?: string, limit?: number,
 *           transport: (url: string, init: { headers: Record<string,string> }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }> }} args
 */
export async function fetchWorkStatus({ env = {}, eveSessionId, ref, limit, transport }) {
  const sessionId = String(eveSessionId ?? "").trim();
  if (!sessionId) {
    return degraded("bad_request");
  }

  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return degraded("config_missing", { missing: cfg.missing });

  const url = buildWorkStatusUrl(cfg.baseUrl, sessionId, ref, limit);

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
    ref: typeof body.ref === "string" ? body.ref : null,
    resolvedAs: typeof body.resolvedAs === "string" ? body.resolvedAs : null,
    generatedAt: typeof body.generatedAt === "string" ? body.generatedAt : "",
    limit: typeof body.limit === "number" ? body.limit : null,
    runs: Array.isArray(body.runs) ? body.runs.map(projectRun) : [],
    queueEntries: Array.isArray(body.queueEntries)
      ? body.queueEntries.map(projectQueueEntry)
      : [],
    truncated: {
      runs: body?.truncated?.runs === true,
      queueEntries: body?.truncated?.queueEntries === true,
    },
  };
}
