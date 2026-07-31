// The `anomaly` nested investigator's structured output contract (Task 10,
// debugging design spec: docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md;
// spec PR #1501). ANOMALY_SCHEMA is a plain JSON Schema object handed to Eve
// as this investigator's `outputSchema`, so the child runs in task mode and
// the framework forces its final answer into this shape — mirrors how
// triage.core.mjs's TRIAGE_SCHEMA/ROUND_REPORT_SCHEMA and qa.core.mjs's
// QA_SCHEMA are consumed by their own sibling agent.ts files. Keeping it a
// dependency-free `.mjs` means both agent.ts and `node --test` specs import
// it with no build and no SDK.
//
// The debugger dispatches this investigator for a full "where does the
// system deviate from baseline" sweep (a single narrow discriminating
// question is cheaper as the debugger's own direct
// fetch_changes/search_events call — see triage/instructions.md's Deep mode
// section). This investigator answers ONE question — "where and when does
// the system deviate from baseline" — and returns every deviation it found,
// each grounded in evidence it actually saw, PLUS two fields no other
// investigator carries: `normal_surfaces` (who is NOT affected is evidence
// too — a clean surface narrows the hypothesis space exactly as much as a
// deviating one) and `first_deviation` (which signal moved first, when
// several deviated — the ordering is often the causal lead). The
// `evidence_refs` floor on every deviation (minItems: 1) is the
// anti-confabulation core, same posture as ROUND_REPORT_SCHEMA's own
// `findings[].evidence_refs` floor in triage.core.mjs: a deviation with no
// evidence is a guess, not a finding, and the schema makes that
// unrepresentable rather than merely discouraged in prose.

export const ANOMALY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["deviations", "signatures", "normal_surfaces", "first_deviation", "degraded"],
  properties: {
    deviations: {
      type: "array",
      description:
        "Every place and time the system deviates from baseline in the mission's window. A deviation with no " +
        "evidence_refs is a guess, never include one.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["where", "shape", "evidence_refs"],
        properties: {
          where: {
            type: "string",
            minLength: 1,
            description: "Which signal or surface deviates — a service, an endpoint, a queue, a resource.",
          },
          shape: {
            type: "string",
            minLength: 1,
            description:
              "What the deviation looks like — a spike, a drop, a new error signature, a saturation curve.",
          },
          evidence_refs: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
            description:
              "At least one ref to an envelope you actually saw this call (search_events/fetch_changes) — " +
              "never a ref you were only told about, and never an invented one.",
          },
        },
      },
    },
    signatures: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Recurring error/log signatures found across the deviations, as plain strings.",
    },
    normal_surfaces: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description:
        "Surfaces/signals that stayed at baseline in this window — who is NOT affected is evidence too, and " +
        "narrows the hypothesis space exactly as much as a deviating surface does. Never left empty just " +
        "because nothing deviated there; name what you checked and found clean.",
    },
    first_deviation: {
      type: "string",
      description:
        "Which signal moved first, when several deviated — the ordering is often the causal lead. Empty " +
        "string when the window carries only one deviation, or ordering could not be determined from the " +
        "evidence seen.",
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
