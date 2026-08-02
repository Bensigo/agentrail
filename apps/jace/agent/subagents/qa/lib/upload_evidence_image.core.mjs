// Pure, dependency-free core for uploading ONE captured screenshot as per-AC
// evidence via the console (apps/console/app/api/v1/runner/review-evidence,
// POST — Task 2, merged). No SDK, no network primitives of its own: the
// single HTTP call is an injected `transport` seam (real fetch with a
// timeout in the thin tool wrapper, a fake in tests), so every branch —
// success and every failure — is unit-testable without a live console.
//
// Design: docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md
// §2 (B2a). QA's upload seam: it takes bytes QA already captured with an
// already-allowlisted browser screenshot tool (agent_browser_screenshot /
// browser_screenshot — lib/connections.core.mjs) and stores them so the
// posted review can link them from an ac_result's `evidence_images`
// (qa.core.mjs's QA_SCHEMA).
//
// Structurally this mirrors post_pr_review.core.mjs (POST, duplicated
// resolveConsoleConfig, a classifyStatus status-code table, relay the
// console's own {error} text when the body carries one, generic per-reason
// fallback otherwise, never throws, never retries) rather than the reviewer
// subagent's GET-only context tools (read_repo_file.core.mjs and siblings):
// this is a write, not a read, and the console route it calls returns
// status codes (413/415/422/503) none of the GET tools' routes use.
//
// CONTRACT IS DELIBERATELY FLATTER than either precedent's `{ok, ...}`
// union: success is exactly `{ url, key }`; anything else is exactly
// `{ error: string }` — never throws, never a discriminant field to branch
// on. The QA model relays `error` verbatim in its own prose (an ac_result's
// `evidence`, or a finding's `observed`), so each message is written as a
// complete, self-contained sentence a reader can act on without also having
// this file open.
//
// Auth + config model: same as every sibling *.core.mjs module in this app —
// Jace resolves its own console endpoint + bearer from JACE_CONSOLE_BASE_URL
// / JACE_CONSOLE_TOKEN.
//
// `eveSessionId` is resolved by the tool wrapper via
// `ctx.session.parent?.rootSessionId ?? ctx.session.id` — this runs inside
// the `qa` DECLARED SUBAGENT, which eve gives its own CHILD session, exactly
// like the reviewer subagent's context tools (see read_repo_file.ts's own
// doc-comment for the full reasoning). This core stays agnostic to how that
// id was resolved — it just relays whatever string it's given.
//
// `repo` / `prNumber` / `headSha` are CALLER-SUPPLIED, not discovered here:
// root's task prompt to QA carries the PR under test, and QA relays those
// coordinates verbatim as this tool's own arguments (same provenance as the
// reviewer's fetch_pr_diff `repo`/`prNumber`). The console route is what
// actually enforces that `repo` is one the calling workspace has connected
// (`getRepositoryByName`) — this core does not (and cannot) independently
// verify the coordinates name the PR actually under test.
//
// VALIDATION SPLIT (deliberate): this core validates only PRESENCE/TYPE of
// its own required fields client-side (cheap, before the heavier work,
// mirroring runPostPrReview's own "blank eveSessionId/repo, or a
// non-positive-integer prNumber -> bad_request" guard) — never a BUSINESS
// RULE the console itself owns and could change independently: the
// image/png|image/jpeg allowlist (415), the 2MB size cap (413), and the
// index's 1..4 range (422) are all left to the console's own response,
// relayed via the {error} contract above. Duplicating those numbers here
// would be a second copy of a rule that already lives in exactly one place
// (apps/console/app/api/v1/runner/review-evidence/route.ts) and could drift.
export const REVIEW_EVIDENCE_PATH = "/api/v1/runner/review-evidence";

const REASON_MESSAGES = {
  config_missing:
    "the screenshot could not be uploaded as evidence — Jace's console connection isn't configured",
  bad_request:
    "the screenshot could not be uploaded as evidence — the upload request was malformed",
  unauthorized:
    "the screenshot could not be uploaded as evidence — the console rejected the request",
  not_found:
    "the screenshot could not be uploaded as evidence — this session or repo isn't reachable from this workspace",
  conflict:
    "the screenshot could not be uploaded as evidence — the workspace isn't fully connected yet",
  unsupported_content_type:
    "the screenshot could not be uploaded as evidence — only image/png or image/jpeg are accepted",
  too_large:
    "the screenshot could not be uploaded as evidence — the image exceeds the 2MB size cap",
  out_of_range:
    "the screenshot could not be uploaded as evidence — too many images already captured for this AC (max 4)",
  disabled:
    "the screenshot could not be uploaded as evidence — evidence storage is not enabled for this deployment",
  rate_limited:
    "the screenshot could not be uploaded as evidence — the console's rate limit was hit, try again shortly",
  upstream_error:
    "the screenshot could not be uploaded as evidence — the console had an error storing it",
  unreachable:
    "the screenshot could not be uploaded as evidence — the console could not be reached",
  unexpected_status:
    "the screenshot could not be uploaded as evidence — the console returned an unexpected response",
  bad_body:
    "the screenshot could not be uploaded as evidence — the console's response could not be read",
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
 * Build the POST .../review-evidence URL. Every field rides in the body,
 * never here — there is nothing to encode into the URL itself.
 * @param {string} baseUrl — already trimmed + de-slashed
 * @returns {string}
 */
export function buildReviewEvidenceUrl(baseUrl) {
  return `${baseUrl}${REVIEW_EVIDENCE_PATH}`;
}

/**
 * Map an HTTP status to an outcome. 2xx -> ok; everything else -> a specific
 * failure reason. No status triggers a retry from here — a single failed
 * attempt is reported, not re-attempted.
 * @param {number} status
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 400) return { ok: false, reason: "bad_request" };
  if (status === 401 || status === 403) return { ok: false, reason: "unauthorized" };
  if (status === 404) return { ok: false, reason: "not_found" };
  if (status === 409) return { ok: false, reason: "conflict" };
  if (status === 413) return { ok: false, reason: "too_large" };
  if (status === 415) return { ok: false, reason: "unsupported_content_type" };
  if (status === 422) return { ok: false, reason: "out_of_range" };
  if (status === 429) return { ok: false, reason: "rate_limited" };
  if (status === 503) return { ok: false, reason: "disabled" };
  if (status >= 500) return { ok: false, reason: "upstream_error" };
  return { ok: false, reason: "unexpected_status" };
}

/**
 * Build the structured failure result. Prefers the console's OWN honest
 * error text when one was actually given (same reasoning as
 * post_pr_review.core.mjs / create_repo.core.mjs: this is a narrowly-scoped,
 * non-secret operator-facing message, e.g. "index must be an integer between
 * 1 and 4" — relaying it is strictly more useful to the QA model than a
 * generic fallback), falling back to a fixed, generic per-reason message
 * otherwise. Never carries a status code, a raw thrown error, or the bearer
 * token.
 * @param {string} reason
 * @param {string} [consoleMessage]
 * @returns {{ error: string }}
 */
export function failure(reason, consoleMessage) {
  const trimmed = typeof consoleMessage === "string" ? consoleMessage.trim() : "";
  return { error: trimmed || REASON_MESSAGES[reason] || REASON_MESSAGES.unexpected_status };
}

/**
 * Upload one evidence screenshot for one acceptance criterion. Returns
 * `{ url, key }` on success, or `{ error: string }` otherwise — never
 * throws, never retries (single attempt).
 *
 *   1. unset console config                       -> failure("config_missing")
 *   2. a blank required string field, or a
 *      non-positive-integer prNumber, or a
 *      non-finite index                           -> failure("bad_request")
 *   3. transport throws                            -> failure("unreachable")
 *   4. non-2xx status                               -> failure(<mapped reason>,
 *                                                      <console's own {error}
 *                                                      text, when present>)
 *   5. non-JSON / malformed 2xx body                -> failure("bad_body")
 *   6. success                                      -> { url, key }
 *
 * `index`'s 1..4 range is deliberately NOT checked here — see this module's
 * header (VALIDATION SPLIT). Only its presence and that it is a finite
 * number are checked client-side; an out-of-range value reaches the
 * console and comes back as a relayed 422 via step 4.
 *
 * @param {{ env?: Record<string, string|undefined>, eveSessionId: string,
 *           repo: string, prNumber: number, headSha: string, acId: string,
 *           index: number, imageBase64: string, contentType: string,
 *           transport: (url: string, init: { method: string, headers: Record<string,string>, body: string }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }> }} args
 * @returns {Promise<{ url: string, key: string } | { error: string }>}
 */
export async function runUploadEvidenceImage({
  env = {},
  eveSessionId,
  repo,
  prNumber,
  headSha,
  acId,
  index,
  imageBase64,
  contentType,
  transport,
}) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return failure("config_missing");

  const sessionId = String(eveSessionId ?? "").trim();
  const repoTrimmed = String(repo ?? "").trim();
  const headShaTrimmed = String(headSha ?? "").trim();
  const acIdTrimmed = String(acId ?? "").trim();
  const contentTypeTrimmed = String(contentType ?? "").trim();
  const imageBase64Trimmed = String(imageBase64 ?? "").trim();
  const prNum = Number(prNumber);
  const idx = Number(index);

  if (
    !sessionId ||
    !repoTrimmed ||
    !headShaTrimmed ||
    !acIdTrimmed ||
    !contentTypeTrimmed ||
    !imageBase64Trimmed ||
    !Number.isInteger(prNum) ||
    prNum <= 0 ||
    // `index === undefined/null` is checked explicitly (not just via
    // Number.isFinite) because Number(null) === 0 — a genuinely finite
    // number — which would otherwise let a caller that forgot `index`
    // entirely silently become "index 0" on the wire instead of a
    // bad_request. prNumber doesn't need the same explicit guard: its own
    // `prNum <= 0` floor already rejects Number(null) === 0 and
    // Number(undefined) === NaN alike.
    index === undefined ||
    index === null ||
    !Number.isFinite(idx)
  ) {
    return failure("bad_request");
  }

  const url = buildReviewEvidenceUrl(cfg.baseUrl);
  const requestBody = {
    eveSessionId: sessionId,
    repo: repoTrimmed,
    prNumber: prNum,
    headSha: headShaTrimmed,
    acId: acIdTrimmed,
    index: idx,
    imageBase64: imageBase64Trimmed,
    contentType: contentTypeTrimmed,
  };

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
    // Network error / DNS / timeout — a single failed attempt, reported not retried.
    return failure("unreachable");
  }

  const status = Number(res && res.status);
  const cls = classifyStatus(status);

  if (!cls.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
      return failure(cls.reason);
    }
    const consoleMessage =
      body && typeof body === "object" && typeof body.error === "string" && body.error.trim()
        ? body.error
        : undefined;
    return failure(cls.reason, consoleMessage);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return failure("bad_body");
  }

  if (
    !body ||
    typeof body !== "object" ||
    typeof body.url !== "string" ||
    !body.url ||
    typeof body.key !== "string" ||
    !body.key
  ) {
    return failure("bad_body");
  }

  return { url: body.url, key: body.key };
}
