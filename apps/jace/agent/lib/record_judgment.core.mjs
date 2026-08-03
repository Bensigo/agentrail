// Pure, dependency-injected core for Jace's chat/grilling learning seam:
// POST /api/v1/runner/judgment-events. This writes only the two
// chat-originated judgment event types this producer owns:
//   - rejected_approach
//   - requirement_correction
//
// Trusted review_outcome / false_green / missed_check producers deliberately
// live on their existing console routes. This module never sends actor/source
// refs; the console route owns those refs after resolving the Eve session's
// workspace.

import { createHash } from "node:crypto";
import { hardenUntrusted } from "./sanitize-untrusted.core.mjs";

export const RECORD_JUDGMENT_PATH = "/api/v1/runner/judgment-events";
export const JUDGMENT_EVENT_TYPES = Object.freeze(["rejected_approach", "requirement_correction"]);

const REASON_MAX_LEN = 1200;
const CORRECTION_MAX_LEN = 2000;
const TERM_MAX_LEN = 160;
const MAX_BLOCKED_TERMS = 20;
const REF_MAX_LEN = 160;

const DEGRADED_NOTES = {
  config_missing:
    "The console judgment-events endpoint is not configured for this Jace deployment (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); no judgment event was recorded.",
  bad_request:
    "The judgment event request was malformed or missing required chat context; no judgment event was recorded.",
  unreachable:
    "The console judgment-events endpoint could not be reached; no judgment event was recorded. Do not retry blindly.",
  unauthorized:
    "The console rejected the console token (JACE_CONSOLE_TOKEN) with 401/403; no judgment event was recorded.",
  not_found:
    "The Eve session or repository could not be resolved in this workspace; no judgment event was recorded.",
  conflict:
    "The judgment event already exists; no duplicate row was recorded.",
  upstream_error: "The console's backing store errored; no judgment event was recorded.",
  unexpected_status: "The console returned an unexpected status; no judgment event was recorded.",
  bad_body:
    "The console responded, but the body did not confirm the judgment event result; treat it as unrecorded.",
};

export function resolveConsoleConfig(env = {}) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  const missing = [];
  if (!baseUrl) missing.push("JACE_CONSOLE_BASE_URL");
  if (!token) missing.push("JACE_CONSOLE_TOKEN");
  if (missing.length) return { ok: false, missing };
  return { ok: true, baseUrl, token };
}

export function buildRecordJudgmentUrl(baseUrl) {
  return `${baseUrl}${RECORD_JUDGMENT_PATH}`;
}

export function classifyStatus(status) {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 400) return { ok: false, reason: "bad_request" };
  if (status === 401 || status === 403) return { ok: false, reason: "unauthorized" };
  if (status === 404) return { ok: false, reason: "not_found" };
  if (status === 409) return { ok: false, reason: "conflict" };
  if (status >= 500) return { ok: false, reason: "upstream_error" };
  return { ok: false, reason: "unexpected_status" };
}

export function degraded(reason, extra = {}) {
  return {
    ok: false,
    degraded: true,
    reason,
    note: DEGRADED_NOTES[reason] ?? DEGRADED_NOTES.unexpected_status,
    rendered: `Judgment event not recorded: ${DEGRADED_NOTES[reason] ?? DEGRADED_NOTES.unexpected_status}`,
    ...extra,
  };
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function cleanText(value, maxLen) {
  return hardenUntrusted(value, { maxLen }).trim();
}

function cleanOptionalRef(value) {
  const text = cleanText(value, REF_MAX_LEN);
  return text || undefined;
}

function buildRefs({ briefSlug, itemId, sourceTurnId, issueNumber, prNumber, headSha } = {}) {
  const refs = {};
  const cleanBriefSlug = cleanOptionalRef(briefSlug);
  const cleanItemId = cleanOptionalRef(itemId);
  const cleanSourceTurnId = cleanOptionalRef(sourceTurnId);
  if (cleanBriefSlug) refs.briefSlug = cleanBriefSlug;
  if (cleanItemId) refs.itemId = cleanItemId;
  if (cleanSourceTurnId) refs.sourceTurnId = cleanSourceTurnId;
  if (Number.isSafeInteger(issueNumber) && issueNumber > 0) refs.issueNumber = issueNumber;
  if (Number.isSafeInteger(prNumber) && prNumber > 0) refs.prNumber = prNumber;
  const cleanHeadSha = cleanOptionalRef(headSha);
  if (cleanHeadSha) refs.headSha = cleanHeadSha;
  return refs;
}

function uniqueCleanTerms(blockedTerms) {
  const seen = new Set();
  const terms = [];
  for (const term of Array.isArray(blockedTerms) ? blockedTerms : []) {
    const clean = cleanText(term, TERM_MAX_LEN);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    terms.push(clean);
    if (terms.length >= MAX_BLOCKED_TERMS) break;
  }
  return terms;
}

function eventKeyFor({ type, repo, reason, blockedTerms, correction, refs }) {
  const hash = createHash("sha256")
    .update(JSON.stringify({ type, repo, reason, blockedTerms, correction, refs }))
    .digest("hex")
    .slice(0, 24);
  return `${type}:${hash}`;
}

export function buildJudgmentEventBody({
  eveSessionId,
  repo,
  type,
  reason,
  blockedTerms,
  correction,
  briefSlug,
  itemId,
  sourceTurnId,
  issueNumber,
  prNumber,
  headSha,
}) {
  const sessionId = String(eveSessionId ?? "").trim();
  const resolvedRepo = cleanText(repo, 200);
  const resolvedType = String(type ?? "").trim();
  if (!sessionId || !resolvedRepo || !JUDGMENT_EVENT_TYPES.includes(resolvedType)) {
    return { ok: false, reason: "bad_request" };
  }

  const cleanedReason = cleanText(reason, REASON_MAX_LEN);
  if (!cleanedReason) return { ok: false, reason: "bad_request" };

  const refs = buildRefs({ briefSlug, itemId, sourceTurnId, issueNumber, prNumber, headSha });
  if (resolvedType === "rejected_approach") {
    const terms = uniqueCleanTerms(blockedTerms);
    if (terms.length === 0) return { ok: false, reason: "bad_request" };
    const payload = { blockedTerms: terms, reason: cleanedReason };
    return {
      ok: true,
      body: {
        eveSessionId: sessionId,
        repo: resolvedRepo,
        eventKey: eventKeyFor({ type: resolvedType, repo: resolvedRepo, reason: cleanedReason, blockedTerms: terms, refs }),
        type: resolvedType,
        refs,
        payload,
      },
    };
  }

  const cleanedCorrection = cleanText(correction, CORRECTION_MAX_LEN);
  const payload = { reason: cleanedReason, ...(cleanedCorrection ? { correction: cleanedCorrection } : {}) };
  return {
    ok: true,
    body: {
      eveSessionId: sessionId,
      repo: resolvedRepo,
      eventKey: eventKeyFor({ type: resolvedType, repo: resolvedRepo, reason: cleanedReason, correction: cleanedCorrection, refs }),
      type: resolvedType,
      refs,
      payload,
    },
  };
}

export function renderJudgmentSuccess({ type, inserted }) {
  const verb = inserted === false ? "already recorded" : "recorded";
  return `Judgment event ${verb}: ${type}.`;
}

export async function recordJudgment({
  eveSessionId,
  repo,
  type,
  reason,
  blockedTerms,
  correction,
  briefSlug,
  itemId,
  sourceTurnId,
  issueNumber,
  prNumber,
  headSha,
  env = {},
  transport,
}) {
  try {
    const cfg = resolveConsoleConfig(env);
    if (!cfg.ok) return degraded("config_missing", { missing: cfg.missing });
    if (typeof transport !== "function") return degraded("bad_request");

    const built = buildJudgmentEventBody({
      eveSessionId,
      repo,
      type,
      reason,
      blockedTerms,
      correction,
      briefSlug,
      itemId,
      sourceTurnId,
      issueNumber,
      prNumber,
      headSha,
    });
    if (!built.ok) return degraded(built.reason);

    let res;
    try {
      res = await transport(buildRecordJudgmentUrl(cfg.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(built.body),
      });
    } catch {
      return degraded("unreachable");
    }

    const status = Number(res && res.status);
    const cls = classifyStatus(status);
    if (!cls.ok && cls.reason === "conflict") {
      return {
        ok: true,
        inserted: false,
        rendered: renderJudgmentSuccess({ type: built.body.type, inserted: false }),
      };
    }
    if (!cls.ok) return degraded(cls.reason, { status });

    let responseBody;
    try {
      responseBody = await res.json();
    } catch {
      return degraded("bad_body", { status });
    }
    if (!responseBody || typeof responseBody !== "object" || responseBody.ok !== true) {
      return degraded("bad_body", { status });
    }

    const inserted = responseBody.inserted !== false;
    return {
      ok: true,
      inserted,
      event: responseBody.event,
      rendered: renderJudgmentSuccess({ type: built.body.type, inserted }),
    };
  } catch {
    return degraded("unexpected_status");
  }
}
