// Pure, dependency-free core for Jace's UNGATED-but-SERVER-VALIDATED verdict
// write path: `POST /api/v1/runner/investigations/verdict` (debugging design
// spec: docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md,
// spec PR #1501). No SDK, no network primitives of its own: BOTH the verdict
// POST and the fire-and-forget Langfuse score push are injected seams
// (`transport` for the verdict call, `fetchImpl` for the score — see below
// for why they are deliberately different shapes), so every branch is
// unit-testable without a live server or a live Langfuse instance.
//
// UNGATED, but for a DIFFERENT reason than save_investigation/save_brief's
// "internal and reversible" argument: this write is FAIL-CLOSED and
// server-validated. `recordVerdict` (packages/db-postgres/src/queries/investigations.ts)
// runs its own transactional `computeVerdictEligibility` check for
// `root_caused` and its own `missingEvidence` check for `undetermined` —
// the model cannot force a verdict through by asserting eligibility; the
// server either agrees or refuses (409), every time. A human approval gate
// would only ever rubber-stamp what the server already decided, so it buys
// nothing here that the fail-closed check doesn't already provide. This
// module NEVER re-derives eligibility itself (see fetch_investigations.core.mjs's
// `projectEligibility` doc-comment for the identical reasoning applied to
// the read side) — it relays exactly what the console says, `ok:true` or a
// 409's `blocking` array, and nothing in between.
//
// SESSION RESOLUTION — same reasoning as save_investigation.ts /
// fetch_investigations.ts: `agent/tools/record_verdict.ts` resolves
// `ctx.session.parent?.rootSessionId ?? ctx.session.id` and passes that
// SAME value through as both this call's `eveSessionId` (the wire identity
// the console resolves the workspace from) AND the Langfuse score's
// `sessionId` (the root session id every span/score in this dispatch tree
// groups under — instrumentation.core.mjs's `resolveRootSessionId` is the
// canonical definition; a root-resolved `eveSessionId` already IS that
// value, so there is nothing further to resolve here).
//
// TWO TRANSPORT SEAMS, DELIBERATELY DIFFERENT SHAPES:
//   - `transport(url, init) => Promise<{ status, json() }>` — the main
//     verdict POST, same shape every sibling *.core.mjs module here uses.
//   - `fetchImpl(url, init) => Promise<{ ok, status }>` — the Langfuse score
//     push, copied VERBATIM (transport shape + the single-`console.warn`
//     failure funnel) from `agent/hooks/langfuse-verdict-score.ts`'s own
//     `pushScore`, because that is what this task's brief calls for and it
//     is what a real global `fetch` already returns unwrapped — no `{status,
//     json()}` narrowing needed for a fire-and-forget call this module never
//     reads the body of.
//
// THREE OUTCOMES, three different result shapes (deliberately NOT all
// squeezed through the generic `degraded()` helper — see `refused` below):
//   1. 200 — `recordVerdict` (the query) accepted the verdict. Fires exactly
//      one Langfuse score (gated on `isLangfuseConfigured`) WITHOUT awaiting
//      it, then immediately returns `{ ok: true, rendered }` — the score
//      push's own network round-trip must never delay the tool's result.
//   2. 409 — the console's OWN fail-closed refusal (ineligible for
//      `root_caused`, missing `confidence`, or empty `missingEvidence` for
//      `undetermined`). This is a MEANINGFUL, EXPECTED outcome — the gate
//      working as designed — not an infra failure, so it gets its own
//      `refused()` shape (`{ ok: false, refused: true, blocking, rendered }`)
//      rather than `degraded()`'s generic `{ reason, note }` shape, mirroring
//      how fetch_briefs/fetch_investigations give `mode="get"` 404 its own
//      non-degraded shape instead of forcing every "meaningful non-success"
//      outcome through one generic bucket. NO score is pushed on this path —
//      see `recordVerdict`'s own branch below.
//   3. everything else (config/transport/auth/not_found/422/5xx/bad body) —
//      the familiar `degraded(reason, extra)` shape every sibling module
//      uses. 422 specifically means the console's own secret scan flagged
//      `mechanismSummary` as credential-shaped (mirrors
//      `save_investigation.core.mjs`'s identical `content_rejected` path).

import { hardenUntrusted } from "./sanitize-untrusted.core.mjs";
import { isLangfuseConfigured } from "./instrumentation.core.mjs";

export const RECORD_VERDICT_PATH = "/api/v1/runner/investigations/verdict";

// Mirrors the console route's own hand-rolled enums
// (apps/console/app/api/v1/runner/investigations/verdict/route.ts's
// INVESTIGATION_VERDICTS/VERDICT_CONFIDENCES) and
// packages/db-postgres/src/schema/investigations.ts's pgEnums. Duplicated
// here deliberately, not imported — same posture as every sibling
// *.core.mjs module's resolveConsoleConfig.
export const INVESTIGATION_VERDICTS = Object.freeze(["root_caused", "undetermined"]);
export const VERDICT_CONFIDENCES = Object.freeze(["confirmed", "probable", "circumstantial"]);

const MECHANISM_SUMMARY_MAX_LEN = 2000;
const MISSING_EVIDENCE_ENTRY_MAX_LEN = 500;
const BLOCKING_REASON_MAX_LEN = 300;
// The Langfuse score push is fire-and-forget (recordVerdict never awaits
// it — see that function's own comment), but "fire-and-forget" must not
// mean "unbounded": without a cap, a slow/hanging Langfuse endpoint would
// leave an ever-growing pile of dangling requests/sockets across repeated
// verdict calls in this long-lived process. Bounded independently of the
// main verdict POST's own 10s tool-level timeout (agent/tools/record_verdict.ts).
const SCORE_PUSH_TIMEOUT_MS = 3000;

// Stable, cause-free notes for each degraded (infra-failure) outcome. `refused`
// (409) is NOT one of these — see this module's top doc-comment for why it
// gets its own shape instead.
const DEGRADED_NOTES = {
  config_missing:
    "The console investigations-verdict endpoint is not configured for this Jace deployment (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); no verdict was recorded.",
  bad_request:
    "The verdict request was rejected as malformed (400, or a missing eveSessionId/slug/invalid verdict caught before the request was even sent); no verdict was recorded.",
  unreachable:
    "The console investigations-verdict endpoint could not be reached (network error); no verdict was recorded. Do not retry from here.",
  unauthorized:
    "The console rejected the console token (JACE_CONSOLE_TOKEN) with 401/403 — it may be expired or scoped to another workspace.",
  not_found:
    "No investigation exists at that slug for this workspace (404); no verdict was recorded. Resolve the investigation first with fetch_investigations.",
  content_rejected:
    "The console rejected mechanismSummary because it looked credential-shaped (422); no verdict was recorded. Never retry with the same content unchanged — tell the human plainly instead.",
  upstream_error: "The console's backing store errored (5xx); no verdict was recorded.",
  unexpected_status: "The console returned an unexpected status; no verdict was recorded.",
  bad_body:
    "The console responded, but the body was not valid JSON, or did not confirm ok:true; whether the verdict landed is UNCONFIRMED — treat it as unrecorded rather than assuming success.",
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
 * Build the POST .../investigations/verdict URL. Every field rides in the
 * body, never here.
 *
 * @param {string} baseUrl — already trimmed + de-slashed
 * @returns {string}
 */
export function buildRecordVerdictUrl(baseUrl) {
  return `${baseUrl}${RECORD_VERDICT_PATH}`;
}

/**
 * Map an HTTP status to an outcome. 2xx → ok; 409 maps to its OWN `"refused"`
 * reason (handled by a dedicated branch in `recordVerdict`, never through the
 * generic `degraded()` helper — see this module's top doc-comment); every
 * other non-2xx → the familiar degraded reasons every sibling module uses.
 *
 * @param {number} status
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 400) return { ok: false, reason: "bad_request" };
  if (status === 401 || status === 403) return { ok: false, reason: "unauthorized" };
  if (status === 404) return { ok: false, reason: "not_found" };
  if (status === 409) return { ok: false, reason: "refused" };
  if (status === 422) return { ok: false, reason: "content_rejected" };
  if (status >= 500) return { ok: false, reason: "upstream_error" };
  return { ok: false, reason: "unexpected_status" };
}

/**
 * Build a degraded (infra-failure) result. Always carries `ok:false` +
 * `degraded:true` + a stable `reason` + a cause-free `note`; extra fields
 * ride along. Never used for the 409 case — see `refused` below.
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
 * Build the 409 refusal result — a MEANINGFUL, expected outcome (the
 * fail-closed gate working as designed), not an infra degradation. Carries
 * `ok:false` + `refused:true` + the server's own `blocking` reasons
 * (hardened defensively, per the task's "every rendered string" rule, even
 * though they are server-authored fixed messages) + the pinned rendering
 * `"Verdict refused — <blocking joined \"; \">"`.
 *
 * @param {unknown} blocking
 * @returns {{ ok: false, refused: true, blocking: string[], rendered: string }}
 */
export function refused(blocking) {
  const list = (Array.isArray(blocking) ? blocking : [])
    .filter((s) => typeof s === "string")
    .map((s) => hardenUntrusted(s, { maxLen: BLOCKING_REASON_MAX_LEN }));
  return {
    ok: false,
    refused: true,
    blocking: list,
    rendered: `Verdict refused — ${list.join("; ")}`,
  };
}

/**
 * Render the 200 success outcome.
 *
 * @param {{ verdict: string, slug: string }} args
 * @returns {string}
 */
export function renderVerdictSuccess({ verdict, slug }) {
  return `Verdict recorded: ${verdict} for investigation "${slug}".`;
}

/**
 * POST one session-scoped score to Langfuse (`POST /api/public/scores`) —
 * transport + failure funnel copied VERBATIM from
 * `agent/hooks/langfuse-verdict-score.ts`'s own `pushScore`, PLUS a bounded
 * `AbortSignal.timeout(SCORE_PUSH_TIMEOUT_MS)` the hook's original didn't
 * carry (added here because `recordVerdict` no longer awaits this call —
 * see that function's own comment — so an unbounded hang would otherwise
 * accumulate silently in the background across repeated verdict calls
 * instead of surfacing promptly via the `console.warn` funnel). Fire-and-
 * forget: every failure — transport rejection, timeout abort, or a non-2xx
 * response — funnels into exactly ONE `console.warn`, and the returned
 * promise NEVER rejects. A score-push failure must never surface into the
 * tool's own result.
 *
 * @param {{ baseUrl: string, publicKey: string, secretKey: string,
 *           fetchImpl: (url: string, init: { method: string, headers: Record<string,string>, body: string, signal?: AbortSignal }) =>
 *             Promise<{ ok: boolean, status: number }>,
 *           body: Record<string, unknown> }} params
 * @returns {Promise<void>}
 */
export function pushVerdictScore({ baseUrl, publicKey, secretKey, fetchImpl, body }) {
  const token = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const url = `${String(baseUrl).replace(/\/+$/, "")}/api/public/scores`;
  return fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SCORE_PUSH_TIMEOUT_MS),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`langfuse scores POST returned HTTP ${res.status}`);
    })
    .catch((err) => {
      console.warn("[record_verdict] failed to push score:", err?.message ?? err);
    });
}

/**
 * Record a verdict for the investigation at `slug`, or return a refused/
 * degraded result — never throws, never retries.
 *
 *   1. unset console config       → degraded("config_missing", { missing })
 *   2. blank eveSessionId         → degraded("bad_request")
 *   3. blank slug                 → degraded("bad_request")
 *   4. invalid verdict enum       → degraded("bad_request")
 *   5. transport throws           → degraded("unreachable")
 *   6. status 400                 → degraded("bad_request")
 *   7. status 401/403             → degraded("unauthorized")
 *   8. status 404                 → degraded("not_found")
 *   9. status 409                 → refused(body.blocking) — NO score pushed
 *  10. status 422                 → degraded("content_rejected", { message, detail })
 *  11. status >= 500              → degraded("upstream_error")
 *  12. non-JSON / non-ok:true 200 → degraded("bad_body")
 *  13. success (200, ok:true)     → fires exactly one Langfuse score (gated
 *      on isLangfuseConfigured; `sessionId` = the SAME eveSessionId this
 *      call sent; `metadata.investigation_id` = a STRING, PREFERRING
 *      `body.investigationId` — the console route now always sends it
 *      (`apps/console/.../investigations/verdict/route.ts`'s own
 *      final-review fix: `investigationId` is the uuid the route already
 *      resolved from `slug`, not a second lookup) — and falling back to
 *      `slug` only as a defensive hedge (an older/misbehaving console
 *      build, or a malformed body). `slug` is a HUMAN-RENAMABLE identity
 *      (`investigations` schema doc-comment), so the calibration join key
 *      should be the immutable uuid whenever the wire actually supplies
 *      one — `slug` still rides along unconditionally as its own
 *      `metadata.slug` field, never dropped) WITHOUT awaiting it — the tool
 *      result resolves immediately, `{ ok: true, rendered }`, the instant
 *      the console confirms the verdict landed; the score push finishes in
 *      the background (bounded, see `pushVerdictScore`'s
 *      SCORE_PUSH_TIMEOUT_MS) and can never delay or fail this return
 *
 * @param {{ eveSessionId: string, slug: string, verdict: string, confidence?: string,
 *           mechanismSummary?: string, missingEvidence?: string[],
 *           changeRecord?: { recordId: string, missedCheck: string },
 *           env?: Record<string, string|undefined>,
 *           transport: (url: string, init: { method: string, headers: Record<string,string>, body: string }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }>,
 *           fetchImpl?: (url: string, init: object) => Promise<{ ok: boolean, status: number }> }} args
 */
export async function recordVerdict({
  eveSessionId,
  slug,
  verdict,
  confidence,
  mechanismSummary,
  missingEvidence,
  changeRecord,
  env = {},
  transport,
  fetchImpl,
}) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return degraded("config_missing", { missing: cfg.missing });

  const sessionId = String(eveSessionId ?? "").trim();
  if (!sessionId) return degraded("bad_request");

  const trimmedSlug = String(slug ?? "").trim();
  if (!trimmedSlug) return degraded("bad_request");

  if (!INVESTIGATION_VERDICTS.includes(String(verdict))) return degraded("bad_request");

  const requestBody = { eveSessionId: sessionId, slug: trimmedSlug, verdict };
  if (confidence !== undefined) requestBody.confidence = confidence;
  if (mechanismSummary !== undefined) {
    requestBody.mechanismSummary = hardenUntrusted(mechanismSummary, { maxLen: MECHANISM_SUMMARY_MAX_LEN });
  }
  if (missingEvidence !== undefined) {
    requestBody.missingEvidence = (Array.isArray(missingEvidence) ? missingEvidence : [])
      .filter((s) => typeof s === "string")
      .map((s) => hardenUntrusted(s, { maxLen: MISSING_EVIDENCE_ENTRY_MAX_LEN }));
  }
  if (changeRecord !== undefined && changeRecord !== null && typeof changeRecord === "object") {
    const recordId = String(changeRecord.recordId ?? "").trim();
    const missedCheck = String(changeRecord.missedCheck ?? "").trim();
    if (recordId && missedCheck) requestBody.changeRecord = { recordId, missedCheck };
  }

  const url = buildRecordVerdictUrl(cfg.baseUrl);

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

  if (cls.reason === "refused") {
    let body;
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    return refused(body && typeof body === "object" ? body.blocking : undefined);
  }

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

  if (!body || typeof body !== "object" || body.ok !== true) {
    return degraded("bad_body", { status });
  }

  // Fire-and-forget the Langfuse score — gated on isLangfuseConfigured, same
  // env-check three sibling modules already share (instrumentation.core.mjs).
  // `sessionId` reuses the SAME root-resolved eveSessionId this call already
  // sent — see this module's top doc-comment. `investigation_id` prefers
  // `body.investigationId` — the real wire contract today; the console
  // route always sends it now (final-review fix) — and falls back to the
  // slug only defensively (an unexpected/older response shape), always
  // coerced to a STRING. A slug is human-renamable; the uuid is not, so
  // this is a strictly better calibration join key whenever the wire
  // supplies one.
  //
  // DELIBERATELY NOT AWAITED: this tool's result is what the model waits on
  // to continue the turn, so blocking it on a Langfuse round-trip directly
  // delays the user-visible response — a slow/hanging push must never do
  // that. `pushVerdictScore`'s own promise chain already swallows every
  // failure into a single console.warn and never rejects (and is itself
  // bounded by SCORE_PUSH_TIMEOUT_MS), so a floating promise here is safe;
  // the try/catch below only guards the vanishingly unlikely SYNCHRONOUS
  // throw path (e.g. Buffer.from on a malformed key) so a Langfuse push can
  // never make recordVerdict itself throw. `fetchImpl(...)` is still called
  // synchronously inside `pushVerdictScore`, so the request IS issued before
  // this function returns — only the network round-trip itself happens
  // after.
  if (isLangfuseConfigured(env)) {
    const investigationId = String(body.investigationId ?? trimmedSlug);
    try {
      void pushVerdictScore({
        baseUrl: env.LANGFUSE_BASE_URL,
        publicKey: env.LANGFUSE_PUBLIC_KEY,
        secretKey: env.LANGFUSE_SECRET_KEY,
        fetchImpl: fetchImpl ?? fetch,
        body: {
          sessionId,
          name: "investigation_verdict",
          value: verdict,
          dataType: "CATEGORICAL",
          metadata: { investigation_id: investigationId, slug: trimmedSlug },
        },
      });
    } catch {
      // never let a Langfuse push crash the verdict result
    }
  }

  return { ok: true, rendered: renderVerdictSuccess({ verdict, slug: trimmedSlug }) };
}
