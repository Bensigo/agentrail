// Pure, dependency-free core for posting an advisory PR review via the
// console (apps/console/app/api/v1/runner/pr-review, POST) — Jace's SIXTH
// gated write action on the outside world, alongside create_issue,
// create_workspace, create_repo, update_issue, and create_goal (see
// agent/tools/post_pr_review.ts's doc-comment for why this carries the same
// console-gated approval). No SDK, no network primitives of its own: the
// single HTTP call is an injected `transport` seam (real fetch with a timeout
// in the thin tool wrapper, a fake in tests), so every branch — success and
// every degraded outcome — is unit-testable without a live server.
//
// Auth + config model: same as the sibling *.core.mjs modules — Jace resolves
// its own console endpoint + bearer from JACE_CONSOLE_BASE_URL /
// JACE_CONSOLE_TOKEN, never the runner's ~/.agentrail/credentials.json.
//
// `eveSessionId` is resolved by the tool wrapper from `ctx.session.id`. This
// is a ROOT tool (unlike the reviewer subagent's fetch_pr_diff), so
// `ctx.session.id` already IS the top-level session the jace_sessions ledger
// anchors — no `session.parent` indirection needed here, unlike
// fetch_pr_diff.core.mjs, which runs inside a declared subagent's own child
// session (see that module's doc-comment).
//
// `repo` / `prNumber` / `summary` / `comments` are model-supplied — the
// reviewer subagent's findings, relayed and approved in chat. That's safe
// because a human approves the EXACT call (console-gated approval) before
// this ever runs, same as every other gated tool.
//
// hardenUntrusted() runs over `summary` and every comment `body` before they
// ever leave this module: the reviewer's findings are shaped by reading
// UNTRUSTED diff content (root wiring's own rule — a hostile PR could try to
// seed a prompt-injection payload that rides all the way to a POSTED GITHUB
// COMMENT a human later reads), so this mirrors create_issue's own
// defense-in-depth backstop rather than trusting instructions.md alone.
//
// Failure posture: every non-2xx status is mapped to a stable `reason` + a
// relayable `message` — the console's OWN honest error text when the body
// carries one (same reasoning as create_repo.core.mjs: a human already
// approved this specific call, so there is no anti-enumeration reason to
// hide which refusal happened), falling back to a generic per-reason message
// otherwise. Never throws, never retries (the console owns the GitHub-side
// 422-fold-and-retry internally).

import { hardenUntrusted } from "./sanitize-untrusted.core.mjs";

export const PR_REVIEW_PATH = "/api/v1/runner/pr-review";

// Backstops against context flooding, not content limits — mirrors
// sanitize-untrusted.core.mjs's FIELD_CAPS idiom for create_issue's fields.
export const SUMMARY_MAX_LEN = 8000;
export const COMMENT_BODY_MAX_LEN = 2000;

const REASON_MESSAGES = {
  config_missing: "the review couldn't be posted — Jace's console connection isn't configured",
  bad_request: "the review couldn't be posted — the request was malformed",
  unauthorized: "the review couldn't be posted — the console rejected the request",
  not_found: "the review couldn't be posted — this PR or repo isn't reachable from this workspace",
  conflict: "the review couldn't be posted — the workspace or repo isn't fully connected yet",
  unprocessable: "the review couldn't be posted — GitHub rejected it as unprocessable",
  rate_limited: "the review couldn't be posted — GitHub's rate limit was hit, try again shortly",
  upstream_error: "the review couldn't be posted — GitHub or the console had an error",
  unreachable: "the review couldn't be posted — the console could not be reached",
  unexpected_status: "the review couldn't be posted — the console returned an unexpected response",
  bad_body: "the review couldn't be posted — the console's response could not be read",
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
 * Build the POST .../pr-review URL. Every field rides in the body, never
 * here — there is nothing to encode into the URL itself.
 * @param {string} baseUrl — already trimmed + de-slashed
 * @returns {string}
 */
export function buildPrReviewUrl(baseUrl) {
  return `${baseUrl}${PR_REVIEW_PATH}`;
}

/**
 * Map an HTTP status to an outcome. 2xx -> ok; everything else -> a specific
 * degraded reason. No status triggers a retry from here — the console
 * already owns the one GitHub-side 422-fold-and-retry.
 * @param {number} status
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 400) return { ok: false, reason: "bad_request" };
  if (status === 401 || status === 403) return { ok: false, reason: "unauthorized" };
  if (status === 404) return { ok: false, reason: "not_found" };
  if (status === 409) return { ok: false, reason: "conflict" };
  if (status === 422) return { ok: false, reason: "unprocessable" };
  if (status === 429) return { ok: false, reason: "rate_limited" };
  if (status >= 500) return { ok: false, reason: "upstream_error" };
  return { ok: false, reason: "unexpected_status" };
}

/**
 * Build a structured failure result. Carries a stable `reason` + a
 * relayable `message` — never a raw error, a status code, or a bearer
 * token.
 * @param {string} reason
 * @param {string} [message]
 * @returns {{ ok: false, reason: string, message: string }}
 */
export function failure(reason, message) {
  return {
    ok: false,
    reason,
    message: message || REASON_MESSAGES[reason] || REASON_MESSAGES.unexpected_status,
  };
}

/**
 * Sanitize the model-supplied summary + comments through hardenUntrusted()
 * before they ever leave this module — the same backstop create_issue's
 * write path applies, since the reviewer's findings are shaped by untrusted
 * diff content.
 * @param {string} summary
 * @param {Array<{path?: unknown, line?: unknown, body?: unknown}>} comments
 * @returns {{ summary: string, comments: Array<{path: string, line: number, body: string}> }}
 */
export function sanitizeReviewInput(summary, comments) {
  const safeSummary = hardenUntrusted(summary ?? "", { maxLen: SUMMARY_MAX_LEN });
  const list = Array.isArray(comments) ? comments : [];
  const safeComments = list.map((c) => ({
    path: String((c && c.path) ?? "").trim(),
    line: Number(c && c.line),
    body: hardenUntrusted((c && c.body) ?? "", { maxLen: COMMENT_BODY_MAX_LEN }),
  }));
  return { summary: safeSummary, comments: safeComments };
}

/**
 * Post an advisory PR review for the conversation identified by
 * `eveSessionId`. Returns `{ ok: true, reviewUrl, summary,
 * inlineCommentsPosted, foldedComments }` on success, or a structured
 * `{ ok: false, reason, message }` otherwise — never throws, never retries
 * (single attempt; the console owns the GitHub-side 422 retry internally).
 *
 *   1. unset console config              -> failure("config_missing")
 *   2. blank eveSessionId/repo, or a
 *      non-positive-integer prNumber     -> failure("bad_request")
 *   3. transport throws                  -> failure("unreachable")
 *   4. non-2xx status                    -> failure(<mapped reason>,
 *                                            <console's own error message,
 *                                            when present>)
 *   5. non-JSON / malformed 2xx body     -> failure("bad_body")
 *   6. success                           -> { ok: true, reviewUrl, summary,
 *                                            inlineCommentsPosted,
 *                                            foldedComments }
 *
 * @param {{ eveSessionId: string, repo: string, prNumber: number,
 *           summary: string, comments: Array<{path: string, line: number, body: string}>,
 *           env?: Record<string, string|undefined>,
 *           transport: (url: string, init: { method: string, headers: Record<string,string>, body: string }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }> }} args
 */
export async function runPostPrReview({
  eveSessionId,
  repo,
  prNumber,
  summary,
  comments,
  env = {},
  transport,
}) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return failure("config_missing");

  const sessionId = String(eveSessionId ?? "").trim();
  const repoTrimmed = String(repo ?? "").trim();
  const prNum = Number(prNumber);
  if (!sessionId || !repoTrimmed || !Number.isInteger(prNum) || prNum <= 0) {
    return failure("bad_request");
  }

  const safe = sanitizeReviewInput(summary, comments);
  const url = buildPrReviewUrl(cfg.baseUrl);
  const requestBody = {
    eveSessionId: sessionId,
    repo: repoTrimmed,
    prNumber: prNum,
    summary: safe.summary,
    comments: safe.comments,
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
      body && typeof body === "object" && typeof body.error === "string" && body.error
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

  if (!body || typeof body !== "object" || body.posted !== true) {
    return failure("bad_body");
  }

  return {
    ok: true,
    reviewUrl: typeof body.reviewUrl === "string" ? body.reviewUrl : null,
    summary: typeof body.summary === "string" ? body.summary : safe.summary,
    inlineCommentsPosted:
      typeof body.inlineCommentsPosted === "number" ? body.inlineCommentsPosted : 0,
    foldedComments: Array.isArray(body.foldedComments) ? body.foldedComments : [],
  };
}
