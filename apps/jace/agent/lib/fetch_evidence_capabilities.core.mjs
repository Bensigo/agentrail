// Pure, dependency-free core for Jace's READ-ONLY window onto the EVIDENCE
// CAPABILITY MAP — which evidence verbs this workspace's connected providers
// can actually answer right now (debugging design spec:
// docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md, spec PR
// #1501; `.superpowers/sdd/spec.md` is the working copy this implementation
// follows). Structural sibling of fetch_investigations.core.mjs — same
// resolve-config/transport/degraded-taxonomy shape — but a single-mode,
// NO-PARAMETER slice: this module takes nothing from the model beyond the
// session, because the capability map is workspace-wide, not investigation-
// or query-scoped. There is nothing here for a caller to get wrong.
//
// Wire contract (T4, `apps/console/app/api/v1/runner/evidence/route.ts`):
// `GET /api/v1/runner/evidence?eveSessionId=<id>&mode=capabilities` →
// `{ evidence: { changes: [...], search_events: [...], signals: [...],
// traces: [...], probe: [...] } }` — EVERY verb key always present (a family
// nesting the route computes from `evidenceCapabilities(CONNECTOR_CATALOG,
// connectorRows)`, catalog ∩ enabled+credentialed connector rows), an empty
// array meaning "nothing credentialed for this verb yet", never an absent
// key. Deliberately needs NO anchored investigation — the route's own
// doc-comment: "a capability check is 'what could I look at', asked before
// any investigation necessarily exists yet" — so this call is safe to make
// at intake, before `save_investigation` has created anything.
//
// Auth model matches every other root investigation tool:
// JACE_CONSOLE_TOKEN is a single deployment-wide secret; the console resolves
// "which workspace" from `eveSessionId` server-side via the jace_sessions
// ledger. This module NEVER takes a workspaceId argument.
//
// Rendering is CAPABILITY-FIRST (spec's pinned rule, "Capability-first
// self-model"): one line per verb, phrased as what Jace can DO — providers
// ride along only as a parenthetical attribution on a capability that
// exists, never the subject of the sentence. A verb with nothing
// credentialed renders as an honest capability GAP, never a bare empty list
// — "I cannot inspect metrics yet — no provider is connected." Provider
// identifiers are still run through `hardenUntrusted` defensively (this
// module's own Global Constraint: "every externally-sourced string rendered
// to the model passes hardenUntrusted") even though they originate from a
// closed, catalog-controlled vocabulary, not free-form user text.

import { hardenUntrusted } from "./sanitize-untrusted.core.mjs";

/** The evidence endpoint, joined onto the console base — same path the verb-query tools (fetch_changes/search_events) call, different mode. */
export const EVIDENCE_PATH = "/api/v1/runner/evidence";

// Fixed verb -> capability-phrase map (mirrors the console's own EVIDENCE_VERBS
// closed union and its render order exactly: changes, search_events, signals,
// traces, probe). Order here IS render order — deliberately fixed, not
// derived from whatever key order the console's JSON happens to serialize,
// so the capability summary reads identically every time regardless of
// provider mix or object key ordering.
export const VERB_PHRASES = Object.freeze([
  Object.freeze({ verb: "changes", phrase: "inspect deployments and merges" }),
  Object.freeze({ verb: "search_events", phrase: "search logs and events" }),
  Object.freeze({ verb: "signals", phrase: "inspect metrics" }),
  Object.freeze({ verb: "traces", phrase: "inspect traces" }),
  Object.freeze({ verb: "probe", phrase: "probe the live app" }),
]);

const PROVIDER_MAX_LEN = 60;
const PROVIDERS_MAX_COUNT = 20;

// Stable, cause-free notes for each degraded outcome — mirrors
// fetch_investigations.core.mjs's own DEGRADED_NOTES shape (the "briefs
// degraded taxonomy": transport/config/HTTP-status reasons, never a
// per-provider evidence-query reason — this call never reaches a provider at
// all, it only reads the console's own precomputed capability projection).
const DEGRADED_NOTES = {
  config_missing:
    "The console evidence endpoint is not configured for this Jace deployment (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); no capability map could be fetched.",
  bad_request:
    "The capability request was rejected as malformed (400, or a missing eveSessionId caught before the request was even sent); no capability map could be fetched.",
  unreachable:
    "The console evidence endpoint could not be reached (network error); no capability map could be fetched. Do not retry from here.",
  unauthorized:
    "The console rejected the console token (JACE_CONSOLE_TOKEN) with 401/403 — it may be expired or scoped to another workspace.",
  not_found: "No session or workspace was found for this conversation (404).",
  upstream_error: "The console's backing store errored (5xx); no capability map could be fetched.",
  unexpected_status: "The console returned an unexpected status.",
  bad_body: "The console responded, but the body was not valid JSON.",
};

/**
 * Resolve the console endpoint + bearer from the environment. Deliberately
 * duplicated verbatim from the sibling *.core.mjs modules rather than
 * shared — see fetch_investigations.core.mjs's identical function for the
 * "each core module here is pure and dependency-free of the others by
 * design" reasoning.
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
 * Build the capabilities URL. `eveSessionId` is what the console resolves
 * the real tenant from server-side; `mode=capabilities` is always fixed —
 * there is no other mode this module ever requests.
 *
 * @param {string} baseUrl — already trimmed + de-slashed
 * @param {string} eveSessionId — already trimmed, expected non-empty
 * @returns {string}
 */
export function buildCapabilitiesUrl(baseUrl, eveSessionId) {
  const trimmedSession = typeof eveSessionId === "string" ? eveSessionId.trim() : "";
  const parts = [];
  if (trimmedSession) parts.push(`eveSessionId=${encodeURIComponent(trimmedSession)}`);
  parts.push("mode=capabilities");
  return `${baseUrl}${EVIDENCE_PATH}?${parts.join("&")}`;
}

/**
 * Map an HTTP status to an outcome — identical taxonomy to
 * fetch_investigations.core.mjs's own `classifyStatus` (this route shares
 * the same outer auth/session-resolution contract: 400/401/403/404/5xx mean
 * the same things here as there). No status triggers a retry.
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
 * Build a degraded result. Always carries `ok:false` + `degraded:true` + a
 * stable `reason` + a cause-free `note`; carries no free-form transport
 * error text, so nothing untrusted or secret-shaped can ride out.
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
 * Project the console body's `evidence` map into the fixed, hardened shape —
 * every verb key always present (even when the response is malformed/empty),
 * each provider list capped and defensively hardened. Never throws on a
 * missing/malformed body.
 *
 * @param {unknown} body — the console's raw JSON body
 * @returns {Record<string, string[]>}
 */
export function projectCapabilities(body) {
  const raw = body && typeof body === "object" ? body.evidence : undefined;
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const { verb } of VERB_PHRASES) {
    const arr = Array.isArray(src[verb]) ? src[verb] : [];
    out[verb] = arr
      .filter((p) => typeof p === "string" && p.trim())
      .slice(0, PROVIDERS_MAX_COUNT)
      .map((p) => hardenUntrusted(p, { maxLen: PROVIDER_MAX_LEN }));
  }
  return out;
}

/**
 * Render the capability map capability-first: one line per verb, in the
 * fixed `VERB_PHRASES` order. A verb with at least one credentialed provider
 * reads "I can <phrase> (<providers>)."; an empty verb reads an honest gap,
 * "I cannot <phrase> yet — no provider is connected." — never a bare empty
 * list and never silence. Provider names are attribution in parentheses
 * only, never the sentence's subject (spec's pinned capability-voice rule).
 *
 * @param {Record<string, string[]>} evidence — from `projectCapabilities`
 * @returns {string}
 */
export function renderCapabilities(evidence) {
  const lines = ["Evidence capability map for this workspace:"];
  for (const { verb, phrase } of VERB_PHRASES) {
    const providers = Array.isArray(evidence?.[verb]) ? evidence[verb] : [];
    if (providers.length) {
      lines.push(`I can ${phrase} (${providers.join(", ")}).`);
    } else {
      lines.push(`I cannot ${phrase} yet — no provider is connected.`);
    }
  }
  return lines.join("\n");
}

/**
 * Fetch (and render) the workspace's evidence capability map, or a degraded
 * result. Single attempt, no retry, never throws:
 *
 *   1. blank eveSessionId       → degraded("bad_request")
 *   2. unset console config     → degraded("config_missing", { missing })
 *   3. transport throws         → degraded("unreachable")
 *   4. non-2xx status           → degraded(<mapped reason>, { status })
 *   5. non-JSON body            → degraded("bad_body"/<mapped reason>, { status })
 *   6. success                  → { ok:true, evidence, rendered }
 *
 * `eveSessionId` (Eve's own opaque session id) is what the console resolves
 * the real tenant from server-side; this NEVER takes a workspaceId argument,
 * and there is no other caller-supplied input at all — see this module's own
 * top doc-comment for why.
 *
 * @param {{ eveSessionId: string, env?: Record<string, string|undefined>,
 *           transport: (url: string, init: { headers: Record<string,string> }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }> }} args
 */
export async function fetchEvidenceCapabilities({ eveSessionId, env = {}, transport }) {
  const sessionId = String(eveSessionId ?? "").trim();
  if (!sessionId) return degraded("bad_request");

  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return degraded("config_missing", { missing: cfg.missing });

  const url = buildCapabilitiesUrl(cfg.baseUrl, sessionId);

  let res;
  try {
    res = await transport(url, {
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" },
    });
  } catch {
    return degraded("unreachable");
  }

  const status = Number(res && res.status);

  let body;
  try {
    body = await res.json();
  } catch {
    if (status >= 200 && status < 300) return degraded("bad_body", { status });
    const cls = classifyStatus(status);
    return degraded(cls.ok ? "unexpected_status" : cls.reason, { status });
  }

  const cls = classifyStatus(status);
  if (!cls.ok) return degraded(cls.reason, { status });

  const evidence = projectCapabilities(body);
  return { ok: true, evidence, rendered: renderCapabilities(evidence) };
}
