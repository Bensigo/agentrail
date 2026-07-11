// Unit tests for the triage subagent's pure core (no SDK, no network, no model).
// Covers the diagnosis contract and the evidence-grounding invariants:
//  - AC2: a well-formed diagnosis over a real red-run bundle validates and its
//    citations resolve to populated sections.
//  - AC3: an empty/absent bundle reports every section missing with a where-to-
//    look note and NO fabricated cause, and a diagnosis that cites an
//    absent section is REJECTED (the anti-confabulation cross-check).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_SECTIONS,
  TRIAGE_SCHEMA,
  summarizeEvidence,
  describeMissingEvidence,
  validateDiagnosis,
  validateDiagnosisAgainstBundle,
} from "../agent/subagents/triage/lib/triage.core.mjs";

// A realistic red-run failure bundle (#1146 shape): a run row, a scrubbed logs
// excerpt, a failing verify gate, and a short timeline.
function redRunBundle() {
  return {
    run: {
      run_id: "run_abc123",
      status: "failed",
      phase: "verify",
      tier: "sonnet",
    },
    failure_events: [
      {
        kind: "logs_tail",
        text: "pytest: 1 failed — test_login asserts 200 but got 500 (KeyError: 'token')",
      },
    ],
    review_gates: [
      { gate_name: "verify", verdict: "fail", detail: "tests red: 1 failed" },
    ],
    timeline: [
      { event: "phase_start", phase: "build" },
      { event: "phase_start", phase: "verify" },
      { event: "gate_fail", phase: "verify" },
    ],
  };
}

// A well-formed diagnosis that cites only sections the red-run bundle carries.
function groundedDiagnosis() {
  return {
    diagnosis:
      "The verify gate failed: the login test expected 200 but the endpoint " +
      "returned 500 on a missing 'token' key.",
    what_was_tried: ["Ran the build phase", "Ran the verify phase (pytest)"],
    blocking_reason: "verify gate verdict: fail (1 test red)",
    suggested_next_action:
      "Retry on a stronger tier or hand back with the KeyError as the lead.",
    evidence_refs: [
      { source: "failure_events", quote: "test_login asserts 200 but got 500" },
      { source: "review_gates", quote: "verify: fail" },
    ],
  };
}

// ---------------------------------------------------------------------------
// TRIAGE_SCHEMA shape
// ---------------------------------------------------------------------------

test("TRIAGE_SCHEMA is a closed object requiring the five diagnosis fields", () => {
  assert.equal(TRIAGE_SCHEMA.type, "object");
  assert.equal(TRIAGE_SCHEMA.additionalProperties, false);
  assert.deepEqual(TRIAGE_SCHEMA.required.sort(), [
    "blocking_reason",
    "diagnosis",
    "evidence_refs",
    "suggested_next_action",
    "what_was_tried",
  ]);
  // evidence_refs.source is constrained to the four real bundle sections.
  assert.deepEqual(
    TRIAGE_SCHEMA.properties.evidence_refs.items.properties.source.enum,
    EVIDENCE_SECTIONS,
  );
  // blocking_reason permits "" (nothing blocks) — it carries no minLength.
  assert.equal(TRIAGE_SCHEMA.properties.blocking_reason.minLength, undefined);
  // diagnosis / suggested_next_action must be non-empty.
  assert.equal(TRIAGE_SCHEMA.properties.diagnosis.minLength, 1);
  assert.equal(TRIAGE_SCHEMA.properties.suggested_next_action.minLength, 1);
});

// ---------------------------------------------------------------------------
// summarizeEvidence — the present/missing split the model reasons over
// ---------------------------------------------------------------------------

test("summarizeEvidence reports every populated section of a red-run bundle (AC2)", () => {
  const { present, missing, note } = summarizeEvidence(redRunBundle());
  assert.deepEqual(present.sort(), [
    "failure_events",
    "review_gates",
    "run",
    "timeline",
  ]);
  assert.deepEqual(missing, []);
  assert.equal(note, ""); // nothing missing → no where-to-look note
});

test("summarizeEvidence treats an empty/absent bundle as all-sections-missing (AC3)", () => {
  for (const empty of [
    {},
    null,
    undefined,
    "not an object",
    { run: null, failure_events: [], review_gates: [], timeline: [] },
  ]) {
    const { present, missing, note } = summarizeEvidence(empty);
    assert.deepEqual(present, [], `present must be empty for ${JSON.stringify(empty)}`);
    assert.deepEqual(missing.sort(), [...EVIDENCE_SECTIONS].sort());
    // The note points a human at where to look, and NEVER states a cause.
    assert.match(note, /Evidence is incomplete\./);
    assert.match(note, /check/i);
  }
});

test("summarizeEvidence handles a partial bundle (some present, some missing)", () => {
  const partial = { run: { run_id: "r1", status: "failed" }, failure_events: [], review_gates: [], timeline: [] };
  const { present, missing } = summarizeEvidence(partial);
  assert.deepEqual(present, ["run"]);
  assert.deepEqual(missing.sort(), ["failure_events", "review_gates", "timeline"]);
});

// ---------------------------------------------------------------------------
// describeMissingEvidence — where-to-look, never a cause
// ---------------------------------------------------------------------------

test("describeMissingEvidence is empty when nothing is missing", () => {
  assert.equal(describeMissingEvidence([]), "");
  assert.equal(describeMissingEvidence(undefined), "");
  assert.equal(describeMissingEvidence("nope"), "");
});

test("describeMissingEvidence names each gap and where to look, with no cause language", () => {
  const note = describeMissingEvidence(["failure_events", "review_gates"]);
  assert.match(note, /Evidence is incomplete\./);
  assert.match(note, /failure_events/);
  assert.match(note, /review-gate/);
  // It is a structural pointer, never a guess at WHY the run failed.
  assert.doesNotMatch(note, /because|caused by|the run failed due to|root cause/i);
});

// ---------------------------------------------------------------------------
// validateDiagnosis — the schema invariants, checkable without an LLM
// ---------------------------------------------------------------------------

test("validateDiagnosis accepts a well-formed grounded diagnosis (AC2)", () => {
  const res = validateDiagnosis(groundedDiagnosis());
  assert.ok(res.ok, `expected valid, got: ${res.errors.join("; ")}`);
});

test("validateDiagnosis accepts an empty blocking_reason (nothing blocks = honest)", () => {
  const d = groundedDiagnosis();
  d.blocking_reason = ""; // transient red an auto-retry can clear
  d.evidence_refs = [{ source: "timeline", quote: "gate_fail then no further attempt" }];
  assert.ok(validateDiagnosis(d).ok);
});

test("validateDiagnosis rejects a fabricated/empty required field and a bad source enum", () => {
  const missingDiag = { ...groundedDiagnosis(), diagnosis: "" };
  assert.ok(!validateDiagnosis(missingDiag).ok);

  const badTried = { ...groundedDiagnosis(), what_was_tried: "ran tests" };
  assert.ok(!validateDiagnosis(badTried).ok);

  const emptyAction = { ...groundedDiagnosis(), suggested_next_action: "" };
  assert.ok(!validateDiagnosis(emptyAction).ok);

  const badSource = {
    ...groundedDiagnosis(),
    evidence_refs: [{ source: "stack_overflow", quote: "x" }],
  };
  assert.ok(!validateDiagnosis(badSource).ok);

  const emptyQuote = {
    ...groundedDiagnosis(),
    evidence_refs: [{ source: "run", quote: "" }],
  };
  assert.ok(!validateDiagnosis(emptyQuote).ok);

  assert.ok(!validateDiagnosis(null).ok);
  assert.ok(!validateDiagnosis([]).ok);
});

// ---------------------------------------------------------------------------
// validateDiagnosisAgainstBundle — the anti-confabulation cross-check (AC3)
// ---------------------------------------------------------------------------

test("a grounded diagnosis cross-checks OK against the bundle it cites (AC2)", () => {
  const res = validateDiagnosisAgainstBundle(groundedDiagnosis(), redRunBundle());
  assert.ok(res.ok, `expected grounded diagnosis to pass: ${res.errors.join("; ")}`);
});

test("a diagnosis citing an ABSENT section is rejected — no confabulation (AC3)", () => {
  // The bundle has NO failure_events / review_gates / timeline: only a run row.
  const thinBundle = { run: { run_id: "r9", status: "failed" }, failure_events: [], review_gates: [], timeline: [] };
  const fabricated = {
    diagnosis: "The tests failed on a null pointer in the login handler.",
    what_was_tried: ["Ran the verify phase"],
    blocking_reason: "verify gate: fail",
    suggested_next_action: "Retry on a stronger tier.",
    // Cites evidence that the bundle does NOT carry — the exact failure to catch.
    evidence_refs: [
      { source: "failure_events", quote: "NullPointerException in login" },
      { source: "review_gates", quote: "verify: fail" },
    ],
  };
  const res = validateDiagnosisAgainstBundle(fabricated, thinBundle);
  assert.ok(!res.ok, "a diagnosis citing absent sections must be rejected");
  assert.match(res.errors.join(" "), /failure_events/);
  assert.match(res.errors.join(" "), /review_gates/);
});

test("the HONEST answer for an empty bundle — no citations — cross-checks OK (AC3)", () => {
  const emptyBundle = {};
  const { note } = summarizeEvidence(emptyBundle);
  const honest = {
    diagnosis:
      "No failure evidence was recorded for this run, so the cause cannot be " +
      "determined from the bundle. " + note,
    what_was_tried: [],
    blocking_reason: "",
    suggested_next_action:
      "Check run-event ingestion and the runner's telemetry push for this run_id.",
    evidence_refs: [], // cannot cite what isn't there
  };
  const res = validateDiagnosisAgainstBundle(honest, emptyBundle);
  assert.ok(res.ok, `honest empty-evidence answer must validate: ${res.errors.join("; ")}`);
  // And it names what's missing / where to look, without inventing a cause.
  assert.match(honest.diagnosis, /Evidence is incomplete\./);
});
