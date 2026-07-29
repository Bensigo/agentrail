// save_investigation — Jace's autosave WRITE path into INVESTIGATIONS: the
// durable, server-side record of ONE production incident (debugging design
// spec: docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md;
// spec PR #1501). Structural sibling of save_brief.ts — same UNGATED
// rationale (per-item DELTA, console-enforced invariants, no external
// side effect) — for a production symptom instead of a product idea.
//
// UNGATED, deliberately — see lib/save_investigation.core.mjs's module
// doc-comment for the full argument: nothing this writes reaches GitHub, a
// human's inbox, or any other outside system; every write is a per-item
// DELTA the console's own route enforces invariants against (human-authority
// lock, evidence immutability, hypothesis evidence-gating, kind-is-fixed-at-
// creation); `create_issue` remains the only boundary crossing that still
// requires human approval. `record_verdict` (the sibling tool) — never this
// one — is the only thing that can set a verdict; the wire route itself
// rejects a `verdict`/`status` key with 400, and this tool's input schema
// has NO such field at all (genuinely absent, exactly like save_brief.ts has
// no `status` parameter).
//
// SESSION RESOLUTION — same reasoning as save_brief.ts / fetch_investigations.ts
// (read save_brief.ts's own doc-comment for the full explanation): this
// wrapper resolves `ctx.session.parent?.rootSessionId ?? ctx.session.id`, not
// `ctx.session.id` alone, so this tool is correct whether called from root
// directly or from inside a declared subagent's own child session.
//
// SEVEN ARRAYS ON THE RESULT ARE REFUSALS, NOT DETAILS — see the tool
// description below and lib/save_investigation.core.mjs's module comment for
// the full reasoning and the pinned rendering prefix each one gets.
//
// Least privilege by construction:
//  - The network reach is exactly one endpoint via the global `fetch`. The
//    host/path come from configured env, never from model input.
//  - On unset config, an unreachable/failing console, or an erroring console
//    it returns a DEGRADED result (never throws, never retries).
//  - Free-text fields (`title`, `symptomStatement`, `symptomSignature`,
//    `affectedSurface`, item `body`/`mechanism`) are run through
//    `hardenUntrusted` before they ever leave this module, and the console
//    applies its own secret scan server-side on write — a 422 means the
//    console detected something credential-shaped and refused the ENTIRE
//    batch; relay that to the human, never retry unchanged.

import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  saveInvestigation,
  INVESTIGATION_SEVERITIES,
  INVESTIGATION_ITEM_KINDS,
  HYPOTHESIS_STATES,
  INVESTIGATION_LINK_ROLES,
} from "../lib/save_investigation.core.mjs";

// A wedged/unresponsive console must not hang the chat turn for minutes
// (mirrors save_brief.ts's own fix for this).
const TIMEOUT_MS = 10_000;

// The REAL transport: one POST via the global fetch, narrowed to the
// { status, json } shape the core expects. Injected exactly as
// save_brief.ts injects its real driver, so the core stays hermetic in tests.
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

const severitySchema = z.enum(INVESTIGATION_SEVERITIES as unknown as [string, ...string[]]);
const kindSchema = z.enum(INVESTIGATION_ITEM_KINDS as unknown as [string, ...string[]]);
const stateSchema = z.enum(HYPOTHESIS_STATES as unknown as [string, ...string[]]);
const linkRoleSchema = z.enum(INVESTIGATION_LINK_ROLES as unknown as [string, ...string[]]);

const itemSchema = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "Omit to INSERT a new item. Supply an existing item's `id` (from a prior fetch_investigations/" +
        "save_investigation result) to update it in place.",
    ),
  kind: kindSchema.describe(
    "REQUIRED on every item, even a patch to an existing one — an investigation item's kind is FIXED at " +
      "creation and can never be changed through this tool (unlike a brief item's kind). timeline_event " +
      "(witness-interview / round-report notes), evidence (NEVER create/edit one here — refused outright; " +
      "evidence is captured only by the evidence capability layer), hypothesis (a state machine: open -> " +
      "supported/refuted/inconclusive, gated on evidence_refs), finding (a claim with evidence_refs; " +
      "data.solePlausible:true is the one-rival-refuted alternative the verdict gate accepts), verdict (never " +
      "create one here — use record_verdict instead), lesson_candidate (a drafted causal-pattern/test-recipe " +
      "note; promotion into workspace memory is console-only, human-gated).",
  ),
  body: z
    .string()
    .optional()
    .describe("The claim/statement/note itself — meaning varies by kind. Omit to leave an existing item's body unchanged."),
  mechanism: z
    .string()
    .optional()
    .describe(
      "Meaningful for hypotheses only: the causal mechanism (e.g. 'connection pool starves under concurrent " +
        "load'). A hypothesis cannot enter state:'supported' without a non-empty mechanism.",
    ),
  state: stateSchema
    .nullable()
    .optional()
    .describe(
      "Meaningful for hypotheses only: open (default) / supported / refuted / inconclusive. Entering " +
        "supported or refuted REQUIRES at least one entry in evidence_refs (checked against the EFFECTIVE, " +
        "merged value — you can't sidestep this by omitting evidence_refs on the same call that sets state). " +
        "Omit to leave an existing item's state unchanged; pass null only if you explicitly mean to clear it.",
    ),
  evidence_refs: z
    .array(z.string())
    .optional()
    .describe(
      "Ids of the evidence items (from fetch_investigations) that back this claim. REQUIRED (non-empty) " +
        "before a hypothesis can be saved as supported/refuted, and before a finding is treated as load-bearing " +
        "for the verdict gate. Omit to leave an existing item's evidence_refs unchanged.",
    ),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Kind-specific structured metadata — e.g. { solePlausible: true } on a finding, or a hypothesis's " +
        "discriminating test. Never evidence's own envelope (provider/verb/query/excerpt) — that is written " +
        "only by the evidence capability layer.",
    ),
});

const linkSchema = z.object({
  targetSlug: z.string().min(1).describe("The slug of the OTHER investigation this one links to."),
  role: linkRoleSchema.describe(
    "'recurrence_of': this investigation is a NEW incident for a symptom an OLD, already-concluded " +
      "investigation covered — this structurally discredits the old verdict, so use it the moment a fix that " +
      "was believed to have shipped turns out not to have held. 'related': a looser, non-discrediting " +
      "cross-reference.",
  ),
});

export default defineTool({
  description:
    "Autosave a DELTA of one investigation — the durable, server-side record " +
    "of ONE production incident. Call this as soon as something settles " +
    "during a debugging conversation (a symptom gets pinned, a hypothesis is " +
    "proposed or tested, a round of investigation concludes) — never batch " +
    "it up for the end. `slug` is the investigation's stable identity: " +
    "reuse an EXISTING slug (from fetch_investigations) to continue that " +
    "incident's record rather than forking a duplicate for the same thing. " +
    "`title`/`symptomStatement`/`symptomSignature`/`affectedSurface`/" +
    "`severity`/`firstSeenAt` are omittable on any call that only touches " +
    "items — omitting them leaves the existing value UNCHANGED; " +
    "`symptomStatement` should be the human's OWN WORDS, verbatim, never a " +
    "paraphrase. `items` is a PATCH: each item with an `id` updates that " +
    "exact row (any field you omit on it is left exactly as stored), each " +
    "item without an `id` inserts a new row; every OTHER item already on the " +
    "investigation is left untouched. `links` records `recurrence_of`/" +
    "`related` edges to another investigation by slug." +
    "\n\n" +
    "DOES NOT ACCEPT `verdict` OR `status` — there is no such parameter for " +
    "either. Verdicts travel ONLY through record_verdict, which the server " +
    "validates and fails closed; `status` is derived server-side from " +
    "whether a verdict has been recorded, never a flag the model sets. Do " +
    "not try to set either here, and do not describe an investigation as " +
    "'root-caused' or 'concluded' to the user unless record_verdict actually " +
    "confirmed it — see that tool." +
    "\n\n" +
    "SIX FIELDS ON THE RESULT ARE REFUSALS, NOT DETAILS — YOU MUST RELAY " +
    "THEM, NEVER STAY SILENT: `skippedHumanAuthorityIds` (a human already " +
    "edited these in the console — their version was kept, don't claim you " +
    "updated it), `skippedEvidenceImmutableIds` (these items are, or would " +
    "become, kind:'evidence' — only the evidence capability layer may write " +
    "that kind, never this tool), `skippedHypothesisNeedsEvidence` (these " +
    "hypotheses can't enter supported/refuted with no evidence_refs — cite " +
    "at least one evidence id first), `skippedKindChangeIds` (a patch tried " +
    "to change an existing item's kind — refused; kind is fixed at " +
    "creation), `unmatchedIds` (an id you named doesn't exist on THIS " +
    "investigation — check you're not reusing an id from a different one), " +
    "`skippedLinks` (a link's targetSlug didn't resolve to an investigation " +
    "in this workspace). `applied` lists the ids that actually landed. " +
    "Silently treating any refusal array as empty when it isn't means " +
    "telling a human something was recorded when it was not." +
    "\n\n" +
    "Never throws. Returns a degraded result when the console is " +
    "unconfigured, unreachable, or rejects the write (e.g. 422 when a value " +
    "looks like a pasted credential — never retry that unchanged; tell the " +
    "human instead). No approval gate: this only ever touches AgentRail's " +
    "own investigation store, never GitHub or any other outside system." +
    "\n\n" +
    "`anchor` sets or clears THIS conversation's investigation anchor — the " +
    "write behind 'confirm once, then anchor': the FIRST time in a " +
    "conversation the human confirms which incident this is, call this SAME " +
    "turn with `anchor: true` so every later turn resumes via " +
    "fetch_investigations(mode: \"anchor\") instead of re-searching. " +
    "`anchor: false` clears it the moment the human says this is a " +
    "different incident — that call can fire with NOTHING else settled, " +
    "which is why `slug` is optional on THIS tool only for a bare " +
    "`{ anchor: false }` clear; every other call still requires `slug`. " +
    "Omit `anchor` entirely on a plain per-turn autosave once already " +
    "anchored.",
  inputSchema: z.object({
    slug: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Stable identity for this incident, kebab-case (e.g. 'checkout-500s'). Reuse an existing " +
          "investigation's slug (from fetch_investigations) to continue it; propose a short new one only for a " +
          "genuinely new incident. Omit ONLY for a pure anchor-clear call (anchor: false with nothing else " +
          "set) — every other call requires it.",
      ),
    title: z
      .string()
      .optional()
      .describe("Human-readable title. Omit to leave the existing title unchanged (or let it default to the slug on creation)."),
    symptomStatement: z
      .string()
      .optional()
      .describe("The human's OWN WORDS describing the symptom, verbatim — never a paraphrase. Omit to leave unchanged."),
    symptomSignature: z
      .string()
      .optional()
      .describe(
        "A short, normalized form of the symptom for recurrence search (e.g. 'checkout 500 error rate spike') " +
          "— distinct from symptomStatement, which stays verbatim. Omit to leave unchanged.",
      ),
    affectedSurface: z
      .string()
      .optional()
      .describe("What's affected (service/endpoint/feature), plainly. Omit to leave unchanged."),
    severity: severitySchema.optional().describe("low/medium/high/critical. Omit to leave unchanged (defaults to medium on creation)."),
    firstSeenAt: z
      .string()
      .nullable()
      .optional()
      .describe("ISO timestamp of when the symptom first appeared. Pass null to explicitly clear it; omit to leave unchanged."),
    items: z
      .array(itemSchema)
      .optional()
      .describe("A DELTA of items to insert/update — only the ones that changed this turn, never the whole ledger."),
    links: z
      .array(linkSchema)
      .optional()
      .describe("Investigation-to-investigation edges to record (recurrence_of/related) by target slug."),
    anchor: z
      .boolean()
      .optional()
      .describe(
        "true: anchor this conversation to THIS call's investigation (slug) — call it the SAME turn the human " +
          "confirms which incident this is. false: clear this conversation's anchor — call it alone (no slug/" +
          "title/etc) the moment the human says this is a different incident, then re-resolve with " +
          "fetch_investigations before writing anything new. Omit to leave the anchor untouched.",
      ),
  }),
  async execute(input, ctx) {
    const eveSessionId = ctx?.session?.parent?.rootSessionId ?? ctx?.session?.id;
    return saveInvestigation({
      eveSessionId,
      slug: input.slug,
      title: input.title,
      symptomStatement: input.symptomStatement,
      symptomSignature: input.symptomSignature,
      affectedSurface: input.affectedSurface,
      severity: input.severity,
      firstSeenAt: input.firstSeenAt,
      items: input.items,
      links: input.links,
      anchor: input.anchor,
      env: process.env,
      transport: realTransport,
    });
  },
});
