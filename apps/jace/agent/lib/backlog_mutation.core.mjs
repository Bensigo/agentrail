// Pure, dependency-free core for APPLYING an already-approved backlog mutation
// via the console (apps/console/app/api/v1/runner/backlog/mutate, POST) — the
// shared apply path behind Jace's THREE gated grooming tools (backlog_label,
// backlog_close, backlog_dedupe), issue #1291. No SDK, no network primitives
// of its own: the single HTTP call is an injected `transport` seam (real fetch
// with a timeout in each thin tool wrapper, a fake in tests), so every branch —
// success and every degraded outcome — is unit-testable without a live server.
//
// SAFETY LINE (binding): this core is only ever reached AFTER Eve's
// consoleGatedApproval has resolved "approved" for the exact mutation — every
// one of the three tools wires `approval: (ctx) => consoleGatedApproval(ctx)`.
// This module performs the write only; it never itself decides approval, and
// there is no code path that mutates the tracker without an approved decision.
// On deny/timeout the tool's `execute` never runs, so this core is never
// called. It also never throws and never retries.
//
// NOT the run-failure "triage" (FAILURE DIAGNOSIS). This is BACKLOG GROOMING —
// a distinct name and write path.
//
// Auth + config model: same as the sibling *.core.mjs modules — Jace resolves
// its own console endpoint + bearer from JACE_CONSOLE_BASE_URL /
// JACE_CONSOLE_TOKEN. `eveSessionId` is resolved by each tool wrapper from
// `ctx.session.id` (root tools, so ctx.session.id already IS the top-level
// session the jace_sessions ledger anchors — no subagent parent indirection).
//
// hardenUntrusted() runs over the model-supplied `comment` before it leaves
// this module: the comment can be shaped from untrusted issue-body content the
// grooming read over, and it lands as a GitHub comment a human reads — same
// defense-in-depth backstop create_issue/post_pr_review apply.

import { hardenUntrusted } from "./sanitize-untrusted.core.mjs";

export const BACKLOG_MUTATE_PATH = "/api/v1/runner/backlog/mutate";

export const ACTIONS = ["add_labels", "remove_labels", "close", "dedupe"];
export const STATE_REASONS = ["completed", "not_planned"];

const COMMENT_MAX_LEN = 4000;
const LABEL_MAX_LEN = 100;
const MAX_LABELS = 20;

const REASON_MESSAGES = {
  config_missing: "the mutation couldn't be applied — Jace's console connection isn't configured",
  bad_request: "the mutation couldn't be applied — the request was malformed",
  unauthorized: "the mutation couldn't be applied — the console rejected the request",
  not_found: "the mutation couldn't be applied — the issue or repo isn't reachable from this workspace",
  conflict: "the mutation couldn't be applied — the workspace or repo isn't fully connected yet",
  unprocessable: "the mutation couldn't be applied — GitHub rejected it as unprocessable",
  rate_limited: "the mutation couldn't be applied — GitHub's rate limit was hit, try again shortly",
  upstream_error: "the mutation couldn't be applied — GitHub or the console had an error",
  unreachable: "the mutation couldn't be applied — the console could not be reached",
  unexpected_status: "the mutation couldn't be applied — the console returned an unexpected response",
  bad_body: "the mutation couldn't be applied — the console's response could not be read",
};

/**
 * Resolve the console endpoint + bearer from the environment. Trims both,
 * strips a trailing slash from the base URL, and reports which var(s) are
 * missing. Deliberately duplicated verbatim from the sibling *.core.mjs
 * modules rather than shared: each core module here is pure and dependency-free
 * of the others by design.
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

/** Build the POST .../backlog/mutate URL. Every field rides in the body. */
export function buildMutateUrl(baseUrl) {
  return `${baseUrl}${BACKLOG_MUTATE_PATH}`;
}

/**
 * Map an HTTP status to an outcome. 2xx -> ok; everything else -> a specific
 * degraded reason. No status triggers a retry.
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
 * Build a structured failure result. Carries a stable `reason` + a relayable
 * `message` — never a raw error, a status code, or a bearer token.
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
 * Validate + normalize the mutation input into the wire body the console
 * expects, or `null` when it is malformed (the caller maps that to
 * failure("bad_request")). Applies hardenUntrusted() to the comment. Pure.
 *
 * @param {{ action: string, repo: string, issueNumber: number, labels?: string[],
 *           comment?: string, stateReason?: string, canonicalIssue?: number }} input
 * @returns {Record<string, unknown> | null}
 */
export function buildMutationBody(input) {
  const action = String(input && input.action ? input.action : "").trim();
  if (!ACTIONS.includes(action)) return null;

  const repo = String(input && input.repo ? input.repo : "").trim();
  const issueNumber = Number(input && input.issueNumber);
  if (!repo || !Number.isInteger(issueNumber) || issueNumber <= 0) return null;

  const body = { action, repo, issueNumber };

  if (action === "add_labels" || action === "remove_labels") {
    const raw = Array.isArray(input.labels) ? input.labels : [];
    const labels = raw
      .map((l) => String(l ?? "").trim())
      .filter((l) => l.length > 0 && l.length <= LABEL_MAX_LEN)
      .slice(0, MAX_LABELS);
    if (labels.length === 0) return null;
    body.labels = labels;
  }

  if (action === "close") {
    if (input.stateReason !== undefined && input.stateReason !== null) {
      const reason = String(input.stateReason).trim();
      if (!STATE_REASONS.includes(reason)) return null;
      body.stateReason = reason;
    }
    if (input.comment !== undefined && input.comment !== null && String(input.comment).trim()) {
      body.comment = hardenUntrusted(String(input.comment), { maxLen: COMMENT_MAX_LEN });
    }
  }

  if (action === "dedupe") {
    const canonical = Number(input.canonicalIssue);
    if (!Number.isInteger(canonical) || canonical <= 0 || canonical === issueNumber) return null;
    body.canonicalIssue = canonical;
    if (input.comment !== undefined && input.comment !== null && String(input.comment).trim()) {
      body.comment = hardenUntrusted(String(input.comment), { maxLen: COMMENT_MAX_LEN });
    }
  }

  return body;
}

/**
 * Apply ONE already-approved backlog mutation. Returns `{ ok: true, ...console
 * body }` on success, or a structured `{ ok: false, reason, message }`
 * otherwise — never throws, never retries.
 *
 *   1. unset console config        -> failure("config_missing")
 *   2. blank eveSessionId, or a
 *      malformed action/input       -> failure("bad_request")
 *   3. transport throws            -> failure("unreachable")
 *   4. non-2xx status              -> failure(<mapped reason>, <console's own
 *                                       error message when present>)
 *   5. non-JSON / malformed 2xx    -> failure("bad_body")
 *   6. success                     -> { ok: true, ...applied fields }
 *
 * @param {{ eveSessionId: string, action: string, repo: string, issueNumber: number,
 *           labels?: string[], comment?: string, stateReason?: string,
 *           canonicalIssue?: number, env?: Record<string, string|undefined>,
 *           transport: (url: string, init: { method: string, headers: Record<string,string>, body: string }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }> }} args
 */
export async function runBacklogMutation({
  eveSessionId,
  action,
  repo,
  issueNumber,
  labels,
  comment,
  stateReason,
  canonicalIssue,
  env = {},
  transport,
}) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return failure("config_missing");

  const sessionId = String(eveSessionId ?? "").trim();
  if (!sessionId) return failure("bad_request");

  const mutationBody = buildMutationBody({
    action,
    repo,
    issueNumber,
    labels,
    comment,
    stateReason,
    canonicalIssue,
  });
  if (!mutationBody) return failure("bad_request");

  const url = buildMutateUrl(cfg.baseUrl);
  let res;
  try {
    res = await transport(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ eveSessionId: sessionId, ...mutationBody }),
    });
  } catch {
    return failure("unreachable");
  }

  const status = Number(res && res.status);
  const cls = classifyStatus(status);
  if (!cls.ok) {
    let errBody;
    try {
      errBody = await res.json();
    } catch {
      return failure(cls.reason);
    }
    const consoleMessage =
      errBody && typeof errBody === "object" && typeof errBody.error === "string" && errBody.error
        ? errBody.error
        : undefined;
    return failure(cls.reason, consoleMessage);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return failure("bad_body");
  }

  if (!body || typeof body !== "object" || body.applied !== true) {
    return failure("bad_body");
  }

  return { ok: true, ...body };
}
