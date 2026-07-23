// Pure, dependency-free core for Jace's READ-ONLY backlog sweep (issue #1291,
// epic #1257) — the one read behind the `backlog-triage` grooming skill. It
// GETs the workspace's OPEN issues across its connected repos from the console
// (apps/console/app/api/v1/runner/backlog), enriches each with the grooming
// signals (age, staleness, impact labels), flags likely-duplicate groups, and
// hardens every untrusted field before the model ever reads it. No SDK, no
// network primitives of its own: the single HTTP call is an injected
// `transport` seam (real fetch in the thin tool wrapper, a fake in tests), so
// every branch — including the degraded ones — is unit-testable without a live
// server.
//
// NOT the run-failure "triage" (FAILURE DIAGNOSIS, agent/subagents/triage).
// This is BACKLOG GROOMING — a distinct name and read path.
//
// Auth model (same as fetch_workspace_memory.core.mjs): Jace resolves its own
// console endpoint + the shared JACE_CONSOLE_TOKEN secret from the environment
// and sends `eveSessionId` (Eve's own opaque session id, read server-side by
// the tool wrapper from ctx.session.id — never model-supplied) for the console
// to resolve the real tenant through the jace_sessions ledger. This is NEVER a
// workspaceId argument. When config is unset, the session is blank, the
// endpoint is unreachable, or the console returns a non-2xx, this returns a
// DEGRADED result (never throws, never retries) so the skill can honestly
// report "couldn't read the backlog" instead of crashing or fabricating.

import { hardenUntrusted } from "./sanitize-untrusted.core.mjs";
import {
  ageInDays,
  stalenessInDays,
  impactLabels,
  findLikelyDuplicateGroups,
} from "./backlog_triage.core.mjs";

/** The read-only backlog endpoint, joined onto the console base. */
export const BACKLOG_PATH = "/api/v1/runner/backlog";

// Untrusted-content caps applied on the Jace side (the console already trims
// the body excerpt server-side; this is the injection-defense + hard cap at
// the model-read seam, matching every other untrusted render seam in Jace).
const TITLE_MAX_LEN = 300;
const BODY_MAX_LEN = 600;
const LABEL_MAX_LEN = 100;

// Stable, cause-free notes for each degraded outcome. They describe the READ
// gap (config, transport, HTTP), never the backlog's content — the skill must
// not turn a fetch problem into a fabricated ordering.
const DEGRADED_NOTES = {
  config_missing:
    "The console backlog endpoint is not configured for this Jace deployment (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); no backlog could be fetched.",
  bad_request:
    "The backlog request was rejected as malformed (400, or a missing eveSessionId caught before the request was even sent); no backlog could be fetched.",
  unreachable:
    "The console backlog endpoint could not be reached (network error); no backlog could be fetched. Do not retry from here.",
  unauthorized:
    "The console rejected the console token (JACE_CONSOLE_TOKEN) with 401/403; no backlog could be fetched.",
  not_connected:
    "No GitHub account or repo is connected for this workspace yet (404/409); connect one on the console, then try again.",
  upstream_error:
    "The console or GitHub errored (5xx); no backlog could be fetched.",
  unexpected_status: "The console returned an unexpected status.",
  bad_body: "The console responded, but the body was not valid JSON.",
};

/**
 * Resolve the console endpoint + bearer from the environment. Trims both,
 * strips a trailing slash from the base URL, and reports which var(s) are
 * missing. Deliberately duplicated verbatim from the sibling *.core.mjs
 * modules rather than shared: each core module here is pure and dependency-free
 * of the others by design.
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
 * Build the backlog URL. `eveSessionId` is what the console resolves the real
 * tenant from server-side; this is NEVER a workspaceId param.
 *
 * @param {string} baseUrl — already trimmed + de-slashed
 * @param {string} eveSessionId — already trimmed, expected non-empty
 * @returns {string}
 */
export function buildBacklogUrl(baseUrl, eveSessionId) {
  const trimmed = typeof eveSessionId === "string" ? eveSessionId.trim() : "";
  if (!trimmed) return `${baseUrl}${BACKLOG_PATH}`;
  return `${baseUrl}${BACKLOG_PATH}?eveSessionId=${encodeURIComponent(trimmed)}`;
}

/**
 * Map an HTTP status to an outcome. 2xx → ok; everything else → a specific
 * degraded reason. No status triggers a retry.
 *
 * @param {number} status
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 400) return { ok: false, reason: "bad_request" };
  if (status === 401 || status === 403) return { ok: false, reason: "unauthorized" };
  if (status === 404 || status === 409) return { ok: false, reason: "not_connected" };
  if (status >= 500) return { ok: false, reason: "upstream_error" };
  return { ok: false, reason: "unexpected_status" };
}

/**
 * Build a degraded result. Always carries `ok:false` + `degraded:true` + a
 * stable `reason` + a cause-free `note`. Carries NO free-form transport error
 * text, so nothing untrusted or secret-shaped can ride out.
 *
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
 * Project one console issue into the enriched grooming shape: untrusted fields
 * (title, bodyExcerpt, label names) hardened, plus the computed signals
 * (ageDays, stalenessDays, impactLabels). `content` fields are advisory data
 * the model renders, never instructions — hardened exactly like every other
 * untrusted seam in Jace.
 *
 * @param {unknown} raw — one console issue object
 * @param {number} now — epoch-ms
 * @returns {Record<string, unknown>}
 */
export function projectIssue(raw, now) {
  const o = raw && typeof raw === "object" ? raw : {};
  const labels = Array.isArray(o.labels)
    ? o.labels.map((l) => hardenUntrusted(String(l ?? ""), { maxLen: LABEL_MAX_LEN }))
    : [];
  return {
    repo: typeof o.repo === "string" ? o.repo : "",
    number: Number.isInteger(o.number) ? o.number : Number(o.number) || 0,
    title: hardenUntrusted(o.title ?? "", { maxLen: TITLE_MAX_LEN }),
    labels,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : "",
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : "",
    comments: Number.isInteger(o.comments) ? o.comments : Number(o.comments) || 0,
    bodyExcerpt: hardenUntrusted(o.bodyExcerpt ?? "", { maxLen: BODY_MAX_LEN }),
    ageDays: ageInDays(o.createdAt, now),
    stalenessDays: stalenessInDays(o.updatedAt, now),
    impactLabels: impactLabels(labels),
  };
}

/**
 * Fetch and enrich the workspace's open backlog, or a degraded result. Single
 * attempt, no retry, never throws:
 *
 *   1. blank eveSessionId       → degraded("bad_request")
 *   2. unset console config     → degraded("config_missing", { missing })
 *   3. transport throws         → degraded("unreachable")
 *   4. non-2xx status           → degraded(<mapped reason>, { status })
 *   5. non-JSON body            → degraded("bad_body", { status })
 *   6. success                  → { ok:true, issues, count, repos, warnings,
 *                                    likelyDuplicateGroups }
 *
 * @param {{ eveSessionId: string, env?: Record<string, string|undefined>,
 *           now?: number,
 *           transport: (url: string, init: { headers: Record<string,string> }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }> }} args
 */
export async function fetchBacklog({ eveSessionId, env = {}, now = Date.now(), transport }) {
  const sessionId = String(eveSessionId ?? "").trim();
  if (!sessionId) return degraded("bad_request");

  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return degraded("config_missing", { missing: cfg.missing });

  const url = buildBacklogUrl(cfg.baseUrl, sessionId);

  let res;
  try {
    res = await transport(url, {
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" },
    });
  } catch {
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

  const rawIssues = body && typeof body === "object" && Array.isArray(body.issues) ? body.issues : [];
  const issues = rawIssues.map((it) => projectIssue(it, now));
  const repos =
    body && typeof body === "object" && Array.isArray(body.repos)
      ? body.repos.filter((r) => typeof r === "string")
      : [];
  const warnings =
    body && typeof body === "object" && Array.isArray(body.warnings)
      ? body.warnings.map((w) => hardenUntrusted(String(w ?? ""), { maxLen: BODY_MAX_LEN }))
      : [];

  const likelyDuplicateGroups = findLikelyDuplicateGroups(
    issues.map((i) => ({ repo: i.repo, number: i.number, title: i.title })),
  );

  return { ok: true, issues, count: issues.length, repos, warnings, likelyDuplicateGroups };
}
