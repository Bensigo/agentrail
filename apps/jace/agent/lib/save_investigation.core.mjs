// Pure, dependency-free core for Jace's UNGATED autosave WRITE path into
// INVESTIGATIONS — the durable, server-side record of ONE production
// incident (debugging design spec:
// docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md, spec PR
// #1501; `.superpowers/sdd/spec.md` is the working copy this implementation
// follows). Structural sibling of save_brief.core.mjs — same UNGATED
// rationale, same per-item DELTA shape, same never-throw/no-retry posture —
// for a production symptom instead of a product idea. No SDK, no network
// primitives of its own: the single HTTP call is an injected `transport`
// seam (real fetch with a timeout in the thin tool wrapper, a fake in
// tests), so every branch — success and every degraded/refused outcome — is
// unit-testable without a live server.
//
// UNGATED, deliberately (mirrors save_brief.core.mjs's own reasoning): an
// investigation lives only inside AgentRail's own console — nothing this
// writes reaches GitHub, a human's inbox, or any other outside system, and
// `create_issue` remains the only boundary crossing that still requires
// human approval. Every write here is also a per-item DELTA the console
// itself enforces invariants against — human-authority items are locked,
// `kind: 'evidence'` items are immutable (the evidence route, Task 4, is the
// ONLY writer of that kind), a hypothesis cannot enter `supported`/`refuted`
// without evidence, and (unlike brief_items) an item's `kind` is fixed at
// creation — never a destructive full-replace, so there is nothing here for
// a human to approve before it happens. `record_verdict` (the sibling write
// tool) — NOT this module — is the only thing that ever sets a verdict; the
// wire route itself rejects `verdict`/`status` outright with 400 (Global
// Constraints), and this module's input shape has no such parameter at all,
// mirroring exactly how save_brief.core.mjs has no `status` parameter.
//
// SESSION RESOLUTION — same reasoning as save_brief.ts / fetch_investigations.ts:
// `agent/tools/save_investigation.ts` resolves
// `ctx.session.parent?.rootSessionId ?? ctx.session.id`, never the raw child
// session id a declared subagent might be running under.
//
// SEVEN ARRAYS THE CALLER MUST RELAY, NEVER SWALLOW (this is the whole
// reason this module exists as a distinct write path rather than a generic
// POST helper) — `applied` (what actually landed) plus SIX refusal-shaped
// arrays, each with its own PINNED rendering prefix (see `renderSaved`
// below):
//
//   1. `skippedHumanAuthorityIds` — REFUSED (human-locked): an item a human
//      already edited in the console is LOCKED; this write silently dropped
//      it. Human edits win, enforced at the route (Task 2's own doc-comment
//      on `patchInvestigationItems`), not a prompt instruction.
//   2. `skippedEvidenceImmutableIds` — REFUSED (evidence immutable): the
//      touched row is — or would become — `kind: 'evidence'`. The evidence
//      capability layer (Task 4) is the ONLY writer of that kind, for
//      creation AND mutation; this path refuses it outright either way.
//   3. `skippedHypothesisNeedsEvidence` — REFUSED (hypothesis needs
//      evidence): a hypothesis would enter `supported`/`refuted` with an
//      empty EFFECTIVE `evidence_refs`. Checked against the merged
//      post-patch value, not just what this call itself sent.
//   4. `skippedKindChangeIds` — REFUSED (kind is fixed at creation): unlike
//      `brief_items` (where re-kinding is the unknown-resolution mechanism),
//      an investigation item's `kind` never changes after creation — only
//      `state` moves it through its lifecycle. A patch naming a different
//      `kind` than the row's own is refused outright.
//   5. `unmatchedIds` — UNMATCHED (no such item in this investigation): an
//      `id` was named but matched no row under THIS investigation — either
//      it belongs to a different investigation, or it never existed (Task
//      2's own doc-comment: "previously vanished silently; now always
//      surfaced").
//   6. `skippedLinks` — SKIPPED LINK (target not found): a `{ targetSlug,
//      role }` link whose `targetSlug` did not resolve to an investigation
//      in the caller's own workspace. Never a hard failure — the rest of the
//      write still lands.
//
// All SEVEN arrays are ALWAYS present on a success result (even when empty,
// as `[]`) — never optional, never omitted — and `renderSaved` below folds
// every non-empty one into the human-readable summary explicitly, mirroring
// save_brief's own posture of baking mandatory framing into rendered output
// so a caller cannot forget to mention a refusal.
//
// EVIDENCE_REFS NAMING (Self-Review "Type consistency check" in the plan):
// the model-facing item shape uses `evidence_refs` (snake_case) — the SAME
// vocabulary the debugger's ROUND_REPORT/CHANGE/ANOMALY schemas (Task 9/10)
// use everywhere else on Jace's debugging surface, and the same name
// `fetch_investigations.core.mjs` projects a fetched item's refs back as
// (see that module's `projectInvestigationItem` doc-comment) — so a model
// reading an item back from a fetch and citing it in a later save never has
// to context-switch naming conventions. `sanitizeItem` (below) is the one
// place that maps it to the wire's `evidenceRefs` (camelCase, matching
// Drizzle/TS) before the request ever leaves this module.
//
// LINKS (Self-Review S1): `recurrence_of`/`related` edges are the reopen-
// vs-new mechanism's other half (investigations schema doc-comment) — a new
// investigation for a symptom that already had a `concluded` verdict links
// back to the old one, structurally discrediting it. Resolved server-side,
// within the caller's own workspace; an unresolvable slug never fails the
// whole write.
//
// ANCHOR — plumbs the route's session-anchor support through to this tool,
// identical semantics to save_brief's own `anchor`: `anchor: true` anchors
// THIS conversation to THIS call's investigation; `anchor: false` clears it
// (and, with no other content field set, is a PURE clear needing no `slug`
// at all — the "this is a different incident" case, which can fire with
// nothing else settled yet); omitted leaves the anchor untouched.

export const SAVE_INVESTIGATION_PATH = "/api/v1/runner/investigations";

// Mirrors the console route's own hand-rolled enums
// (apps/console/app/api/v1/runner/investigations/route.ts's
// INVESTIGATION_SEVERITIES/INVESTIGATION_ITEM_KINDS/HYPOTHESIS_STATES/
// INVESTIGATION_LINK_ROLES) and packages/db-postgres/src/schema/investigations.ts's
// pgEnums. Duplicated here deliberately, not imported — apps/jace does not
// depend on @agentrail/db-postgres or the console app (same posture every
// sibling *.core.mjs module already takes on resolveConsoleConfig).
export const INVESTIGATION_SEVERITIES = Object.freeze(["low", "medium", "high", "critical"]);
export const INVESTIGATION_ITEM_KINDS = Object.freeze([
  "timeline_event",
  "evidence",
  "hypothesis",
  "finding",
  "verdict",
  "lesson_candidate",
]);
export const HYPOTHESIS_STATES = Object.freeze(["open", "supported", "refuted", "inconclusive"]);
export const INVESTIGATION_LINK_ROLES = Object.freeze(["recurrence_of", "related"]);

import { hardenUntrusted } from "./sanitize-untrusted.core.mjs";
// The success response echoes back the investigation the console just
// wrote — projected through the SAME hardening fetch_investigations.core.mjs
// applies on the read side (mirrors save_brief.core.mjs importing
// `projectBrief` from fetch_briefs.core.mjs: a write module reusing its
// sibling read module's projection rather than re-deriving it).
import { projectInvestigation } from "./fetch_investigations.core.mjs";

// Same caps fetch_investigations.core.mjs applies on the read side — kept
// identical so an item read back right after this write renders the same
// either way.
const BODY_MAX_LEN = 2000;
const MECHANISM_MAX_LEN = 1000;
// Caps for entries that echo the caller's OWN just-composed text back in a
// refusal array (a brand-new item with no id yet reports its body instead —
// see patchInvestigationItems' doc-comment) or a link's target slug — the
// same untrusted-content render seam as save_brief's own
// skippedUnknownResolvedIds handling.
const REFUSAL_ENTRY_MAX_LEN = 300;

// Stable, cause-free notes for each degraded outcome. They describe the
// WRITE gap (config, transport, HTTP), never fabricate that a write landed
// when it didn't.
const DEGRADED_NOTES = {
  config_missing:
    "The console investigations endpoint is not configured for this Jace deployment (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); nothing was saved.",
  missing_slug:
    "save_investigation requires a slug — reuse an existing investigation's slug (from fetch_investigations) to continue it, or propose a short kebab-case slug for a brand-new incident.",
  bad_request:
    "The console rejected this write as malformed; nothing was saved. See `message` for the console's own explanation — fix the call rather than retrying unchanged.",
  unreachable:
    "The console investigations endpoint could not be reached (network error); nothing was saved. Do not retry from here.",
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
 * Resolve the console endpoint + bearer from the environment. Deliberately
 * duplicated verbatim from the sibling *.core.mjs modules — see
 * fetch_investigations.core.mjs's identical function for the same note.
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
 * Build the POST .../investigations URL. Every field rides in the body,
 * never here.
 *
 * @param {string} baseUrl — already trimmed + de-slashed
 * @returns {string}
 */
export function buildSaveInvestigationUrl(baseUrl) {
  return `${baseUrl}${SAVE_INVESTIGATION_PATH}`;
}

/**
 * Map an HTTP status to an outcome. 2xx → ok; everything else → a specific
 * degraded reason. No status triggers a retry — retrying a partially-applied
 * write blind risks double-writing items.
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
 * stable `reason` + a cause-free `note`; extra fields (`missing`, `status`,
 * `message`, `detail`) ride along. `message`/`detail`, when present, are the
 * CONSOLE'S OWN error string(s) — server-authored, controlled text, safe to
 * relay verbatim (mirrors save_brief.core.mjs's identical `degraded` and its
 * doc-comment on why).
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
 * Sanitize + shape one model-supplied item for the wire. `kind` rides
 * unconditionally — the wire REQUIRES it on every item, even a patch to an
 * existing row (the route's own `isRawInvestigationItem` validator has no
 * "omit kind on update" branch, unlike `brief_items`). `body`/`mechanism` are
 * hardened before they ever leave this module. The load-bearing rename:
 * model-facing `evidence_refs` (snake_case, the vocabulary
 * ROUND_REPORT/CHANGE/ANOMALY schemas use) becomes the wire's `evidenceRefs`
 * (camelCase) — done HERE, once, so no other seam has to remember it. Every
 * other field rides only when the caller actually supplied it — mirrors
 * `patchInvestigationItems`' own `"x" in item` partial-patch semantics: an
 * omitted field must reach the console as "not present", never coerced to
 * `undefined`-as-null.
 *
 * @param {{ id?: string, kind: string, body?: string, mechanism?: string,
 *           state?: string|null, evidence_refs?: string[], data?: Record<string, unknown> }} item
 * @returns {Record<string, unknown>}
 */
export function sanitizeItem(item) {
  const out = { kind: item.kind };
  if (item.id !== undefined) out.id = item.id;
  if (item.body !== undefined) out.body = hardenUntrusted(item.body, { maxLen: BODY_MAX_LEN });
  if (item.mechanism !== undefined) out.mechanism = hardenUntrusted(item.mechanism, { maxLen: MECHANISM_MAX_LEN });
  if (item.state !== undefined) out.state = item.state; // may be explicitly null
  if (item.evidence_refs !== undefined) out.evidenceRefs = item.evidence_refs;
  if (item.data !== undefined) out.data = item.data;
  return out;
}

/**
 * Sanitize one model-supplied `{ targetSlug, role }` link for the wire — both
 * field names already match the wire contract (no rename needed, unlike
 * items' `evidence_refs`). `targetSlug` is not hardened on the way out (it is
 * an identifier referencing an existing investigation, not drafted prose,
 * mirroring how `slug` itself is never hardened before sending) — the
 * console's own secret scan still covers it server-side.
 *
 * @param {{ targetSlug: string, role: string }} link
 * @returns {Record<string, unknown>}
 */
export function sanitizeLink(link) {
  return { targetSlug: link.targetSlug, role: link.role };
}

/**
 * Render the pure `{ anchor: false }` clear — no slug, nothing touched at
 * all. Distinct from `renderSaved` because there is no investigation/items
 * to report on this path.
 *
 * @returns {string}
 */
export function renderAnchorCleared() {
  return (
    "Cleared this conversation's investigation anchor — nothing was written or touched. " +
    "Re-resolve with fetch_investigations (mode=\"search\" on the human's own words or the symptom signature, " +
    "or mode=\"anchor\" if they name an existing incident) before writing anything new."
  );
}

/**
 * Render a success outcome into plain language, EXPLICITLY naming every
 * non-empty refusal array with its PINNED prefix — never leaving one to be
 * discovered only by inspecting a field a caller might not think to check.
 * `anchor`, when present, is the anchor state THIS call left the session in
 * (`{ investigationId }` after `anchor: true`, `null` after `anchor: false`
 * alongside a slug) — omitted entirely when the call didn't touch the anchor.
 *
 * @param {{ investigation: Record<string, unknown>, applied: string[],
 *           skippedHumanAuthorityIds: string[], skippedEvidenceImmutableIds: string[],
 *           skippedHypothesisNeedsEvidence: string[], skippedKindChangeIds: string[],
 *           unmatchedIds: string[], skippedLinks: string[],
 *           anchor?: { investigationId: string } | null }} result
 * @returns {string}
 */
export function renderSaved({
  investigation,
  applied,
  skippedHumanAuthorityIds,
  skippedEvidenceImmutableIds,
  skippedHypothesisNeedsEvidence,
  skippedKindChangeIds,
  unmatchedIds,
  skippedLinks,
  anchor,
}) {
  const lines = [];
  const appliedCount = Array.isArray(applied) ? applied.length : 0;
  lines.push(`Saved investigation "${investigation && investigation.slug}" — ${appliedCount} item(s) written.`);
  if (anchor !== undefined) {
    lines.push(
      anchor
        ? "This conversation is now anchored to this investigation — later turns should resume here via " +
            'fetch_investigations(mode="anchor") instead of searching again.'
        : "This conversation's investigation anchor was cleared alongside this write.",
    );
  }
  if (Array.isArray(skippedHumanAuthorityIds) && skippedHumanAuthorityIds.length) {
    lines.push(
      `REFUSED (human-locked): ${skippedHumanAuthorityIds.length} item(s) were NOT updated because a human ` +
        `already edited them in the console — their id(s): ${skippedHumanAuthorityIds.join(", ")}. Human edits ` +
        "win; do not tell the user these changes were saved.",
    );
  }
  if (Array.isArray(skippedEvidenceImmutableIds) && skippedEvidenceImmutableIds.length) {
    lines.push(
      `REFUSED (evidence immutable): ${skippedEvidenceImmutableIds.length} item(s) were NOT written because ` +
        `evidence items are immutable — only the evidence capability layer may create or edit them: ` +
        `${skippedEvidenceImmutableIds.join(", ")}. Do not tell the user these were saved.`,
    );
  }
  if (Array.isArray(skippedHypothesisNeedsEvidence) && skippedHypothesisNeedsEvidence.length) {
    lines.push(
      `REFUSED (hypothesis needs evidence): ${skippedHypothesisNeedsEvidence.length} item(s) were NOT saved as ` +
        `supported/refuted because they have no evidence_refs yet: ${skippedHypothesisNeedsEvidence.join(", ")}. ` +
        "Cite at least one evidence id first, then retry.",
    );
  }
  if (Array.isArray(skippedKindChangeIds) && skippedKindChangeIds.length) {
    lines.push(
      `REFUSED (kind is fixed at creation): ${skippedKindChangeIds.length} item(s) tried to change an existing ` +
        `item's kind — refused; kind never changes after creation, only state does: ${skippedKindChangeIds.join(", ")}.`,
    );
  }
  if (Array.isArray(unmatchedIds) && unmatchedIds.length) {
    lines.push(
      `UNMATCHED (no such item in this investigation): ${unmatchedIds.length} id(s) named in this call matched ` +
        `no item on this investigation — check you're not reusing an id from a different investigation: ` +
        `${unmatchedIds.join(", ")}.`,
    );
  }
  if (Array.isArray(skippedLinks) && skippedLinks.length) {
    lines.push(
      `SKIPPED LINK (target not found): ${skippedLinks.length} link(s) were NOT recorded because the target ` +
        `slug did not resolve to an investigation in this workspace: ${skippedLinks.join(", ")}.`,
    );
  }
  return lines.join("\n");
}

/**
 * Save (autosave) a delta of investigation-level fields and/or items/links
 * for the conversation identified by `eveSessionId`. Returns `{ ok: true,
 * investigation, applied, skippedHumanAuthorityIds,
 * skippedEvidenceImmutableIds, skippedHypothesisNeedsEvidence,
 * skippedKindChangeIds, unmatchedIds, skippedLinks, rendered }` on success,
 * or a degraded result otherwise — never throws, never retries.
 *
 *   1. unset console config           → degraded("config_missing", { missing })
 *   2. blank eveSessionId             → degraded("bad_request")
 *   2b. blank slug, NOT a pure         → degraded("missing_slug")
 *       `{ anchor: false }` clear
 *   3. transport throws               → degraded("unreachable")
 *   4. status 400                     → degraded("bad_request", { message })
 *   5. status 401/403                 → degraded("unauthorized")
 *   6. status 404                     → degraded("not_found")
 *   7. status 422                     → degraded("content_rejected", { message, detail })
 *   8. status >= 500                  → degraded("upstream_error")
 *   9. other non-2xx status           → degraded("unexpected_status", { status })
 *  10. non-JSON body                  → degraded("bad_body", { status })
 *  11. success, pure anchor clear     → { ok:true, anchor: null, applied: [],
 *                                          <every skip/unmatched array>: [], rendered }
 *  12. success, normal write          → { ok:true, investigation, applied,
 *                                          skippedHumanAuthorityIds, skippedEvidenceImmutableIds,
 *                                          skippedHypothesisNeedsEvidence, skippedKindChangeIds,
 *                                          unmatchedIds, skippedLinks,
 *                                          anchor? (only when this call's `anchor` was true or false),
 *                                          rendered }
 *
 * @param {{ eveSessionId: string, slug?: string, title?: string, symptomStatement?: string,
 *           symptomSignature?: string, affectedSurface?: string, severity?: string,
 *           firstSeenAt?: string|null,
 *           items?: Array<{ id?: string, kind: string, body?: string, mechanism?: string,
 *             state?: string|null, evidence_refs?: string[], data?: Record<string, unknown> }>,
 *           links?: Array<{ targetSlug: string, role: string }>,
 *           anchor?: boolean,
 *           env?: Record<string, string|undefined>,
 *           transport: (url: string, init: { method: string, headers: Record<string,string>, body: string }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }> }} args
 */
export async function saveInvestigation({
  eveSessionId,
  slug,
  title,
  symptomStatement,
  symptomSignature,
  affectedSurface,
  severity,
  firstSeenAt,
  items,
  links,
  anchor,
  env = {},
  transport,
}) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return degraded("config_missing", { missing: cfg.missing });

  const sessionId = String(eveSessionId ?? "").trim();
  if (!sessionId) return degraded("bad_request");

  const trimmedSlug = String(slug ?? "").trim();
  const isPureAnchorClear =
    anchor === false &&
    !trimmedSlug &&
    title === undefined &&
    symptomStatement === undefined &&
    symptomSignature === undefined &&
    affectedSurface === undefined &&
    severity === undefined &&
    firstSeenAt === undefined &&
    (items === undefined || (Array.isArray(items) && items.length === 0)) &&
    (links === undefined || (Array.isArray(links) && links.length === 0));
  if (!trimmedSlug && !isPureAnchorClear) return degraded("missing_slug");

  const requestBody = { eveSessionId: sessionId };
  if (trimmedSlug) requestBody.slug = trimmedSlug;
  if (title !== undefined) requestBody.title = title;
  if (symptomStatement !== undefined) requestBody.symptomStatement = symptomStatement;
  if (symptomSignature !== undefined) requestBody.symptomSignature = symptomSignature;
  if (affectedSurface !== undefined) requestBody.affectedSurface = affectedSurface;
  if (severity !== undefined) requestBody.severity = severity;
  if (firstSeenAt !== undefined) requestBody.firstSeenAt = firstSeenAt;
  if (items !== undefined) requestBody.items = (Array.isArray(items) ? items : []).map(sanitizeItem);
  if (links !== undefined) requestBody.links = (Array.isArray(links) ? links : []).map(sanitizeLink);
  if (anchor !== undefined) requestBody.anchor = anchor;

  const url = buildSaveInvestigationUrl(cfg.baseUrl);

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
      body && typeof body === "object" && typeof body.error === "string" && body.error ? body.error : undefined;
    const detail =
      cls.reason === "content_rejected" && body && typeof body === "object" && typeof body.reason === "string"
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

  if (!body || typeof body !== "object") {
    return degraded("bad_body", { status });
  }

  // The pure `{ anchor: false }` clear (no slug) never reaches
  // `upsertInvestigation`/`patchInvestigationItems` on the console side, so
  // its 200 body is just `{ anchor: null }` — no `investigation` key at all.
  // Handled BEFORE the "investigation required" check below, or every
  // anchor-only clear would wrongly degrade as `bad_body`. Every skip/
  // unmatched array is still reported as `[]` (not omitted) so a caller
  // reading this result never has to special-case "was this a pure clear".
  if (!("investigation" in body)) {
    if (!("anchor" in body)) return degraded("bad_body", { status });
    const result = {
      ok: true,
      anchor: body.anchor === null ? null : body.anchor,
      applied: [],
      skippedHumanAuthorityIds: [],
      skippedEvidenceImmutableIds: [],
      skippedHypothesisNeedsEvidence: [],
      skippedKindChangeIds: [],
      unmatchedIds: [],
      skippedLinks: [],
    };
    return { ...result, rendered: renderAnchorCleared() };
  }

  const hardenEntries = (raw) =>
    (Array.isArray(raw) ? raw : []).map((s) => hardenUntrusted(String(s), { maxLen: REFUSAL_ENTRY_MAX_LEN }));
  const stringEntries = (raw) => (Array.isArray(raw) ? raw : []).map((s) => String(s));

  const result = {
    ok: true,
    investigation: projectInvestigation(body.investigation),
    // `applied` is the success list (ids the write actually landed under),
    // not an echo of anything refused — String()-coerced only.
    applied: stringEntries(body.applied),
    // Every refusal-shaped array below is hardened, not just String()-coerced
    // — including skippedHumanAuthorityIds/skippedKindChangeIds/unmatchedIds,
    // which in the CURRENT server implementation only ever carry real item
    // ids, but nothing at the wire's type level (plain `string[]`) guarantees
    // that stays true. skippedEvidenceImmutableIds/skippedHypothesisNeedsEvidence
    // are the two that routinely carry a brand-new item's own body text (no
    // id yet) — see patchInvestigationItems' doc-comment — so hardening is
    // load-bearing there; on the other three it is defense-in-depth
    // consistency with that same posture (mirrors how eligibility.blocking
    // is hardened even though it is normally server-fixed text).
    skippedHumanAuthorityIds: hardenEntries(body.skippedHumanAuthorityIds),
    skippedEvidenceImmutableIds: hardenEntries(body.skippedEvidenceImmutableIds),
    skippedHypothesisNeedsEvidence: hardenEntries(body.skippedHypothesisNeedsEvidence),
    skippedKindChangeIds: hardenEntries(body.skippedKindChangeIds),
    unmatchedIds: hardenEntries(body.unmatchedIds),
    // Target slugs the model itself composed this turn — same untrusted-echo
    // seam.
    skippedLinks: hardenEntries(body.skippedLinks),
    // `anchor` only rides here when THIS call's `raw.anchor` was true or
    // false (the route omits the key entirely otherwise) — mirrors
    // save_brief.core.mjs's identical hasOwnProperty check.
    ...(Object.prototype.hasOwnProperty.call(body, "anchor") ? { anchor: body.anchor } : {}),
  };
  return { ...result, rendered: renderSaved(result) };
}
