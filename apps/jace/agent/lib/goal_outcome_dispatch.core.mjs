// Pure, dependency-free core for the Jace goal loop's evaluate-on-outcome
// step (issue #1289, PRD design point 4: "extend the run-outcome
// hand-off"). Wired from agent/channels/run-outcome.ts: AFTER the existing
// platform notification is forwarded unchanged, this decides whether a
// SECOND, synthetic message should ALSO be delivered into the same
// conversation — an escalation (leash/stuck), a completion announcement
// (reached), or a nudge to decompose and file the next issue (refill).
//
// THE SAFETY LINE this module preserves (binding, do not weaken): this
// module NEVER files an issue itself and NEVER calls create_issue directly.
// A "refill" decision only ever produces a MESSAGE — delivered into the
// SAME conversation via the caller's own `args.receive`, exactly the way a
// real user message would be — so the MODEL is the one that decides to
// call create_issue in response, and that call still goes through the
// EXACT SAME consoleGatedApproval seam as any human-initiated issue. There
// is no second write path here, only a second message.
//
// This module makes exactly ONE outbound HTTP call (POST the console's
// `/api/v1/runner/goals/evaluate`), via an injected `transport` seam (real
// fetch-with-timeout in the thin wrapper, a fake in tests) — no SDK, no
// network primitives of its own, matching every sibling *.core.mjs module's
// posture.
//
// FAIL-SAFE ON EVERY BRANCH: a transport error, a non-2xx, a malformed
// body, `matched: false` (flag off or no goal maps to this issue), or an
// unrecognized `action` all resolve to `{ action: "none" }` — NEVER throws,
// and never blocks or alters the existing platform-notify path this
// function's caller already depends on (see run-outcome.ts: this call is
// wrapped in its own waitUntil, independent of the notify forward).

export const EVALUATE_GOAL_PATH = "/api/v1/runner/goals/evaluate";

const REQUEST_TIMEOUT_MS = 8000;

/**
 * Resolve the console endpoint + bearer from the environment. Deliberately
 * duplicated verbatim from the sibling *.core.mjs modules — see
 * console_gated_approval.core.mjs's own comment on why.
 * @param {Record<string, string|undefined>} [env]
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

/** @param {string} baseUrl — already trimmed + de-slashed */
export function buildEvaluateGoalUrl(baseUrl) {
  return `${baseUrl}${EVALUATE_GOAL_PATH}`;
}

/**
 * The goal-stamp line embedded in filed issue bodies, and echoed in every
 * synthetic message below — human- and grep-readable, deliberately not a
 * GitHub label (create_issue has no label input; see schema/goals.ts's own
 * `slug` comment for why).
 * @param {{ objective: string, slug: string }} goal
 */
export function goalStamp(goal) {
  return `Goal: ${goal.objective} (goal:${goal.slug})`;
}

/** @param {{ objective: string, slug: string }} goal @param {string} reason */
export function buildReachedMessage(goal, reason) {
  return (
    `[Goal update] ${goalStamp(goal)} has been REACHED: ${reason}. ` +
    "No further issues will be filed for this goal."
  );
}

/** @param {{ objective: string, slug: string }} goal @param {string} reason @param {"leashed"|"stuck"} kind */
export function buildEscalationMessage(goal, reason, kind) {
  const label = kind === "leashed" ? "LEASHED" : "PAUSED (stuck rule)";
  return (
    `[Goal update] ${goalStamp(goal)} is now ${label}: ${reason}. ` +
    "Do not file any further issues for this goal — just let the user know " +
    "this status change happened and why."
  );
}

/**
 * @param {{ objective: string, slug: string, issuesFiled: number, maxIssues: number, spendUsd: number, maxSpendUsd: number }} goal
 * @param {string} issueExternalId
 * @param {string} outcome
 */
export function buildRefillMessage(goal, issueExternalId, outcome) {
  const issuesLeft = Math.max(0, goal.maxIssues - goal.issuesFiled);
  const spendLeft = Math.max(0, goal.maxSpendUsd - goal.spendUsd);
  return (
    `[Goal update] ${goalStamp(goal)}: issue #${issueExternalId} finished with outcome '${outcome}'. ` +
    `Leash remaining: ${issuesLeft} issue(s) / $${spendLeft.toFixed(2)}. ` +
    "If this goal's check is not yet met, decompose and file the NEXT issue " +
    "toward it via create_issue — stamp its body with " +
    `"${goalStamp(goal)}". If you believe no further issue is needed right ` +
    "now, just tell the user why instead of calling create_issue."
  );
}

/**
 * Map one evaluate-endpoint response to a dispatch decision. Pure — no I/O.
 * @param {unknown} body — the parsed JSON response from POST .../goals/evaluate
 * @param {{ issueExternalId: string, outcome: string }} event — the outcome this evaluation was FOR (needed for the refill message's own text)
 * @returns {{ action: "none" } | { action: "message", message: string }}
 */
export function decideGoalDispatch(body, event) {
  if (!body || typeof body !== "object") return { action: "none" };
  const b = /** @type {Record<string, unknown>} */ (body);
  if (b.matched !== true || !b.goal || typeof b.goal !== "object") return { action: "none" };

  const goal = /** @type {Record<string, unknown>} */ (b.goal);
  if (
    typeof goal.objective !== "string" ||
    typeof goal.slug !== "string" ||
    typeof goal.issuesFiled !== "number" ||
    typeof goal.maxIssues !== "number" ||
    typeof goal.spendUsd !== "number" ||
    typeof goal.maxSpendUsd !== "number"
  ) {
    return { action: "none" };
  }

  const reason = typeof b.reason === "string" ? b.reason : "no reason given";

  switch (b.action) {
    case "reached":
      return { action: "message", message: buildReachedMessage(goal, reason) };
    case "escalate_leashed":
      return { action: "message", message: buildEscalationMessage(goal, reason, "leashed") };
    case "escalate_stuck":
      return { action: "message", message: buildEscalationMessage(goal, reason, "stuck") };
    case "refill":
      return {
        action: "message",
        message: buildRefillMessage(goal, event.issueExternalId, event.outcome),
      };
    default:
      // "noop" (the goal is already terminal — see decideGoalTransition's
      // own terminal safety net) or any unrecognized value: nothing further
      // to say, the platform notification already covered the outcome.
      return { action: "none" };
  }
}

/**
 * POST the outcome to the console's evaluate endpoint and decide the
 * dispatch. Never throws — every failure mode (missing config, network
 * error, non-2xx, malformed body) resolves to `{ action: "none" }`, the
 * same fail-safe direction as an honest "flag off" / "no goal matched".
 *
 * @param {{
 *   workspaceId: string,
 *   issueExternalId: string,
 *   outcome: string,
 *   costUsd?: number,
 *   env?: Record<string, string|undefined>,
 *   transport: (url: string, init: object) => Promise<{ status: number, json: () => Promise<unknown> }>,
 * }} args
 * @returns {Promise<{ action: "none" } | { action: "message", message: string }>}
 */
export async function evaluateGoalOutcome({
  workspaceId,
  issueExternalId,
  outcome,
  costUsd,
  env = {},
  transport,
}) {
  try {
    const cfg = resolveConsoleConfig(env);
    if (!cfg.ok) return { action: "none" };

    const ws = String(workspaceId ?? "").trim();
    const issue = String(issueExternalId ?? "").trim();
    if (!ws || !issue) return { action: "none" };

    let res;
    try {
      res = await transport(buildEvaluateGoalUrl(cfg.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          workspaceId: ws,
          issueExternalId: issue,
          outcome,
          ...(typeof costUsd === "number" ? { costUsd } : {}),
        }),
      });
    } catch {
      return { action: "none" };
    }

    const status = Number(res && res.status);
    if (!Number.isFinite(status) || status < 200 || status >= 300) return { action: "none" };

    let body;
    try {
      body = await res.json();
    } catch {
      return { action: "none" };
    }

    return decideGoalDispatch(body, { issueExternalId: issue, outcome });
  } catch {
    // Belt-and-suspenders: this function must never throw past the caller's
    // own waitUntil — see the module's SAFETY LINE comment.
    return { action: "none" };
  }
}

/** Real fetch with a timeout — mirrors the sibling *.core.mjs modules' own realTransport idiom. */
export async function realTransport(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { status: res.status, json: () => res.json() };
  } finally {
    clearTimeout(timer);
  }
}
