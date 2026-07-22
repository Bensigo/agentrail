// Pure, dependency-free core for creating a workspace goal from a
// conversation via the console (issue #1289) — Jace's newest GATED write
// action on the outside world, same gate class as create_issue /
// create_workspace / create_repo (see agent/tools/create_goal.ts's
// doc-comment). No SDK, no network primitives of its own: the single HTTP
// call is an injected `transport` seam (real `fetch` with a timeout in the
// thin tool wrapper, a fake in tests), so every branch is unit-testable
// without a live server.
//
// Auth + config model: same as create_workspace.core.mjs /
// send_connect_link.core.mjs — Jace resolves its own console endpoint +
// bearer from JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN.
//
// `eveSessionId` is the ONLY identifying input, and it is never model-
// supplied: the tool wrapper reads it off `ctx.session.id`. `objective`
// (and the optional check/leash overrides) ARE model-supplied, but that's
// fine: the human approves the objective (and any non-default leash) in
// full before this ever runs (console-gated approval) — see
// docs/prd/jace-goal-loop.md's Design #2 ("a human states every goal;
// Jace never self-creates one").
//
// This is deliberately the SIMPLEST of the four gated create_* cores: unlike
// create_workspace (sign-up gate) or create_repo (GitHub API + webhook), a
// goal is pure AgentRail-internal bookkeeping — one POST, one response
// shape. Every non-2xx collapses to one honest, generic failure string
// (mirrors create_workspace's own "no anti-enumeration reason to hide the
// reason" posture is NOT needed here since there's no meaningfully
// different refusal shape to distinguish in v1 — a workspace with no
// connected repo is the one case worth a distinct message, and the console
// route's own `{ connected: false, message }` shape carries that through
// verbatim, mirroring create_issue's own `notConnectedGuidance` contract).

export const CREATE_GOAL_PATH = "/api/v1/runner/goals";

export const GENERIC_FAILURE_MESSAGE = "couldn't create the goal for this conversation";

/**
 * Resolve the console endpoint + bearer from the environment. Deliberately
 * duplicated verbatim from the sibling *.core.mjs modules rather than
 * shared — see console_gated_approval.core.mjs's own comment on why.
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

/** @param {string} baseUrl — already trimmed + de-slashed */
export function buildCreateGoalUrl(baseUrl) {
  return `${baseUrl}${CREATE_GOAL_PATH}`;
}

/**
 * Create a goal for the conversation identified by `eveSessionId`. Returns
 * `{ goalId, objective, slug, status }` on success, `{ connected: false,
 * message }` when the workspace has no connected repo yet (mirrors
 * create_issue's own `notConnectedGuidance` shape — the console route
 * returns this verbatim), or a generic honest failure string otherwise —
 * never throws. Single attempt, no retry.
 *
 * @param {{
 *   eveSessionId: string,
 *   objective: string,
 *   checkThreshold?: number,
 *   checkMetric?: string,
 *   maxIssues?: number,
 *   maxSpendUsd?: number,
 *   env?: Record<string, string|undefined>,
 *   transport: (url: string, init: { method: string, headers: Record<string,string>, body: string }) =>
 *     Promise<{ status: number, json: () => Promise<unknown> }>,
 * }} args
 * @returns {Promise<{ goalId: string, objective: string, slug: string, status: string } | { connected: false, message: string } | string>}
 */
export async function runCreateGoal({
  eveSessionId,
  objective,
  checkThreshold,
  checkMetric,
  maxIssues,
  maxSpendUsd,
  env = {},
  transport,
}) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return GENERIC_FAILURE_MESSAGE;

  const sessionId = String(eveSessionId ?? "").trim();
  if (!sessionId) return GENERIC_FAILURE_MESSAGE;

  const trimmedObjective = String(objective ?? "").trim();
  if (!trimmedObjective) return GENERIC_FAILURE_MESSAGE;

  const url = buildCreateGoalUrl(cfg.baseUrl);

  let res;
  try {
    res = await transport(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        eveSessionId: sessionId,
        objective: trimmedObjective,
        ...(checkThreshold !== undefined ? { checkThreshold } : {}),
        ...(checkMetric !== undefined ? { checkMetric } : {}),
        ...(maxIssues !== undefined ? { maxIssues } : {}),
        ...(maxSpendUsd !== undefined ? { maxSpendUsd } : {}),
      }),
    });
  } catch {
    return GENERIC_FAILURE_MESSAGE;
  }

  const status = Number(res && res.status);

  if (status < 200 || status >= 300) {
    if (status === 409) {
      let errorBody;
      try {
        errorBody = await res.json();
      } catch {
        return GENERIC_FAILURE_MESSAGE;
      }
      if (errorBody && typeof errorBody === "object" && errorBody.connected === false) {
        const message =
          typeof errorBody.message === "string" && errorBody.message.length > 0
            ? errorBody.message
            : GENERIC_FAILURE_MESSAGE;
        return { connected: false, message };
      }
      if (errorBody && typeof errorBody === "object" && typeof errorBody.error === "string") {
        return errorBody.error;
      }
    }
    return GENERIC_FAILURE_MESSAGE;
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return GENERIC_FAILURE_MESSAGE;
  }

  if (
    !body ||
    typeof body !== "object" ||
    typeof body.goalId !== "string" ||
    !body.goalId ||
    typeof body.objective !== "string" ||
    typeof body.slug !== "string" ||
    typeof body.status !== "string"
  ) {
    return GENERIC_FAILURE_MESSAGE;
  }

  return { goalId: body.goalId, objective: body.objective, slug: body.slug, status: body.status };
}
