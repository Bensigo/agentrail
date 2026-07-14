// Task 10 — Jace verdict -> score hook (Langfuse Phase 2). Observes the
// triage and QA declared subagents' completed structured output and pushes
// each as a session-scoped Langfuse score. Purely additive: this hook never
// blocks or mutates the agent's own turn (hooks are observe-only per
// node_modules/eve/docs/guides/hooks.md), and a Langfuse outage must never
// surface into the agent.
//
// PINS (verified 2026-07-13, against the installed eve@0.19.0 docs/types and
// the live Langfuse docs):
//
// (a) Scores API accepts SESSION-scoped scores. `POST /api/public/scores`'s
//     body carries an optional `sessionId` field alongside (not requiring)
//     `traceId` — confirmed against
//     https://langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk
//     ("Session-level Scores": "To score an entire session (without
//     attaching the score to a trace or observation), provide only
//     `session_id` / `sessionId`") and the API reference
//     (POST /api/public/scores: `score_create`, "supports both trace and
//     session scores", `sessionId` and `traceId` are both optional top-level
//     body fields). This hook sends `sessionId` ONLY — never `traceId` — per
//     the brief: the OTel trace id is not visible to hooks, only
//     `ctx.session.id` is.
//
// (b) The event carrying a completed declared-subagent result on ROOT's own
//     hook stream is `action.result` (type: "action.result"), NOT
//     `message.completed`. Verified against
//     node_modules/eve/dist/src/protocol/message.d.ts: `ActionResultStreamEvent`
//     (`data: { result: RuntimeActionResult, status, ... }`) is a distinct
//     type from `SubagentCalledStreamEvent`/`SubagentCompletedStreamEvent`
//     (which cover a DIFFERENT "inline subagent" execution mode, not the
//     declared `agent/subagents/<name>/` pattern triage and qa use). A
//     declared subagent runs as its own child session — its OWN turns
//     stream on that child session (invisible to root's hooks per hooks.md's
//     "Subagent isolation": "Parent-agent hooks do not fire for subagent
//     turns") — but its FINAL result is additionally projected back onto
//     ROOT's own `action.result` stream, because from root's perspective
//     delegating to a subagent is one more action alongside a tool call or
//     skill load (see `RuntimeActionRequest`'s "subagent-call" kind). This is
//     the "lowered into root's tool stream" the triage `agent.ts` comment
//     (lines 29-33) describes, and root's hook DOES fire for it because it
//     belongs to root's own turn, not the child session's.
//
// (c) The parsed structured output lands on `event.data.result.output` (a
//     JsonValue shaped by TRIAGE_SCHEMA/QA_SCHEMA); the originating
//     subagent's identity is `event.data.result.subagentName`. Both verified
//     against node_modules/eve/dist/src/runtime/actions/types.d.ts's
//     `RuntimeSubagentResultActionResult` (`{ callId, isError?, kind:
//     "subagent-result", output, subagentName }`). "triage" and "qa" are the
//     literal subagentName values because a subagent's name is its
//     directory name (node_modules/eve/docs/reference/project-layout.md:19,
//     :93) — `agent/subagents/triage/` and `agent/subagents/qa/`. There is
//     no built-in narrowing helper for subagent results (`toolResultFrom`
//     only narrows `kind: "tool-result"`), so this checks `.kind` directly.
//
// Env-gated on the same three vars `agent/lib/instrumentation.core.mjs`
// (Task 7) uses — reusing `isLangfuseConfigured` so the two seams can never
// disagree about whether Langfuse is on.
//
// SESSION ID: this hook lives under root's `agent/hooks/` (not a subagent's
// own `hooks/`), so per "Subagent isolation" it only ever fires for events
// on ROOT's own stream — `ctx.session` here is always the ROOT session, and
// (per instrumentation.core.mjs's `resolveRootSessionId`) a root session has
// no `parent`, so its `id` already IS the id `instrumentation.ts` stamped
// onto every span in this dispatch tree. No extra resolution is needed:
// `ctx.session.id` and the instrumentation-stamped session id are the same
// value for exactly this hook's scope.
import { defineHook } from "eve/hooks";
import { isLangfuseConfigured } from "../lib/instrumentation.core.mjs";

/** Score `name` per subagent — the brief's `"triage_verdict" | "qa_verdict"`. */
const SCORE_NAME_BY_SUBAGENT = {
  triage: "triage_verdict",
  qa: "qa_verdict",
};

// De-dup guard (issue #1196): the same completed subagent result was observed
// to reach this hook more than once for one turn (two identical scores with the
// same callId). Score each callId at most once. Bounded so a long-running
// process can't grow this set without limit — oldest ids evict first.
const SEEN_CALL_IDS_MAX = 500;
const _seenCallIds = new Set();
function markScored(seen, callId) {
  if (!callId) return true; // no id to dedup on — don't suppress
  if (seen.has(callId)) return false;
  seen.add(callId);
  if (seen.size > SEEN_CALL_IDS_MAX) seen.delete(seen.values().next().value);
  return true;
}

/** Test-only: clear the process-wide de-dup memory so tests stay isolated. */
export function __resetScoredForTests() {
  _seenCallIds.clear();
}

/**
 * Derive the score `value` (+ `dataType`) from one subagent's parsed
 * structured output.
 *
 * QA_SCHEMA (agent/subagents/qa/lib/qa.core.mjs) carries a literal `verdict`
 * enum (`passed` | `issues_found` | `not_verifiable`) — used verbatim.
 *
 * TRIAGE_SCHEMA (agent/subagents/triage/lib/triage.core.mjs) has NO literal
 * "verdict" field — its closest equivalent is `blocking_reason`: a non-empty
 * string names the specific gate/error that stopped the run, and "" means
 * nothing blocks (a transient red an automatic retry can clear, per the
 * schema's own property description). This maps that presence/absence to a
 * CATEGORICAL "blocked" / "unblocked" value so triage's score is comparable
 * across runs for the Phase 2 calibration report (item 9).
 *
 * Returns `undefined` for any subagent name this hook doesn't score.
 *
 * @param {string} subagentName
 * @param {unknown} output
 * @returns {{ value: string, dataType: "CATEGORICAL" } | undefined}
 */
export function verdictValueFor(subagentName, output) {
  // The subagent's structured output arrives as a JSON STRING on the live
  // stream (verified against a real `subagent.completed` / `action.result`
  // event: `typeof output === "string"`), not a pre-parsed object. Parse it
  // first, otherwise `blocking_reason` / `verdict` is never read and triage
  // always scores "unblocked" regardless of the real diagnosis (issue #1197).
  let parsed = output;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = {};
    }
  }
  const o = parsed !== null && typeof parsed === "object" ? parsed : {};
  if (subagentName === "qa") {
    const verdict = typeof o.verdict === "string" && o.verdict.trim() ? o.verdict : "unknown";
    return { value: verdict, dataType: "CATEGORICAL" };
  }
  if (subagentName === "triage") {
    const blocking = typeof o.blocking_reason === "string" ? o.blocking_reason.trim() : "";
    return { value: blocking ? "blocked" : "unblocked", dataType: "CATEGORICAL" };
  }
  return undefined;
}

/**
 * Extract the factory `run_id` the subagent operated on, if it echoed one.
 *
 * The `action.result` event carries ONLY `result` ({ callId, isError, kind,
 * output, subagentName }) — never the original subagent-call input — so the
 * run_id the parent handed the subagent is not directly on the event. The
 * reliable hook-visible source is the subagent's own structured output:
 * TRIAGE_SCHEMA / QA_SCHEMA each carry an optional `run_id` the subagent is
 * instructed to echo verbatim (see their instructions.md). This is the join
 * key calibration needs to pair the session-scoped verdict against the
 * factory run's TRACE-scoped ground-truth outcome — WITHOUT re-scoping the
 * score to the run trace (the score stays session-scoped, preserving the
 * Langfuse session badge from #1198; only metadata.run_id is added).
 *
 * Parses the same JSON-string-or-object output `verdictValueFor` does, and is
 * total: any non-object output, unparseable string, or missing/blank run_id
 * yields `undefined` (metadata.run_id is then simply omitted — never
 * fabricated, never a throw). Observe-only + fail-open is preserved.
 *
 * @param {unknown} output
 * @returns {string | undefined}
 */
export function runIdFrom(output) {
  let parsed = output;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  const o = parsed !== null && typeof parsed === "object" ? parsed : {};
  const id = typeof o.run_id === "string" ? o.run_id.trim() : "";
  return id ? id : undefined;
}

/**
 * POST one session-scoped score to Langfuse (`POST /api/public/scores`).
 * Fire-and-forget: every failure — transport rejection or a non-2xx
 * response — funnels into exactly one `console.warn`, and the returned
 * promise NEVER rejects. A score-push failure must never surface into the
 * agent (hooks are observe-only; a thrown hook becomes a real `turn.failed`
 * per hooks.md, which this must never trigger).
 *
 * @param {{
 *   baseUrl: string,
 *   publicKey: string,
 *   secretKey: string,
 *   fetchImpl: typeof fetch,
 *   body: Record<string, unknown>,
 * }} params
 * @returns {Promise<void>}
 */
export function pushScore({ baseUrl, publicKey, secretKey, fetchImpl, body }) {
  const token = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const url = `${String(baseUrl).replace(/\/+$/, "")}/api/public/scores`;
  return fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${token}`,
    },
    body: JSON.stringify(body),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`langfuse scores POST returned HTTP ${res.status}`);
    })
    .catch((err) => {
      console.warn("[langfuse-verdict-score] failed to push score:", err?.message ?? err);
    });
}

/**
 * The pure `action.result` handler — the seam tests exercise directly with
 * an injected `env` and `fetchImpl` (mirroring
 * `fetch_run_evidence.core.mjs`'s injected-transport convention; this
 * repo's `node --test test/*.test.mjs` runs without
 * `--experimental-test-module-mocks`, so there is no way to intercept the
 * real global `fetch`).
 *
 * Scores exactly one completed, non-error `subagent-result` from "triage" or
 * "qa"; every other event (non-subagent tool/skill results, other
 * subagents, failed/rejected calls, errored subagent calls, unconfigured
 * Langfuse env) is a no-op.
 *
 * @param {{ type: string, data?: { status?: string, result?: { kind?: string, isError?: boolean, subagentName?: string, output?: unknown, callId?: string } } }} event
 * @param {{ session: { id: string } }} ctx
 * @param {{ env?: Record<string, string|undefined>, fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<void>}
 */
export async function handleActionResult(event, ctx, deps = {}) {
  const env = deps.env ?? process.env;
  if (!isLangfuseConfigured(env)) return;

  if (event?.type !== "action.result") return;
  const data = event.data ?? {};
  const result = data.result;
  if (!result || result.kind !== "subagent-result") return;
  if (data.status !== "completed" || result.isError) return;

  const subagentName = result.subagentName;
  const scoreName = SCORE_NAME_BY_SUBAGENT[subagentName];
  if (!scoreName) return; // only triage + qa carry a Langfuse verdict score

  const verdict = verdictValueFor(subagentName, result.output);
  if (!verdict) return;

  // Score this completion at most once (issue #1196).
  const seen = deps.seen ?? _seenCallIds;
  if (!markScored(seen, result.callId)) return;

  // Join key for calibration (item 9): the factory run_id this subagent
  // operated on, echoed on its structured output. Added to metadata ONLY when
  // present — an absent/blank run_id omits the field cleanly (never throws,
  // never fabricated). The score stays session-scoped; run_id is metadata, not
  // a re-scope to the run trace.
  const metadata = { subagentName, callId: result.callId };
  const runId = runIdFrom(result.output);
  if (runId) metadata.run_id = runId;

  const fetchImpl = deps.fetchImpl ?? fetch;
  await pushScore({
    baseUrl: env.LANGFUSE_BASE_URL,
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    fetchImpl,
    body: {
      sessionId: ctx.session.id,
      name: scoreName,
      value: verdict.value,
      dataType: verdict.dataType,
      metadata,
    },
  });
}

export default defineHook({
  events: {
    "action.result": (event, ctx) => handleActionResult(event, ctx),
  },
});
