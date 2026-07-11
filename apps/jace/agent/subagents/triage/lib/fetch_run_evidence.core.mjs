// Pure, dependency-free core for fetching a run's failure bundle (#1146) from the
// AgentRail console — the ONE read the triage subagent needs to diagnose a failed
// run. No SDK, no network primitives of its own: the single HTTP call is an
// injected `transport` seam (real `fetch` in the thin tool wrapper, a fake in
// tests), so every branch — including the degraded ones (AC5) — is unit-testable
// without a live server.
//
// Auth model: Jace is a separate app from the runner and does NOT read the
// runner's ~/.agentrail/credentials.json. It resolves its own console endpoint +
// bearer from the environment (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN). When
// either is unset, or the endpoint is unreachable, or the console returns a
// non-2xx, this returns a DEGRADED result (never throws, never retries) so the
// subagent can honestly report "evidence unavailable" instead of crashing or
// storming the endpoint.

import { summarizeEvidence } from "./triage.core.mjs";

/** The read-only failure-bundle endpoint (#1146), joined onto the console base. */
export const BUNDLE_PATH = "/api/v1/runner/failure-bundle";

// Stable, cause-free notes for each degraded outcome. They describe the RETRIEVAL
// gap (config, transport, HTTP), never the run's failure — triage must not turn a
// fetch problem into a fabricated diagnosis.
const DEGRADED_NOTES = {
  config_missing:
    "The console evidence endpoint is not configured for this Jace deployment (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); no failure evidence could be fetched.",
  bad_request:
    "The evidence request was malformed (missing/blank run_id); no failure evidence could be fetched.",
  unreachable:
    "The console evidence endpoint could not be reached (network error); no failure evidence could be fetched. Do not retry from here.",
  unauthorized:
    "The console rejected the console token (JACE_CONSOLE_TOKEN) with 401/403 — it may be expired or scoped to another workspace.",
  not_found:
    "The console has no run, failures, gates, or timeline for this run_id in this workspace (404).",
  upstream_error:
    "The console's backing store errored (5xx); no failure evidence could be fetched.",
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
 * Build the failure-bundle URL. The run_id is carried as a query param (matching
 * the console route) and URL-encoded. Throws on a blank run_id — the caller maps
 * that to a `bad_request` degraded result rather than propagating.
 *
 * @param {string} baseUrl — already trimmed + de-slashed
 * @param {string} runId
 * @returns {string}
 */
export function buildBundleUrl(baseUrl, runId) {
  const id = String(runId ?? "").trim();
  if (!id) throw new Error("run_id is required");
  return `${baseUrl}${BUNDLE_PATH}?run_id=${encodeURIComponent(id)}`;
}

/**
 * Map an HTTP status to an outcome. 2xx → ok; everything else → a specific
 * degraded reason. No status triggers a retry — a failed fetch is reported, not
 * re-attempted (AC5: no retry storm).
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
 * along for the subagent's honest report. Deliberately carries NO free-form error
 * text from the transport, so nothing untrusted or secret-shaped can ride out.
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
 * Fetch the failure bundle for a run, or a degraded result. Single attempt, no
 * retry, never throws:
 *
 *   1. blank run_id            → degraded("bad_request")
 *   2. unset console config    → degraded("config_missing", { missing })
 *   3. transport throws        → degraded("unreachable")          (AC5)
 *   4. non-2xx status          → degraded(<mapped reason>, { status })
 *   5. non-JSON body           → degraded("bad_body", { status })
 *   6. success                 → { ok:true, run_id, bundle, evidence_summary }
 *
 * `evidence_summary` (present/missing sections + a where-to-look note) is computed
 * deterministically so the subagent knows up front which sections it may cite and
 * never has to guess (AC2/AC3).
 *
 * @param {{ env?: Record<string, string|undefined>, runId: string,
 *           transport: (url: string, init: { headers: Record<string,string> }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }> }} args
 */
export async function fetchRunEvidence({ env = {}, runId, transport }) {
  const id = String(runId ?? "").trim();
  if (!id) return degraded("bad_request");

  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return degraded("config_missing", { missing: cfg.missing });

  let url;
  try {
    url = buildBundleUrl(cfg.baseUrl, id);
  } catch {
    return degraded("bad_request");
  }

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

  let bundle;
  try {
    bundle = await res.json();
  } catch {
    return degraded("bad_body", { status });
  }

  return {
    ok: true,
    run_id: id,
    bundle,
    evidence_summary: summarizeEvidence(bundle),
  };
}
