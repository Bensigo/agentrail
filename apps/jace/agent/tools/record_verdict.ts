// record_verdict — the ONLY seam that ever sets an investigation's verdict.
// `POST /api/v1/runner/investigations/verdict` (debugging design spec:
// docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md; spec PR
// #1501). See lib/record_verdict.core.mjs's module doc-comment for the full
// argument on why this is UNGATED but still safe: the write is FAIL-CLOSED
// and server-validated — `recordVerdict` (the console query) runs its own
// transactional eligibility/missingEvidence checks, so the model cannot
// force a verdict through by merely asserting it is warranted. A human
// approval gate here would only ever rubber-stamp what the server already
// decided.
//
// save_investigation (the sibling write tool) DOES NOT accept `verdict` or
// `status` — the console route rejects either outright with 400. This tool
// is the only path.
//
// SESSION RESOLUTION — same reasoning as save_investigation.ts /
// fetch_investigations.ts: resolves `ctx.session.parent?.rootSessionId ??
// ctx.session.id`. That SAME resolved id is sent both as this call's
// `eveSessionId` (the wire identity the console resolves the workspace from)
// AND, on success, as the Langfuse score's `sessionId` — the root session id
// every span/score in this dispatch tree groups under (matches
// instrumentation.core.mjs's `resolveRootSessionId`).
//
// On success (200), fire-and-forgets exactly one Langfuse score
// (`investigation_verdict`), gated on Langfuse being configured, using the
// SAME transport + single-`console.warn` failure funnel
// `agent/hooks/langfuse-verdict-score.ts` already uses for triage/qa verdict
// scores — see lib/record_verdict.core.mjs's `pushVerdictScore`. A score-push
// failure never surfaces into this tool's own result.
//
// On 409, the console's own fail-closed refusal: the result carries
// `refused: true` + `blocking` (the exact reasons `computeVerdictEligibility`
// — or the confidence/missingEvidence checks — produced) and the pinned
// rendering `"Verdict refused — <blocking joined \"; \">"`. Relay this
// plainly; do not argue with it, do not retry unchanged, and do NOT push a
// score on this path.
//
// Least privilege by construction:
//  - The network reach is exactly two endpoints via the global `fetch`: the
//    console's verdict route, and (success only, best-effort) Langfuse's
//    public scores API. Both hosts come from configured env, never model
//    input.
//  - On unset config, an unreachable/failing console, or a rejected write it
//    returns a DEGRADED or REFUSED result (never throws, never retries).
//  - `mechanismSummary` is hardened before it ever leaves this module, and
//    the console applies its own secret scan server-side — a 422 means the
//    console detected something credential-shaped and refused the whole
//    call; relay that, never retry unchanged.

import { defineTool } from "eve/tools";
import { z } from "zod";
import { recordVerdict, INVESTIGATION_VERDICTS, VERDICT_CONFIDENCES } from "../lib/record_verdict.core.mjs";

// A wedged/unresponsive console must not hang the chat turn for minutes
// (mirrors save_investigation.ts's own fix for this). This timeout applies
// only to the main verdict POST — the fire-and-forget Langfuse score push
// (below) deliberately has none, mirroring
// agent/hooks/langfuse-verdict-score.ts's own pushScore exactly.
const TIMEOUT_MS = 10_000;

// The REAL transport for the verdict POST: narrowed to the { status, json }
// shape the core expects, same convention as every sibling tool wrapper.
async function realTransport(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { status: res.status, json: () => res.json() };
  } finally {
    clearTimeout(timer);
  }
}

const verdictSchema = z.enum(INVESTIGATION_VERDICTS as unknown as [string, ...string[]]);
const confidenceSchema = z.enum(VERDICT_CONFIDENCES as unknown as [string, ...string[]]);

export default defineTool({
  description:
    "Record a verdict for an investigation — the ONLY way to do so; " +
    "save_investigation refuses a `verdict` key outright. SERVER-VALIDATED " +
    "and FAIL-CLOSED: the console independently checks eligibility (for " +
    "root_caused) or that missingEvidence is non-empty (for undetermined) — " +
    "you cannot talk your way past this by asserting it's ready. ALWAYS " +
    "check `fetch_investigations`' `eligibility` field first and relay it " +
    "honestly rather than guessing; calling this before the human agrees " +
    "the evidence is solid just produces a 409 you then have to explain." +
    "\n\n" +
    "verdict='root_caused' REQUIRES `confidence` and requires the " +
    "investigation to actually be eligible (a supported hypothesis with " +
    "mechanism + evidence, AND either a refuted rival hypothesis or a " +
    "sole-plausible finding) — the exact same rule fetch_investigations' " +
    "`eligibility.blocking` names. verdict='undetermined' REQUIRES a " +
    "non-empty `missingEvidence` — recording 'we don't know' without saying " +
    "what's missing defeats the point; it must be resumable later once that " +
    "evidence exists. `mechanismSummary` is the plain-language 'what " +
    "actually happened' story for a root_caused verdict — omit it for " +
    "undetermined." +
    "\n\n" +
    "ON REFUSAL (409): the result carries `refused: true` and `blocking` — " +
    "the exact reasons the server declined. Relay these to the human " +
    "PLAINLY, do not argue with the gate, and do not retry with the same " +
    "call unchanged; go gather more evidence or test another hypothesis " +
    "instead. No score is recorded on this path." +
    "\n\n" +
    "ON SUCCESS (200): the verdict is APPEND-ONLY — recording a new one " +
    "never edits a prior one, so reopening an investigation never erases " +
    "history. This also fires a background metrics score; you don't need to " +
    "do anything about that, it's not part of what you report to the human." +
    "\n\n" +
    "Never throws. Returns a degraded result (distinct from a refusal) when " +
    "the console is unconfigured, unreachable, erroring, or rejects " +
    "`mechanismSummary` as credential-shaped (422 — never retry that " +
    "unchanged, tell the human instead). No approval gate — see this tool's " +
    "file doc-comment for why a fail-closed, server-validated write needs " +
    "none.",
  inputSchema: z.object({
    slug: z.string().min(1).describe("The investigation's slug (from fetch_investigations) to record a verdict on."),
    verdict: verdictSchema.describe(
      "'root_caused' (requires confidence + server-checked eligibility) or 'undetermined' (requires non-empty missingEvidence).",
    ),
    confidence: confidenceSchema
      .optional()
      .describe("REQUIRED for verdict='root_caused': confirmed / probable / circumstantial. Omit for undetermined."),
    mechanismSummary: z
      .string()
      .optional()
      .describe(
        "Plain-language 'what actually happened' story — the supported hypothesis's mechanism, stated as the " +
          "conclusion. Typically set for root_caused; optional either way.",
      ),
    missingEvidence: z
      .array(z.string())
      .optional()
      .describe(
        "REQUIRED (non-empty) for verdict='undetermined': what would need to be true/known to actually settle " +
          "this, so the investigation can be resumed intelligently later, e.g. 'metrics for checkout during the window'.",
      ),
    changeRecord: z
      .object({
        recordId: z.string().min(1).describe("The workspace-scoped Change Record id linked to this incident."),
        missedCheck: z.string().min(1).max(4000).describe("The check that should have existed to catch this incident."),
      })
      .optional()
      .describe("Optional post-merge incident linkage; emits a missed_check learning row on the Change Record."),
  }),
  async execute(input, ctx) {
    const eveSessionId = ctx?.session?.parent?.rootSessionId ?? ctx?.session?.id;
    return recordVerdict({
      eveSessionId,
      slug: input.slug,
      verdict: input.verdict,
      confidence: input.confidence,
      mechanismSummary: input.mechanismSummary,
      missingEvidence: input.missingEvidence,
      changeRecord: input.changeRecord,
      env: process.env,
      transport: realTransport,
      fetchImpl: fetch,
    });
  },
});
