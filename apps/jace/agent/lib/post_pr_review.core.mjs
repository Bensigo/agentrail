// Pure, dependency-free core for posting an advisory PR review via the
// console (apps/console/app/api/v1/runner/pr-review, POST). No SDK, no network
// primitives of its own: the single HTTP call is an injected `transport` seam
// (real fetch with a timeout in the thin tool wrapper, a fake in tests), so
// every branch — success and every degraded outcome — is unit-testable without
// a live server.
//
// UNGATED, deliberately (was Jace's sixth console-gated write). Handing Jace a
// PR to review IS the instruction to comment on it — a second "may I post
// this?" round-trip bought nothing and, in practice, cost everything: the
// approval prompt is delivered on Telegram only
// (apps/console/app/api/v1/runner/approvals/route.ts's sendApprovalMessage),
// so on every other channel the request was recorded, never shown, and the
// tool sat polling until its 30-minute TTL expired. Observed in prod
// 2026-07-28: two `post_pr_review` approvals on a `discord` session, both
// still `pending`, review never posted, owner never prompted.
//
// What replaces the gate (BOTH still hold — the gate was never the thing
// keeping this safe):
//   1. ADVISORY BY CONSTRUCTION — the console hardcodes the GitHub review
//      `event` to "COMMENT" server-side, so nothing here can approve or
//      request changes on a PR.
//   2. SERVER-SCOPED TARGET — the console resolves the workspace from
//      `eveSessionId` through the jace_sessions ledger and requires `repo` to
//      be one the workspace has actually connected, so a model-chosen repo
//      cannot reach a repo this conversation doesn't already own.
// Plus the severity filter below, which is new: with no human reading the
// exact call, "only blockers and majors get posted" has to be ENFORCED here,
// not asked for in a prompt.
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
// `repo` / `prNumber` / `summary` / `comments` / `acCoverage` are
// model-supplied — the reviewer subagent's findings and per-AC coverage
// judgments, relayed by root verbatim. Safe without a human in the loop for
// the two structural reasons in this file's header (advisory-only event,
// server-scoped repo), plus hardenUntrusted() below.
//
// hardenUntrusted() runs over `summary` and every comment `body` before they
// ever leave this module: the reviewer's findings — and its acCoverage
// judgments, both criterion text and evidence — are shaped by reading
// UNTRUSTED diff content (root wiring's own rule — a hostile PR could try to
// seed a prompt-injection payload that rides all the way to a POSTED GITHUB
// COMMENT a human later reads), so this mirrors create_issue's own
// defense-in-depth backstop rather than trusting instructions.md alone. This
// matters MORE now than it did behind the gate — it is the only thing between
// a hostile diff and posted text, with no human reading the draft first.
// `acCoverage` is rendered into `summary` (composeSummaryWithCoverage, in
// runPostPrReview below) BEFORE that hardening runs, precisely so its text
// never skips the sanitizer.
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

// The ONLY severities that become posted inline comments. The reviewer's own
// vocabulary is blocker | major | minor | nit (REVIEW_SEVERITIES in
// agent/subagents/reviewer/lib/reviewer.core.mjs) — a PR review that
// auto-posts should carry the things worth interrupting someone for and stay
// quiet about the rest, so minor and nit are dropped here rather than left to
// the model's discretion.
export const POSTABLE_SEVERITIES = ["blocker", "major"];

// Deterministic renderers for the reviewer's acCoverage — one line per AC,
// the status phrases fixed here (never model-supplied) so the posted text
// can't drift from the diff-honest vocabulary the reviewer's contract pins.
const AC_STATUS_RENDER = {
  addressed: (c) => `- ✅ ${c.criterion}${c.evidence ? ` — ${c.evidence}` : ""}`,
  not_in_diff: (c) => `- ❌ ${c.criterion} — not visibly addressed in this diff`,
  unclear: (c) => `- ❓ ${c.criterion} — can't tell from the diff`,
};

/**
 * Render the coverage checklist: issue-numbered groups ascending, then the
 * PR-description group (issueNumber: null) last, labeled as self-stated.
 * Malformed entries are skipped, never guessed at. Returns "" when there is
 * nothing renderable.
 * @param {unknown} acCoverage
 * @returns {string}
 */
export function renderAcCoverage(acCoverage) {
  if (!Array.isArray(acCoverage) || acCoverage.length === 0) return "";
  const groups = new Map();
  for (const entry of acCoverage) {
    if (!entry || typeof entry !== "object") continue;
    const render = AC_STATUS_RENDER[entry.status];
    if (!render) continue;
    if (typeof entry.criterion !== "string" || entry.criterion.trim().length === 0) continue;
    const key = typeof entry.issueNumber === "number" ? entry.issueNumber : null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(render({
      criterion: entry.criterion.trim(),
      evidence: typeof entry.evidence === "string" ? entry.evidence.trim() : "",
    }));
  }
  if (groups.size === 0) return "";
  const issueNumbers = [...groups.keys()].filter((k) => k !== null).sort((a, b) => a - b);
  const parts = [];
  for (const n of issueNumbers) {
    parts.push(`**Acceptance criteria — issue #${n}:**\n${groups.get(n).join("\n")}`);
  }
  if (groups.has(null)) {
    parts.push(`**Acceptance criteria — from the PR description:**\n${groups.get(null).join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * Count renderable entries per status — the fold line's numbers.
 * @param {unknown} acCoverage
 */
export function coverageCounts(acCoverage) {
  const counts = { total: 0, addressed: 0, not_in_diff: 0, unclear: 0 };
  if (!Array.isArray(acCoverage)) return counts;
  for (const entry of acCoverage) {
    if (!entry || typeof entry !== "object" || !AC_STATUS_RENDER[entry.status]) continue;
    if (typeof entry.criterion !== "string" || entry.criterion.trim().length === 0) continue;
    counts.total += 1;
    counts[entry.status] += 1;
  }
  return counts;
}

/**
 * Append the coverage block under the summary. If the composed text would
 * exceed SUMMARY_MAX_LEN (so hardenUntrusted would truncate mid-checklist),
 * fold the WHOLE block to a one-line count instead — a cut-off checklist
 * reads as a complete one, which is worse than a fold that says where the
 * detail lives.
 * @param {string} summary
 * @param {unknown} acCoverage
 * @returns {string}
 */
export function composeSummaryWithCoverage(summary, acCoverage) {
  const base = String(summary ?? "");
  const block = renderAcCoverage(acCoverage);
  if (!block) return base;
  const composed = base.trim().length > 0 ? `${base}\n\n${block}` : block;
  if (composed.length <= SUMMARY_MAX_LEN) return composed;
  const c = coverageCounts(acCoverage);
  const countLine = `AC coverage: ${c.addressed}/${c.total} addressed, ${c.not_in_diff} not in diff, ${c.unclear} unclear — details in chat.`;
  return base.trim().length > 0 ? `${base}\n\n${countLine}` : countLine;
}

const REASON_MESSAGES = {
  config_missing: "the review couldn't be posted — Jace's console connection isn't configured",
  nothing_to_post:
    "nothing was posted — there were no blocker or major findings, and no summary to post on its own",
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
 * Split model-supplied comments into the ones that may be posted (severity
 * blocker or major) and a count of the ones dropped. This is the control that
 * replaced the human approval gate, so it fails CLOSED: a comment whose
 * severity is missing, null, or not one of the reviewer's four known values is
 * DROPPED, never posted. An unlabelled comment is one we cannot prove belongs
 * on someone's PR, and the cost of dropping it (a finding the owner still sees
 * in chat) is far below the cost of posting it (public noise on a PR nobody
 * approved).
 *
 * Tolerant on shape, strict on meaning: severity is trimmed and lowercased
 * before matching, so "  BLOCKER " counts, but "critical" does not.
 *
 * @param {unknown} comments
 * @returns {{ postable: Array<{path?: unknown, line?: unknown, body?: unknown}>, dropped: number }}
 */
export function filterPostableComments(comments) {
  const list = Array.isArray(comments) ? comments : [];
  const postable = [];
  let dropped = 0;
  for (const c of list) {
    const severity = String((c && c.severity) ?? "")
      .trim()
      .toLowerCase();
    if (POSTABLE_SEVERITIES.includes(severity)) {
      postable.push(c);
    } else {
      dropped += 1;
    }
  }
  return { postable, dropped };
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
 *   3. nothing left after the severity
 *      filter AND a blank summary        -> failure("nothing_to_post")
 *   4. transport throws                  -> failure("unreachable")
 *   5. non-2xx status                    -> failure(<mapped reason>,
 *                                            <console's own error message,
 *                                            when present>)
 *   6. non-JSON / malformed 2xx body     -> failure("bad_body")
 *   7. success                           -> { ok: true, reviewUrl, summary,
 *                                            inlineCommentsPosted,
 *                                            foldedComments, droppedComments }
 *
 * `acCoverage` (default null): the reviewer's per-AC coverage judgments,
 * relayed by root verbatim — reviewer-relayed, untrusted-derived input, same
 * provenance as `summary`/`comments` (see the module header). Rendered into
 * `summary` by `composeSummaryWithCoverage` BEFORE this function's call to
 * `sanitizeReviewInput` hardens it, so it is never posted unhardened.
 * Omitted or null leaves the posted body byte-identical to a call that never
 * knew about coverage at all.
 *
 * @param {{ eveSessionId: string, repo: string, prNumber: number,
 *           summary: string, comments: Array<{path: string, line: number, body: string}>,
 *           acCoverage?: unknown,
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
  acCoverage = null,
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

  // Severity filter FIRST, then sanitize: only what we're actually posting
  // needs hardening, and sanitizeReviewInput's own output shape
  // ({path, line, body}) is what drops `severity` before it reaches the
  // console — it is an internal control, not part of that contract. The
  // acCoverage checklist joins the summary HERE, before sanitizeReviewInput's
  // hardenUntrusted() call, so criterion/evidence text (untrusted-derived,
  // same as summary/comments) rides the same sanitizer as everything else
  // rather than reaching GitHub unhardened.
  const { postable, dropped } = filterPostableComments(comments);
  const safe = sanitizeReviewInput(composeSummaryWithCoverage(summary, acCoverage), postable);

  // Nothing worth posting and nothing to say: report it honestly rather than
  // spending a call the console would 400 anyway.
  if (safe.summary.trim().length === 0 && safe.comments.length === 0) {
    return failure("nothing_to_post");
  }

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
    // How many findings were withheld for being below `major`, so root can say
    // so plainly in chat instead of implying the whole review landed.
    droppedComments: dropped,
  };
}
