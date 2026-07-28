// Pure, dependency-free core for Jace's autosave WRITE path into BRIEFS — the
// durable, server-side understanding of ONE product idea (design:
// docs/superpowers/specs/2026-07-28-jace-briefs-durable-idea-understanding-design.md;
// spec PR #1487; store slice PR #1489; route slice PR #1493). No SDK, no
// network primitives of its own: the single HTTP call is an injected
// `transport` seam (real fetch with a timeout in the thin tool wrapper, a
// fake in tests), so every branch — success and every degraded/refused
// outcome — is unit-testable without a live server.
//
// UNGATED, deliberately (design spec, "Server seam": "No approval gate: it is
// internal and reversible, and `create_issue` remains the only boundary
// crossing"). A brief lives only inside AgentRail's own console — nothing
// this writes reaches GitHub, a human's inbox, or any other outside system,
// and every write is a per-item DELTA the console itself can enforce
// invariants against (see below), not a destructive full-replace. This is the
// SAME reasoning post_pr_review.core.mjs documents for its own ungated write
// (advisory-by-construction, server-scoped target) — a second "may I save
// this?" round-trip would buy nothing here either, and per-turn autosave is
// the entire point: it is what lets a grill session survive a context
// compaction, because the understanding is already externalized before the
// compaction happens.
//
// Auth + config model: same as the sibling *.core.mjs modules — Jace resolves
// its own console endpoint + bearer from JACE_CONSOLE_BASE_URL /
// JACE_CONSOLE_TOKEN, never the runner's ~/.agentrail/credentials.json.
// `eveSessionId` is the ONLY identifying input, and it is never model-
// supplied — see agent/tools/save_brief.ts's doc-comment for why it must be
// the ROOT session id even when this tool is invoked from inside a subagent.
//
// TWO REFUSALS THE CALLER MUST RELAY, NEVER SWALLOW (this is the whole reason
// this module exists as a distinct write path rather than a generic POST
// helper):
//
//   1. `skippedHumanAuthorityIds` — an item a human already edited in the
//      console is LOCKED (`authority: 'human'`); this write silently dropped
//      it. "Human edits win, enforced at the route... this is route
//      enforcement, not a prompt instruction — 'please don't overwrite' fails
//      the first time the model feels confident, and a human whose
//      correction is silently reverted stops correcting" (design spec).
//   2. `skippedUnknownResolvedIds` — an item was refused for landing as
//      `kind: 'unknown'` while `state: 'resolved'` (with any resolution, or
//      none). An `unknown` is not a requirement yet, so there is nothing to
//      resolve: the only legitimate exits are answering it (kind ->
//      required/optional) or marking it `out-of-scope`. Naming only
//      `deferred` here would close one door in a room with four — the
//      readiness gate keys on `state = 'open' AND kind = 'unknown'`, so ANY
//      resolution value clears it, and `patchBriefItems` refuses them all
//      the same way.
//
// Both arrays are ALWAYS present on a success result (even when empty, as
// `[]`) — never optional, never omitted — and `renderSaved` below folds them
// into the human-readable summary explicitly, mirroring fetch_repo_wiki's own
// posture of baking framing text into rendered output so a caller cannot
// forget to mention it. A caller that cannot see its write was dropped will
// confidently tell a human something was recorded when it wasn't — the exact
// failure class briefs exist to eliminate (the 2026-07-27 blog-grilling
// session that persisted nothing).
//
// `status` IS NEVER SENT. The design spec's pinned v1 contract briefly listed
// `status?` on `save_brief`'s payload; that line was wrong (see the route's
// own doc-comment, "`status` is rejected outright, not silently dropped", and
// the one-line spec correction alongside it). `status` (`draft|ready`) is a
// HUMAN label toggled in the console; implementation-readiness is computed
// separately (`computeBriefReadiness`) so "ready" can never become a flag the
// model sets on itself to unblock its own work. This module's input shape has
// no `status` field at all — not "accepts and drops it", genuinely no such
// parameter exists to send.

export const SAVE_BRIEF_PATH = "/api/v1/runner/briefs";

// Mirrors the console route's own hand-rolled enums (apps/console/app/api/v1/
// runner/briefs/route.ts's BRIEF_AREAS/BRIEF_ITEM_KINDS/BRIEF_ITEM_STATES/
// BRIEF_ITEM_RESOLUTIONS) and packages/db-postgres/src/schema/briefs.ts's
// pgEnums. Duplicated here deliberately, not imported: apps/jace does not
// depend on @agentrail/db-postgres or the console app (same posture every
// sibling *.core.mjs module already takes on resolveConsoleConfig) — kept in
// sync by hand, same as every other cross-app contract in this codebase.
export const BRIEF_AREAS = Object.freeze(["problem", "users", "constraints", "scope", "success-signal"]);
export const BRIEF_ITEM_KINDS = Object.freeze(["required", "optional", "unknown", "out-of-scope"]);
export const BRIEF_ITEM_STATES = Object.freeze(["open", "resolved"]);
export const BRIEF_ITEM_RESOLUTIONS = Object.freeze([
  "implemented",
  "deferred",
  "rejected",
  "satisfied-elsewhere",
]);

import { hardenUntrusted } from "./sanitize-untrusted.core.mjs";
// The success response echoes back the brief/items the console just wrote —
// projected through the SAME hardening fetch_briefs.core.mjs applies on the
// read side (mirrors update_issue.core.mjs importing buildIssueBody from
// create_issue.core.mjs: a write module reusing its sibling read/shared
// module's projection rather than re-deriving it), so a brief read right
// after this write renders identically whether it came from this response or
// a fresh fetch_briefs(mode: "get") call.
import { projectBrief, projectBriefItems } from "./fetch_briefs.core.mjs";

// Same caps fetch_briefs.core.mjs applies on the read side — kept identical
// so an item read back right after this write renders the same either way.
const STATEMENT_MAX_LEN = 1000;
const EVIDENCE_MAX_LEN = 1000;

// Stable, cause-free notes for each degraded outcome. They describe the WRITE
// gap (config, transport, HTTP), never fabricate that a write landed when it
// didn't.
const DEGRADED_NOTES = {
  config_missing:
    "The console briefs endpoint is not configured for this Jace deployment (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); nothing was saved.",
  missing_slug:
    "save_brief requires a slug — reuse an existing brief's slug (from fetch_briefs) to continue it, or propose a short kebab-case slug for a brand-new idea.",
  bad_request:
    "The console rejected this write as malformed; nothing was saved. See `message` for the console's own explanation — fix the call rather than retrying unchanged.",
  unreachable:
    "The console briefs endpoint could not be reached (network error); nothing was saved. Do not retry from here.",
  unauthorized:
    "The console rejected the console token (JACE_CONSOLE_TOKEN) with 401/403 — it may be expired or scoped to another workspace.",
  not_found:
    "The console could not resolve a workspace for this conversation (404); nothing was saved.",
  content_rejected:
    "The console rejected this write because a value looked credential-shaped (422); nothing was saved. Never retry with the same content unchanged — this almost always means a human pasted something secret-looking into the conversation; do not persist it anywhere, and tell the human plainly instead.",
  upstream_error: "The console's backing store errored (5xx); nothing was saved.",
  unexpected_status: "The console returned an unexpected status; nothing was saved.",
  bad_body:
    "The console responded, but the body was not valid JSON; whether the write landed is UNCONFIRMED — treat it as unsaved rather than assuming it succeeded.",
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
 * Build the POST .../briefs URL. Every field rides in the body, never here —
 * there is nothing to encode into the URL itself.
 *
 * @param {string} baseUrl — already trimmed + de-slashed
 * @returns {string}
 */
export function buildSaveBriefUrl(baseUrl) {
  return `${baseUrl}${SAVE_BRIEF_PATH}`;
}

/**
 * Map an HTTP status to an outcome. 2xx → ok; everything else → a specific
 * degraded reason. No status triggers a retry — a failed write is reported,
 * not re-attempted (retrying a write blind risks a duplicate turn's worth of
 * items landing twice).
 *
 * @param {number} status
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 400) return { ok: false, reason: "bad_request" };
  if (status === 401 || status === 403) return { ok: false, reason: "unauthorized" };
  if (status === 404) return { ok: false, reason: "not_found" };
  if (status === 422) return { ok: false, reason: "content_rejected" };
  if (status >= 500) return { ok: false, reason: "upstream_error" };
  return { ok: false, reason: "unexpected_status" };
}

/**
 * Build a degraded result. Always carries `ok:false` + `degraded:true` + a
 * stable `reason` + a cause-free `note`; extra fields (e.g. `missing`,
 * `status`, `message`) ride along for the coordinator's honest report.
 * `message`, when present, is the CONSOLE'S OWN error string (never raw
 * transport error text, never the bearer token) — safe to relay verbatim
 * because it is server-authored, controlled text (mirrors
 * post_pr_review.core.mjs's `failure()` helper, which relays the console's
 * own message the same way: "a human already approved this specific call...
 * so there is no anti-enumeration reason to hide which refusal happened").
 * Here there is no human approval step at all, which makes relaying the
 * SPECIFIC reason even more important — it is the model's only signal for
 * what to fix before it tries again.
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
 * Sanitize + shape one model-supplied item for the wire. Mirrors
 * fetch_briefs.core.mjs's read-side caps so a round-trip (save then re-fetch)
 * renders identically. `id`/`state`/`resolution` ride only when the caller
 * actually supplied them — an omitted field must reach the console as
 * "not present", never coerced to `undefined`-as-null or a default, since
 * `patchBriefItems` on the other end treats "field present" as "caller wants
 * to touch this" (its own doc-comment: an omitted `evidence`/`state`/
 * `resolution` must survive untouched on an existing item).
 *
 * @param {{ id?: string, area: string, statement: string, evidence?: string,
 *           kind: string, state?: string, resolution?: string|null }} item
 * @returns {Record<string, unknown>}
 */
export function sanitizeItem(item) {
  const out = {
    area: item.area,
    statement: hardenUntrusted(item.statement ?? "", { maxLen: STATEMENT_MAX_LEN }),
    kind: item.kind,
  };
  if (item.id !== undefined) out.id = item.id;
  if (item.evidence !== undefined) {
    out.evidence = hardenUntrusted(item.evidence, { maxLen: EVIDENCE_MAX_LEN });
  }
  if (item.state !== undefined) out.state = item.state;
  if (item.resolution !== undefined) out.resolution = item.resolution;
  return out;
}

/**
 * Render a success outcome into plain language, EXPLICITLY naming both
 * refusal arrays whenever either is non-empty — never leaving them to be
 * discovered only by inspecting fields a caller might not think to check.
 * Mirrors fetch_repo_wiki's posture of baking mandatory framing into the
 * rendered text itself, not just into structured fields a caller could
 * silently ignore.
 *
 * @param {{ brief: Record<string, unknown>, items: Array<Record<string, unknown>>,
 *           skippedHumanAuthorityIds: string[], skippedUnknownResolvedIds: string[] }} result
 * @returns {string}
 */
export function renderSaved({ brief, items, skippedHumanAuthorityIds, skippedUnknownResolvedIds }) {
  const lines = [];
  const savedCount = Array.isArray(items) ? items.length : 0;
  lines.push(`Saved brief "${brief && brief.slug}" — ${savedCount} item(s) written.`);
  if (Array.isArray(skippedHumanAuthorityIds) && skippedHumanAuthorityIds.length) {
    lines.push(
      `REFUSED (human-locked): ${skippedHumanAuthorityIds.length} item(s) were NOT updated because a ` +
        `human already edited them in the console — their id(s): ${skippedHumanAuthorityIds.join(", ")}. ` +
        "Human edits win; do not tell the user these changes were saved.",
    );
  }
  if (Array.isArray(skippedUnknownResolvedIds) && skippedUnknownResolvedIds.length) {
    lines.push(
      `REFUSED (unknown can't resolve): ${skippedUnknownResolvedIds.length} item(s) were NOT saved as ` +
        `resolved because their kind is still "unknown": ${skippedUnknownResolvedIds.join(", ")}. ` +
        'An unknown is not a requirement yet — answer it first (kind -> "required"/"optional") or mark ' +
        'it "out-of-scope", then resolve it in a follow-up call. Do not tell the user this was recorded.',
    );
  }
  return lines.join("\n");
}

/**
 * Save (autosave) a delta of brief-level fields and/or items for the
 * conversation identified by `eveSessionId`. Returns `{ ok: true, brief,
 * items, skippedHumanAuthorityIds, skippedUnknownResolvedIds, rendered }` on
 * success, or a degraded result otherwise — never throws, never retries
 * (retrying a partially-applied write blind risks double-writing items).
 *
 *   1. unset console config           → degraded("config_missing", { missing })
 *   2. blank eveSessionId or slug     → degraded("bad_request" / "missing_slug")
 *   3. transport throws               → degraded("unreachable")
 *   4. status 400                     → degraded("bad_request", { message })
 *      (malformed body, `status` present — should never happen, this module
 *      has no such field — or no title to create a brand-new brief)
 *   5. status 401/403                 → degraded("unauthorized")
 *   6. status 404                     → degraded("not_found")
 *   7. status 422                     → degraded("content_rejected", { message, detail })
 *   8. status >= 500                  → degraded("upstream_error")
 *   9. other non-2xx status           → degraded("unexpected_status", { status })
 *  10. non-JSON body                  → degraded("bad_body", { status })
 *  11. success                        → { ok:true, brief, items,
 *                                          skippedHumanAuthorityIds,
 *                                          skippedUnknownResolvedIds, rendered }
 *
 * @param {{ eveSessionId: string, slug: string, title?: string,
 *           openQuestion?: string,
 *           grounding?: { wikiPageSlugs?: string[], memoryItemIds?: string[], commitSha?: string|null },
 *           items?: Array<{ id?: string, area: string, statement: string, evidence?: string,
 *             kind: string, state?: string, resolution?: string|null }>,
 *           env?: Record<string, string|undefined>,
 *           transport: (url: string, init: { method: string, headers: Record<string,string>, body: string }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }> }} args
 */
export async function saveBrief({
  eveSessionId,
  slug,
  title,
  openQuestion,
  grounding,
  items,
  env = {},
  transport,
}) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return degraded("config_missing", { missing: cfg.missing });

  const sessionId = String(eveSessionId ?? "").trim();
  if (!sessionId) return degraded("bad_request");

  const trimmedSlug = String(slug ?? "").trim();
  if (!trimmedSlug) return degraded("missing_slug");

  const requestBody = { eveSessionId: sessionId, slug: trimmedSlug };
  if (title !== undefined) requestBody.title = title;
  if (openQuestion !== undefined) {
    requestBody.openQuestion = hardenUntrusted(openQuestion, { maxLen: 2000 });
  }
  if (grounding !== undefined) {
    requestBody.grounding = {
      wikiPageSlugs: Array.isArray(grounding.wikiPageSlugs) ? grounding.wikiPageSlugs : [],
      memoryItemIds: Array.isArray(grounding.memoryItemIds) ? grounding.memoryItemIds : [],
      commitSha: grounding.commitSha ?? null,
    };
  }
  if (items !== undefined) {
    requestBody.items = (Array.isArray(items) ? items : []).map(sanitizeItem);
  }

  const url = buildSaveBriefUrl(cfg.baseUrl);

  let res;
  try {
    res = await transport(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
    });
  } catch {
    // Network error / DNS / timeout — a single failed attempt, reported not
    // retried.
    return degraded("unreachable");
  }

  const status = Number(res && res.status);
  const cls = classifyStatus(status);

  if (!cls.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
      return degraded(cls.reason, { status });
    }
    const message =
      body && typeof body === "object" && typeof body.error === "string" && body.error
        ? body.error
        : undefined;
    const detail =
      cls.reason === "content_rejected" &&
      body &&
      typeof body === "object" &&
      typeof body.reason === "string"
        ? body.reason
        : undefined;
    return degraded(cls.reason, { status, ...(message ? { message } : {}), ...(detail ? { detail } : {}) });
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return degraded("bad_body", { status });
  }

  if (!body || typeof body !== "object" || !body.brief) {
    return degraded("bad_body", { status });
  }

  // skippedUnknownResolvedIds entries are either an existing item's id (a
  // plain uuid) OR — for a brand-new item with no id yet — that item's own
  // `statement` text (patchBriefItems' doc-comment: "a brand-new item (no
  // `id` yet to report) reports its `statement` instead"). The latter is
  // free text the model itself just composed this same turn, but this is
  // still an untrusted-content render seam like every other one in Jace, so
  // it is hardened + capped the same way, defense-in-depth.
  const result = {
    ok: true,
    brief: projectBrief(body.brief),
    items: projectBriefItems(body.items),
    skippedHumanAuthorityIds: (Array.isArray(body.skippedHumanAuthorityIds)
      ? body.skippedHumanAuthorityIds
      : []
    ).map((s) => String(s)),
    skippedUnknownResolvedIds: (Array.isArray(body.skippedUnknownResolvedIds)
      ? body.skippedUnknownResolvedIds
      : []
    ).map((s) => hardenUntrusted(String(s), { maxLen: 300 })),
  };
  return { ...result, rendered: renderSaved(result) };
}
