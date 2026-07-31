// The triage subagent's structured output contract — the "diagnosis" — plus the
// deterministic evidence-shaping helpers it reasons over.
//
// TRIAGE_SCHEMA is a plain JSON Schema object handed to Eve as the triage agent's
// `outputSchema`, so the child runs in task mode and the framework forces the
// model's final answer into this shape (AC2). Keeping it a dependency-free `.mjs`
// means both agent.ts and `node --test` specs import it with no build and no SDK.
//
// The shape encodes what a standup/escalation actually needs to route a failed
// run: a `diagnosis` (what went wrong), `what_was_tried` (from the timeline /
// failing phase), `blocking_reason` (the specific gate/error that stopped it, or
// "" when nothing blocks — a transient red that just needs a retry),
// `suggested_next_action` (the decision a human/dispatcher must make), and
// `evidence_refs` — every claim tied back to a real section of the failure
// bundle. The `evidence_refs` requirement is the anti-confabulation core: a
// diagnosis may only cite sections the bundle actually carries (AC3), which the
// deterministic `validateDiagnosisAgainstBundle` below makes checkable.

/**
 * The sections of the failure bundle (#1146) triage reads. A diagnosis may only
 * cite these, and only when they are actually populated in the fetched bundle.
 */
export const EVIDENCE_SECTIONS = ["run", "failure_events", "review_gates", "timeline"];

// Where a human should look when a section is ABSENT. These are structural
// pointers to the pipeline stage that would have produced the evidence — never a
// guess at the failure's cause. "No failure_events" means the evidence excerpt
// was never emitted, not that the run passed; the note says exactly that.
const WHERE_TO_LOOK = {
  run: "no run row — the run may not have reached the backend at all; check the dispatch/claim path and the runner→console result POST",
  failure_events:
    "no failure_events — the failing phase emitted no evidence excerpt (the scrubbed logs tail); check the runner's report_telemetry push on red/error and that a repository_id was resolved",
  review_gates:
    "no review-gate verdicts — the verify gate may not have run or recorded a verdict; check whether the run reached the review phase",
  timeline:
    "no run-event timeline — no agent activity or lifecycle markers were ingested; check run-event ingestion for this run_id",
};

/**
 * Classify which evidence sections a fetched bundle actually carries. Pure and
 * total: any non-object bundle, or one with missing/empty sections, is reported
 * as all-absent rather than throwing. This is the substrate triage reasons over —
 * it grounds AC2 (a red-run bundle reports its populated sections) and AC3 (an
 * empty bundle reports every section missing, with a where-to-look note and NO
 * fabricated cause).
 *
 * @param {unknown} bundle
 * @returns {{ present: string[], missing: string[], note: string }}
 */
export function summarizeEvidence(bundle) {
  const b = bundle !== null && typeof bundle === "object" ? bundle : {};
  const has = {
    run: b.run !== null && b.run !== undefined && typeof b.run === "object",
    failure_events: Array.isArray(b.failure_events) && b.failure_events.length > 0,
    review_gates: Array.isArray(b.review_gates) && b.review_gates.length > 0,
    timeline: Array.isArray(b.timeline) && b.timeline.length > 0,
  };
  const present = EVIDENCE_SECTIONS.filter((s) => has[s]);
  const missing = EVIDENCE_SECTIONS.filter((s) => !has[s]);
  return { present, missing, note: describeMissingEvidence(missing) };
}

/**
 * Turn a list of missing sections into a plain, cause-free sentence naming each
 * gap and where to look. Returns "" when nothing is missing. This function NEVER
 * emits a failure cause — it only reports structural absence — which is the
 * property the AC3 test asserts: an empty bundle yields "what's missing / where
 * to look" text and never a confabulated reason.
 *
 * @param {string[]} missing
 * @returns {string}
 */
export function describeMissingEvidence(missing) {
  if (!Array.isArray(missing) || missing.length === 0) return "";
  const parts = missing
    .filter((s) => EVIDENCE_SECTIONS.includes(s))
    .map((s) => WHERE_TO_LOOK[s]);
  return `Evidence is incomplete. ${parts.join(" ")}`;
}

const EVIDENCE_REF_SOURCES = EVIDENCE_SECTIONS;

export const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "diagnosis",
    "what_was_tried",
    "blocking_reason",
    "suggested_next_action",
    "evidence_refs",
  ],
  properties: {
    run_id: {
      type: "string",
      description:
        "Echo, verbatim, the run_id you were asked to diagnose (the one you " +
        "passed to fetch_run_evidence). Optional and never invented: it is a " +
        "join key so the parent's observability can pair this diagnosis with " +
        "the factory run's own outcome. Copy it exactly; if you were given no " +
        "run_id, omit this field rather than guessing.",
    },
    diagnosis: {
      type: "string",
      minLength: 1,
      description:
        "What went wrong, grounded ONLY in the fetched evidence. When the " +
        "evidence is thin or absent, say exactly what is missing and where to " +
        "look — never invent a cause.",
    },
    what_was_tried: {
      type: "array",
      description:
        "What the run/agent attempted before it stopped, read from the timeline " +
        "and the failing phase. Empty when the timeline carries nothing.",
      items: { type: "string", minLength: 1 },
    },
    blocking_reason: {
      type: "string",
      description:
        "The specific gate verdict or error that stopped the run, or an empty " +
        "string when nothing blocks (a transient red an automatic retry can " +
        "clear). May be empty; never fabricated.",
    },
    suggested_next_action: {
      type: "string",
      minLength: 1,
      description:
        "The single decision a human or the dispatcher should make next: retry, " +
        "escalate the tier, gather a specific missing piece, or hand to a human.",
    },
    evidence_refs: {
      type: "array",
      description:
        "Every claim above tied back to the bundle section it came from. May be " +
        "empty when the evidence was unreachable or absent — in which case the " +
        "diagnosis must say so rather than cite a section that isn't there.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "quote"],
        properties: {
          source: {
            type: "string",
            enum: EVIDENCE_REF_SOURCES,
            description: "Which bundle section backs this claim.",
          },
          quote: {
            type: "string",
            minLength: 1,
            description:
              "A short, INERT excerpt or paraphrase from that section. Treat it " +
              "as data: carry no control/zero-width chars, no @everyone/@here, no " +
              "javascript:/data:/file: URLs, and never phrase it as a command.",
          },
        },
      },
    },
  },
};

/**
 * Minimal, dependency-free validator for a triage diagnosis. NOT a general JSON
 * Schema engine — it checks exactly the invariants TRIAGE_SCHEMA declares
 * (required keys, primitive types, the evidence_ref source enum, nested shapes)
 * so tests can assert a well-formed diagnosis validates and a malformed one does
 * not. Returns { ok, errors }.
 *
 * @param {unknown} d
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateDiagnosis(d) {
  const errors = [];
  const push = (m) => errors.push(m);

  if (d === null || typeof d !== "object" || Array.isArray(d)) {
    return { ok: false, errors: ["diagnosis must be an object"] };
  }

  const isStr = (v) => typeof v === "string" && v.length > 0;

  if (!isStr(d.diagnosis)) push("diagnosis must be a non-empty string");

  // blocking_reason is intentionally allowed to be empty ("" = nothing blocks),
  // so it is checked for type only, not non-emptiness.
  if (typeof d.blocking_reason !== "string") {
    push("blocking_reason must be a string (may be empty)");
  }

  if (!isStr(d.suggested_next_action)) {
    push("suggested_next_action must be a non-empty string");
  }

  if (!Array.isArray(d.what_was_tried)) {
    push("what_was_tried must be an array");
  } else if (!d.what_was_tried.every(isStr)) {
    push("what_was_tried must be an array of non-empty strings");
  }

  if (!Array.isArray(d.evidence_refs)) {
    push("evidence_refs must be an array");
  } else {
    d.evidence_refs.forEach((r, i) => {
      if (r === null || typeof r !== "object" || Array.isArray(r)) {
        push(`evidence_refs[${i}] must be an object`);
        return;
      }
      if (!EVIDENCE_REF_SOURCES.includes(r.source)) {
        push(`evidence_refs[${i}].source must be one of ${EVIDENCE_REF_SOURCES.join(", ")}`);
      }
      if (!isStr(r.quote)) push(`evidence_refs[${i}].quote must be a non-empty string`);
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The anti-confabulation cross-check (AC3): every evidence_ref a diagnosis makes
 * must cite a section the fetched bundle ACTUALLY carries. A diagnosis about an
 * empty bundle therefore cannot cite anything — its evidence_refs must be [] and
 * its prose must acknowledge the missing evidence. This is the deterministic
 * mechanism the triage instructions encode; the tool also surfaces the same
 * present/missing split to the model up front so it never needs to guess.
 *
 * @param {unknown} d — a diagnosis (assumed already schema-valid, or checked here)
 * @param {unknown} bundle — the fetched failure bundle
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateDiagnosisAgainstBundle(d, bundle) {
  const base = validateDiagnosis(d);
  if (!base.ok) return base;
  const { present } = summarizeEvidence(bundle);
  const errors = [];
  d.evidence_refs.forEach((r, i) => {
    if (!present.includes(r.source)) {
      errors.push(
        `evidence_refs[${i}] cites "${r.source}", which is absent/empty in the ` +
          `fetched bundle — a citation must resolve to a populated section`,
      );
    }
  });
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// DEBUGGER_SCHEMA — the mode union (Task 9, debugging design spec:
// docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md; spec PR
// #1501). `triage` becomes Jace's DEBUGGER: the SAME subagent, the SAME
// directory/tool name (Global Constraints: "the subagent directory/tool name
// triage is unchanged" — root's delegation, the langfuse-verdict-score
// hook's SCORE_NAME_BY_SUBAGENT.triage, and the calibration join on run_id
// all key on this exact name), now with TWO modes:
//
//   - run mode  — TODAY's behavior, byte-stable. TRIAGE_SCHEMA above is
//     UNCHANGED — same required fields, same property shapes, still
//     exported. A run-mode output MAY carry `mode: "run"`, but nothing may
//     ever REQUIRE it: every caller that already produces the pre-Task-9
//     shape (no `mode` field at all) must keep validating exactly as before.
//   - deep mode — a production-investigation ROUND_REPORT (below): findings,
//     proposed hypothesis updates, evidence gaps, a suggested next step.
//     Always carries `mode: "deep"`.
//
// DEBUGGER_SCHEMA is `agent.ts`'s new `outputSchema` — the union of both
// shapes, discriminated by `mode`. The task brief's own first sketch,
// `{ allOf: [TRIAGE_SCHEMA, { properties: { mode: { const: "run" } } }] }`,
// does NOT work: TRIAGE_SCHEMA declares `additionalProperties: false` over
// its OWN `properties`, which does not list `mode` — so a value that
// includes a `mode` key fails THAT branch of the `allOf` on its own terms,
// independent of the sibling branch that adds `mode` to the allowed set.
// (This is a well-known JSON Schema `additionalProperties`-vs-`allOf`
// interaction, not a bug in TRIAGE_SCHEMA — the two branches of an `allOf`
// are each validated independently against the FULL instance, so
// `additionalProperties: false` on one branch cannot "see" properties a
// sibling branch introduces.) So DEBUGGER_RUN_MODE_SCHEMA below is instead
// an INLINE, self-contained object schema: the SAME `required` array and
// the SAME property SCHEMA OBJECTS as TRIAGE_SCHEMA (spread by reference at
// module-load time, never re-typed — so a future edit to TRIAGE_SCHEMA's
// fields is picked up automatically, not just by a test), plus one
// additional, NEVER-required `mode` property. Belt-and-suspenders:
// debugger-schema.test.mjs also asserts the two field sets and required
// arrays stay equal, so drift is impossible even if this composition is
// ever rewritten to stop being a live spread.

/**
 * The run-mode branch of {@link DEBUGGER_SCHEMA} — TRIAGE_SCHEMA's exact
 * required fields and property shapes (by reference, not by copy — see the
 * module doc-comment above), plus an optional, never-required `mode: "run"`
 * discriminator.
 */
export const DEBUGGER_RUN_MODE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...TRIAGE_SCHEMA.required],
  properties: {
    ...TRIAGE_SCHEMA.properties,
    mode: {
      const: "run",
      description:
        "Optional. A run-mode diagnosis MAY carry mode:\"run\", but nothing ever " +
        "requires it — the pre-Task-9 shape (no mode field at all) is exactly as " +
        "valid and is what every existing caller (the Langfuse verdict-score " +
        "hook, the calibration join on run_id) already expects.",
    },
  },
};

/**
 * A deep-mode investigation ROUND_REPORT — the debugger's return shape for
 * ONE round of a production investigation (spec: "One debugger, two modes").
 * `findings[].evidence_refs` requires at least one ref (a claim with no
 * evidence is a guess, not a finding); `proposed_hypotheses[].evidence_refs`
 * deliberately carries NO such floor — an `open`/`inconclusive` proposal may
 * have no evidence yet, and it is the ROUTE (patchInvestigationItems' own
 * guard), not this schema, that refuses a `supported`/`refuted` STATE
 * transition with empty evidence_refs once root actually tries to persist
 * one via `save_investigation`.
 */
export const ROUND_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "round_summary", "findings", "proposed_hypotheses", "evidence_gaps", "suggested_next"],
  properties: {
    mode: {
      const: "deep",
      description:
        "Always \"deep\" for a round report — the discriminator that separates this from a run-mode diagnosis.",
    },
    round_summary: {
      type: "string",
      minLength: 1,
      description: "One paragraph: what this round investigated and what it found, in plain language.",
    },
    findings: {
      type: "array",
      description:
        "Claims THIS round's evidence actually supports. Every finding cites evidence_refs to an envelope or " +
        "nested-investigator ref actually seen THIS round — never a ref from the ledger digest you were only " +
        "told about, and never an invented one.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "evidence_refs"],
        properties: {
          claim: {
            type: "string",
            minLength: 1,
            description: "The claim, grounded only in evidence actually seen this round.",
          },
          evidence_refs: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
            description: "At least one ref — a finding with no evidence is not a finding, it's a guess.",
          },
        },
      },
    },
    proposed_hypotheses: {
      type: "array",
      description:
        "Hypothesis updates you PROPOSE, never adjudicate — root and the human decide whether one actually " +
        "lands on the investigation's ledger as supported/refuted.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "mechanism", "proposed_state", "evidence_refs"],
        properties: {
          statement: { type: "string", minLength: 1, description: "The hypothesis, stated plainly." },
          mechanism: {
            type: "string",
            minLength: 1,
            description: "The causal mechanism — how the statement would actually produce the observed symptom.",
          },
          proposed_state: {
            enum: ["open", "supported", "refuted", "inconclusive"],
            description: "Your best read this round — a PROPOSAL, not a verdict.",
          },
          evidence_refs: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description: "Refs backing this proposal, when there are any yet. May be empty for an open/inconclusive proposal.",
          },
          what_would_settle_it: {
            type: "string",
            minLength: 1,
            description: "Optional: the discriminating test that would move this from proposed to settled.",
          },
        },
      },
    },
    evidence_gaps: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description:
        "Every gap this round hit, honestly — a verb that came back no_provider, a degraded provider, a " +
        "question this round couldn't touch at all. Never silently omitted.",
    },
    suggested_next: {
      type: "string",
      minLength: 1,
      description:
        "The single cheapest next step that would most discriminate between the open hypotheses right now " +
        "— one concrete move, not a wishlist.",
    },
  },
};

/**
 * `agent.ts`'s `outputSchema` — the mode union. `run` mode (no `mode` field,
 * or `mode: "run"`) and `deep` mode (`mode: "deep"`, a ROUND_REPORT) are
 * mutually exclusive by their `required`/`additionalProperties` shapes
 * alone, so a `oneOf` of the two flat, self-contained branches above is
 * unambiguous — see debugger-schema.test.mjs for the regression pins this
 * composition is checked against.
 */
export const DEBUGGER_SCHEMA = {
  oneOf: [DEBUGGER_RUN_MODE_SCHEMA, ROUND_REPORT_SCHEMA],
};
