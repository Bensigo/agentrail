// The `change` nested investigator's structured output contract (Task 10,
// debugging design spec: docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md;
// spec PR #1501). CHANGE_SCHEMA is a plain JSON Schema object handed to Eve
// as this investigator's `outputSchema`, so the child runs in task mode and
// the framework forces its final answer into this shape — mirrors how
// triage.core.mjs's TRIAGE_SCHEMA/ROUND_REPORT_SCHEMA and qa.core.mjs's
// QA_SCHEMA are consumed by their own sibling agent.ts files. Keeping it a
// dependency-free `.mjs` means both agent.ts and `node --test` specs import
// it with no build and no SDK.
//
// The debugger dispatches this investigator for a full "what changed" sweep
// (a single narrow discriminating question is cheaper as the debugger's own
// direct fetch_changes/search_events call — see triage/instructions.md's
// Deep mode section). This investigator answers ONE question — "what
// changed in this window that could plausibly affect the failing surface"
// — and returns ranked candidates, each grounded in evidence it actually
// saw. The `evidence_refs` floor on every candidate (minItems: 1) is the
// anti-confabulation core, same posture as ROUND_REPORT_SCHEMA's own
// `findings[].evidence_refs` floor in triage.core.mjs: a candidate with no
// evidence is a guess, not a finding, and the schema makes that
// unrepresentable rather than merely discouraged in prose.

export const CHANGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates", "degraded"],
  properties: {
    candidates: {
      type: "array",
      description:
        "Every plausible change found in the mission's window, ranked by plausibility against the failing " +
        "surface the question named — not by recency alone. A candidate with no evidence_refs is a guess, " +
        "never include one.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["what", "at", "why_relevant", "evidence_refs"],
        properties: {
          what: {
            type: "string",
            minLength: 1,
            description: "What changed — a deploy, a merged PR, a config edit, a migration.",
          },
          at: {
            type: "string",
            minLength: 1,
            description: "When it changed, ISO-8601, as reported by the evidence envelope.",
          },
          why_relevant: {
            type: "string",
            minLength: 1,
            description:
              "Why this change could plausibly affect the failing surface named in the mission's question — the " +
              "reasoning, not just the fact of the change.",
          },
          evidence_refs: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
            description:
              "At least one ref to an envelope you actually saw this call (fetch_changes/search_events) — " +
              "never a ref you were only told about, and never an invented one.",
          },
        },
      },
    },
    degraded: {
      type: "array",
      items: { type: "string" },
      description:
        "Every gap this call hit, honestly and verbatim — a verb that came back no_provider, a degraded " +
        "provider (unreachable/unauthorized/etc.), or a question this call couldn't touch at all. Never " +
        "silently omitted.",
    },
  },
};
