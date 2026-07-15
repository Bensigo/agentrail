// Pure, dependency-free core for fetching a ranked, budget-capped slice of the
// workspace's durable memory items from the AgentRail console — the ONE read
// the coordinator needs to ground an answer in repo context (conventions,
// architecture map, build/test commands, glossary). No SDK, no network
// primitives of its own: the single HTTP call is an injected `transport` seam
// (real `fetch` in the thin tool wrapper, a fake in tests), so every branch —
// including the degraded ones — is unit-testable without a live server.
//
// Auth model: Jace is a separate app from the runner and does NOT read the
// runner's ~/.agentrail/credentials.json. It resolves its own console endpoint +
// bearer from the environment (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN). The
// workspace is derived from the token server-side, so this NEVER takes a
// workspaceId argument. The only thing the model supplies is `query` — a short
// natural-language description of what it's looking for — sent as a URL query
// param so the console can rank + trim the result (retrieveMemory) instead of
// dumping the whole memory table. When either config var is unset, or the
// endpoint is unreachable, or the console returns a non-2xx, this returns a
// DEGRADED result (never throws, never retries) so the coordinator can honestly
// report "workspace memory unavailable" instead of crashing or storming the
// endpoint.

import { hardenUntrusted } from "./sanitize-untrusted.core.mjs";

/** The read-only workspace-memory endpoint, joined onto the console base. */
export const MEMORY_PATH = "/api/v1/runner/workspace-memory";

// retrieveMemory already trims each item's content to 1000 chars server-side;
// this is the untrusted-injection defense + hard cap applied on the Jace side
// (hardenUntrusted), matching the established pattern at Jace's other
// model-read seams (researcher briefs, fetch_run_evidence).
const CONTENT_MAX_LEN = 1000;

// The fields a memory item carries (light projection target). Kept in one place so
// the projection and any future consumer read the same contract.
const ITEM_FIELDS = [
  "id",
  "source",
  "content",
  "type",
  "writtenBy",
  "tags",
  "repositoryName",
  "createdAt",
  "lastUsedAt",
];

// Stable, cause-free notes for each degraded outcome. They describe the RETRIEVAL
// gap (config, transport, HTTP), never the workspace's content — the coordinator
// must not turn a fetch problem into a fabricated fact.
const DEGRADED_NOTES = {
  config_missing:
    "The console workspace-memory endpoint is not configured for this Jace deployment (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); no workspace memory could be fetched.",
  bad_request:
    "The workspace-memory request was rejected as malformed (400); no workspace memory could be fetched.",
  unreachable:
    "The console workspace-memory endpoint could not be reached (network error); no workspace memory could be fetched. Do not retry from here.",
  unauthorized:
    "The console rejected the console token (JACE_CONSOLE_TOKEN) with 401/403 — it may be expired or scoped to another workspace.",
  not_found:
    "The console has no workspace-memory endpoint or no workspace for this token (404).",
  upstream_error:
    "The console's backing store errored (5xx); no workspace memory could be fetched.",
  unexpected_status: "The console returned an unexpected status.",
  bad_body: "The console responded, but the body was not valid JSON.",
};

/**
 * Resolve the console endpoint + bearer from the environment. Trims both, strips
 * a trailing slash from the base URL, and reports which var(s) are missing so the
 * degraded note can be specific.
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
 * Build the workspace-memory URL. The workspace is derived from the bearer
 * token server-side, so it is NEVER a param here. `query` — the search text —
 * is sent as a URL-encoded `query` param when non-empty; an empty/whitespace
 * query is omitted entirely (the endpoint treats a missing query the same as
 * an empty one, falling back to its pinned-decision/recency default).
 *
 * @param {string} baseUrl — already trimmed + de-slashed
 * @param {string} [query]
 * @returns {string}
 */
export function buildMemoryUrl(baseUrl, query = "") {
  const trimmed = typeof query === "string" ? query.trim() : "";
  if (!trimmed) return `${baseUrl}${MEMORY_PATH}`;
  return `${baseUrl}${MEMORY_PATH}?query=${encodeURIComponent(trimmed)}`;
}

/**
 * Map an HTTP status to an outcome. 2xx → ok; everything else → a specific
 * degraded reason. No status triggers a retry — a failed fetch is reported, not
 * re-attempted (no retry storm).
 *
 * @param {number} status
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 400) return { ok: false, reason: "bad_request" };
  if (status === 401 || status === 403) return { ok: false, reason: "unauthorized" };
  if (status === 404) return { ok: false, reason: "not_found" };
  if (status >= 500) return { ok: false, reason: "upstream_error" };
  return { ok: false, reason: "unexpected_status" };
}

/**
 * Build a degraded result. Always carries `ok:false` + `degraded:true` + a stable
 * `reason` + a cause-free `note`; extra fields (e.g. `missing`, `status`) ride
 * along for the coordinator's honest report. Deliberately carries NO free-form
 * error text from the transport, so nothing untrusted or secret-shaped can ride
 * out.
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
 * Light projection of the console body into the pinned item shape. Coerces the
 * body's `items` to an array, keeps only the contract fields (unknown fields are
 * dropped), and normalizes `tags` to an array. `content` is advisory/untrusted
 * data the coordinator renders, never an instruction — it is run through
 * `hardenUntrusted` (invisible/bidi/control stripping, dangerous-scheme and
 * mass-mention defanging, length cap) before it can reach the model, same as
 * every other untrusted-content render seam in Jace.
 *
 * @param {unknown} body
 * @returns {Array<Record<string, unknown>>}
 */
export function projectItems(body) {
  const raw = body && typeof body === "object" ? body.items : undefined;
  const list = Array.isArray(raw) ? raw : [];
  return list.map((it) => {
    const o = it && typeof it === "object" ? it : {};
    const out = {};
    for (const key of ITEM_FIELDS) {
      if (key === "tags") out.tags = Array.isArray(o.tags) ? o.tags : [];
      else if (key === "content")
        out.content = hardenUntrusted(o.content ?? "", { maxLen: CONTENT_MAX_LEN });
      else out[key] = o[key] ?? null;
    }
    return out;
  });
}

/**
 * Fetch a ranked, budget-capped slice of the workspace's durable memory for a
 * `query`, or a degraded result. Single attempt, no retry, never throws:
 *
 *   1. unset console config    → degraded("config_missing", { missing })
 *   2. transport throws        → degraded("unreachable")
 *   3. non-2xx status          → degraded(<mapped reason>, { status })
 *   4. non-JSON body           → degraded("bad_body", { status })
 *   5. success                 → { ok:true, items, count }
 *
 * The workspace is derived from the bearer token server-side; this NEVER takes a
 * workspaceId argument. `query` (the model's search text) rides as a URL param.
 *
 * @param {{ query?: string, env?: Record<string, string|undefined>,
 *           transport: (url: string, init: { headers: Record<string,string> }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }> }} args
 */
export async function fetchWorkspaceMemory({ query = "", env = {}, transport }) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return degraded("config_missing", { missing: cfg.missing });

  const url = buildMemoryUrl(cfg.baseUrl, query);

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

  const items = projectItems(body);
  return { ok: true, items, count: items.length };
}
