// Task 9 (debugging design spec: docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md;
// spec PR #1501) — the regression pins for `triage` becoming Jace's
// DEBUGGER: one subagent, one output-schema UNION, two modes. These tests
// are the arbiter the task brief calls for: they prove the run-mode contract
// stayed byte-stable while the schema widened additively, and that the
// verdict-score hook keeps scoring run-mode outputs while skipping deep-mode
// ones (a ROUND_REPORT is not a run diagnosis).
//
// Three things are pinned here:
//   1. TRIAGE_SCHEMA itself is untouched (field-identical to the pre-Task-9
//      shape) — checked directly against its own declared fields.
//   2. DEBUGGER_SCHEMA's run-mode branch validates a REAL legacy run-mode
//      fixture (copied verbatim from triage.core.test.mjs's own
//      `groundedDiagnosis()`) with NO `mode` field at all, and ALSO with an
//      explicit `mode: "run"` — proving `mode` is accepted but never
//      required on that branch. A deep-mode ROUND_REPORT fixture validates
//      against the OTHER branch. The two branches stay field-disjoint
//      enough that a fixture only ever matches one.
//   3. `verdictValueFor` (agent/hooks/langfuse-verdict-score.ts) scores a
//      run-mode output exactly as before (mode absent or "run") and skips
//      scoring entirely for `mode: "deep"` — fed through the hook's own
//      parse path (JSON-string wire form included, mirroring issue #1197).
//
// The validator below is a MINIMAL, dependency-free JSON-Schema-subset
// interpreter — like triage.core.mjs's own `validateDiagnosis`, it is
// deliberately NOT a general JSON Schema engine (no $ref, no anyOf, no
// pattern — this repo has no ajv/schema-validator dependency anywhere,
// matching apps/jace's "no @agentrail/* imports, standalone npm install"
// posture). It supports exactly the constructs DEBUGGER_SCHEMA/
// ROUND_REPORT_SCHEMA/TRIAGE_SCHEMA use: type (object/array/string),
// required, properties, additionalProperties:false, items, minItems,
// minLength, enum, const, and a top-level oneOf.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TRIAGE_SCHEMA,
  DEBUGGER_SCHEMA,
  DEBUGGER_RUN_MODE_SCHEMA,
  ROUND_REPORT_SCHEMA,
} from "../agent/subagents/triage/lib/triage.core.mjs";

import {
  handleActionResult,
  verdictValueFor,
  __resetScoredForTests,
} from "../agent/hooks/langfuse-verdict-score.ts";
import { beforeEach } from "node:test";

beforeEach(() => __resetScoredForTests());

// ---------------------------------------------------------------------------
// Minimal JSON-Schema-subset validator (test-only — see file header).
// ---------------------------------------------------------------------------

function validateAgainstSchema(schema, data, path = "$") {
  if (schema.oneOf) {
    const results = schema.oneOf.map((s) => validateAgainstSchema(s, data, path));
    const passing = results.filter((r) => r.ok);
    if (passing.length !== 1) {
      return {
        ok: false,
        errors: [
          `${path}: expected exactly one oneOf branch to match, got ${passing.length}`,
          ...results.flatMap((r) => r.errors),
        ],
      };
    }
    return { ok: true, errors: [] };
  }

  const errors = [];

  if (schema.const !== undefined) {
    if (data !== schema.const) {
      errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`);
    }
    return { ok: errors.length === 0, errors };
  }

  if (schema.enum) {
    if (!schema.enum.includes(data)) {
      errors.push(`${path}: expected one of ${schema.enum.join(", ")}, got ${JSON.stringify(data)}`);
    }
    return { ok: errors.length === 0, errors };
  }

  if (schema.type === "string") {
    if (typeof data !== "string") {
      errors.push(`${path}: expected string, got ${typeof data}`);
    } else if (typeof schema.minLength === "number" && data.length < schema.minLength) {
      errors.push(`${path}: expected minLength ${schema.minLength}, got length ${data.length}`);
    }
    return { ok: errors.length === 0, errors };
  }

  if (schema.type === "object") {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, errors: [`${path}: expected object`] };
    }
    for (const key of schema.required ?? []) {
      if (!(key in data)) errors.push(`${path}: missing required "${key}"`);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(data)) {
        if (!allowed.has(key)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
    for (const [key, subschema] of Object.entries(schema.properties ?? {})) {
      if (key in data) {
        const res = validateAgainstSchema(subschema, data[key], `${path}.${key}`);
        errors.push(...res.errors);
      }
    }
    return { ok: errors.length === 0, errors };
  }

  if (schema.type === "array") {
    if (!Array.isArray(data)) return { ok: false, errors: [`${path}: expected array`] };
    if (typeof schema.minItems === "number" && data.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} items, got ${data.length}`);
    }
    if (schema.items) {
      data.forEach((item, i) => {
        const res = validateAgainstSchema(schema.items, item, `${path}[${i}]`);
        errors.push(...res.errors);
      });
    }
    return { ok: errors.length === 0, errors };
  }

  return { ok: false, errors: [`${path}: unsupported schema node ${JSON.stringify(schema)}`] };
}

function validate(schema, data) {
  return validateAgainstSchema(schema, data).ok;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Copied verbatim from triage.core.test.mjs's own `groundedDiagnosis()` — a
// REAL legacy run-mode output, exactly the pre-Task-9 shape (no `mode` field
// at all).
function legacyRunModeOutput() {
  return {
    diagnosis:
      "The verify gate failed: the login test expected 200 but the endpoint " +
      "returned 500 on a missing 'token' key.",
    what_was_tried: ["Ran the build phase", "Ran the verify phase (pytest)"],
    blocking_reason: "verify gate verdict: fail (1 test red)",
    suggested_next_action: "Retry on a stronger tier or hand back with the KeyError as the lead.",
    evidence_refs: [
      { source: "failure_events", quote: "test_login asserts 200 but got 500" },
      { source: "review_gates", quote: "verify: fail" },
    ],
  };
}

function roundReportFixture() {
  return {
    mode: "deep",
    round_summary:
      "Swept changes and anomalies in the 30-minute window around the checkout 500 spike; one deploy landed " +
      "just before the spike began.",
    findings: [
      {
        claim: "Deploy of PR #212 landed 4 minutes before the checkout error rate began climbing.",
        evidence_refs: ["ev_github_1"],
      },
    ],
    proposed_hypotheses: [
      {
        statement: "Connection pool exhaustion under the checkout path PR #212 touched.",
        mechanism: "PR #212 removed a pool-size cap, so concurrent checkout requests starve the pool under load.",
        proposed_state: "open",
        evidence_refs: ["ev_github_1"],
        what_would_settle_it: "Pool saturation metrics during the incident window.",
      },
    ],
    evidence_gaps: ["No metrics provider connected for this workspace — cannot confirm pool saturation directly."],
    suggested_next: "Connect a metrics provider, or narrow with a search_events query for pool-related errors.",
  };
}

// ---------------------------------------------------------------------------
// 1. TRIAGE_SCHEMA is untouched
// ---------------------------------------------------------------------------

test("TRIAGE_SCHEMA is unchanged: same five required fields, still additionalProperties:false", () => {
  assert.equal(TRIAGE_SCHEMA.type, "object");
  assert.equal(TRIAGE_SCHEMA.additionalProperties, false);
  assert.deepEqual(TRIAGE_SCHEMA.required.sort(), [
    "blocking_reason",
    "diagnosis",
    "evidence_refs",
    "suggested_next_action",
    "what_was_tried",
  ]);
  assert.equal("mode" in TRIAGE_SCHEMA.properties, false, "TRIAGE_SCHEMA itself must never gain a mode property");
});

// ---------------------------------------------------------------------------
// 2. DEBUGGER_SCHEMA — the regression pins from the task brief, verbatim
// ---------------------------------------------------------------------------

test("run-mode output validates against DEBUGGER_SCHEMA unchanged — no mode field required", () => {
  const legacy = legacyRunModeOutput();
  const res = validateAgainstSchema(DEBUGGER_SCHEMA, legacy);
  assert.ok(res.ok, `expected the legacy run-mode fixture to validate: ${res.errors.join("; ")}`);
});

test("a deep-mode ROUND_REPORT fixture validates against DEBUGGER_SCHEMA", () => {
  const res = validateAgainstSchema(DEBUGGER_SCHEMA, roundReportFixture());
  assert.ok(res.ok, `expected the round-report fixture to validate: ${res.errors.join("; ")}`);
});

test("a run-mode fixture with mode:'run' also validates against DEBUGGER_SCHEMA", () => {
  const withMode = { ...legacyRunModeOutput(), mode: "run" };
  const res = validateAgainstSchema(DEBUGGER_SCHEMA, withMode);
  assert.ok(res.ok, `expected mode:"run" fixture to validate: ${res.errors.join("; ")}`);
});

test("validate() helper convenience wrapper reads true/false", () => {
  assert.equal(validate(DEBUGGER_SCHEMA, legacyRunModeOutput()), true);
  assert.equal(validate(DEBUGGER_SCHEMA, roundReportFixture()), true);
  assert.equal(validate(DEBUGGER_SCHEMA, { nonsense: true }), false);
});

test("a run-shaped fixture with a mismatched mode value is rejected by BOTH branches (the union discriminates)", () => {
  // mode:"deep" on a fixture with run-mode fields (no round_summary/findings/
  // etc.) must fail ROUND_REPORT_SCHEMA (missing required fields) AND fail
  // DEBUGGER_RUN_MODE_SCHEMA (mode const mismatch) — proving the union
  // doesn't silently accept anything just because ONE field looks plausible.
  const mismatched = { ...legacyRunModeOutput(), mode: "deep" };
  const res = validateAgainstSchema(DEBUGGER_SCHEMA, mismatched);
  assert.equal(res.ok, false, "a run-shaped payload claiming mode:\"deep\" must not validate");
});

test("the run-mode branch of DEBUGGER_SCHEMA stays field-identical to TRIAGE_SCHEMA (drift guard)", () => {
  const triageFields = Object.keys(TRIAGE_SCHEMA.properties).sort();
  const runBranchFields = Object.keys(DEBUGGER_RUN_MODE_SCHEMA.properties)
    .filter((k) => k !== "mode")
    .sort();
  assert.deepEqual(
    runBranchFields,
    triageFields,
    "DEBUGGER_RUN_MODE_SCHEMA's fields (minus mode) must exactly match TRIAGE_SCHEMA's fields",
  );
  assert.deepEqual(
    [...DEBUGGER_RUN_MODE_SCHEMA.required].sort(),
    [...TRIAGE_SCHEMA.required].sort(),
    "the required set must match TRIAGE_SCHEMA's exactly",
  );
  assert.equal(
    DEBUGGER_RUN_MODE_SCHEMA.required.includes("mode"),
    false,
    "mode must never be required on the run-mode branch",
  );
  // The property SCHEMA OBJECTS themselves are the SAME reference (spread at
  // module-load time from TRIAGE_SCHEMA), so a future edit to TRIAGE_SCHEMA's
  // property shapes is picked up automatically — checked directly here.
  for (const field of triageFields) {
    assert.equal(
      DEBUGGER_RUN_MODE_SCHEMA.properties[field],
      TRIAGE_SCHEMA.properties[field],
      `DEBUGGER_RUN_MODE_SCHEMA.properties.${field} must be the SAME object as TRIAGE_SCHEMA's (not a re-typed copy)`,
    );
  }
});

test("ROUND_REPORT_SCHEMA requires the six pinned fields and mode is const 'deep'", () => {
  assert.equal(ROUND_REPORT_SCHEMA.type, "object");
  assert.equal(ROUND_REPORT_SCHEMA.additionalProperties, false);
  assert.deepEqual(ROUND_REPORT_SCHEMA.required.sort(), [
    "evidence_gaps",
    "findings",
    "mode",
    "proposed_hypotheses",
    "round_summary",
    "suggested_next",
  ]);
  assert.equal(ROUND_REPORT_SCHEMA.properties.mode.const, "deep");
  assert.equal(ROUND_REPORT_SCHEMA.properties.findings.items.properties.evidence_refs.minItems, 1);
  assert.deepEqual(ROUND_REPORT_SCHEMA.properties.proposed_hypotheses.items.properties.proposed_state.enum, [
    "open",
    "supported",
    "refuted",
    "inconclusive",
  ]);
  // proposed_hypotheses.evidence_refs deliberately carries NO minItems (an
  // open/inconclusive proposal may have no evidence yet) — pinned so a
  // future edit doesn't silently tighten this without a deliberate choice.
  assert.equal(
    ROUND_REPORT_SCHEMA.properties.proposed_hypotheses.items.properties.evidence_refs.minItems,
    undefined,
  );
});

test("a finding with an empty evidence_refs array is rejected (a claim needs at least one ref)", () => {
  const bad = roundReportFixture();
  bad.findings[0].evidence_refs = [];
  const res = validateAgainstSchema(DEBUGGER_SCHEMA, bad);
  assert.equal(res.ok, false);
});

test("a proposed hypothesis with an empty evidence_refs array is still valid (open/inconclusive may have none yet)", () => {
  const ok = roundReportFixture();
  ok.proposed_hypotheses[0].evidence_refs = [];
  ok.proposed_hypotheses[0].proposed_state = "open";
  const res = validateAgainstSchema(DEBUGGER_SCHEMA, ok);
  assert.ok(res.ok, `expected an empty-evidence open proposal to validate: ${res.errors.join("; ")}`);
});

// ---------------------------------------------------------------------------
// 3. verdict-score hook: scores run-mode, skips deep-mode
// ---------------------------------------------------------------------------

const FAKE_ENV = {
  LANGFUSE_PUBLIC_KEY: "pk-fake",
  LANGFUSE_SECRET_KEY: "sk-fake",
  LANGFUSE_BASE_URL: "https://fake.langfuse.example.com",
};
const FAKE_CTX = { session: { id: "sess_root_debugger" } };

function fakeFetch(responder = () => ({ ok: true, status: 200 })) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

function triageActionResultEvent(output, overrides = {}) {
  return {
    type: "action.result",
    data: {
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
      status: "completed",
      result: {
        kind: "subagent-result",
        callId: "call_triage_debugger_1",
        subagentName: "triage",
        output,
      },
      ...overrides,
    },
  };
}

test("verdictValueFor: triage mode:'deep' output -> undefined (a ROUND_REPORT is not a run diagnosis)", () => {
  assert.equal(verdictValueFor("triage", roundReportFixture()), undefined);
});

test("verdictValueFor: triage mode:'deep' guard also applies through the JSON-string wire form (#1197 shape)", () => {
  assert.equal(verdictValueFor("triage", JSON.stringify(roundReportFixture())), undefined);
});

test("verdictValueFor: triage run-mode output (no mode field) scores exactly as before", () => {
  assert.deepEqual(verdictValueFor("triage", legacyRunModeOutput()), {
    value: "blocked",
    dataType: "CATEGORICAL",
  });
});

test("verdictValueFor: triage run-mode output with explicit mode:'run' scores identically to the no-mode shape", () => {
  const withMode = verdictValueFor("triage", { ...legacyRunModeOutput(), mode: "run" });
  const withoutMode = verdictValueFor("triage", legacyRunModeOutput());
  assert.deepEqual(withMode, { value: "blocked", dataType: "CATEGORICAL" });
  assert.deepEqual(withMode, withoutMode);
});

test("verdict-score hook still scores run-mode and skips deep-mode — fed through the hook's own parse path", async () => {
  // Run mode (no mode field): scores exactly one call.
  const runFetch = fakeFetch();
  await handleActionResult(triageActionResultEvent(legacyRunModeOutput()), FAKE_CTX, {
    env: FAKE_ENV,
    fetchImpl: runFetch,
  });
  assert.equal(runFetch.calls.length, 1);
  const runBody = JSON.parse(runFetch.calls[0].init.body);
  assert.equal(runBody.name, "triage_verdict");
  assert.equal(runBody.value, "blocked");

  // Deep mode (mode: "deep"): zero calls — a round report gets no
  // triage_verdict score.
  const deepFetch = fakeFetch();
  await handleActionResult(
    triageActionResultEvent(roundReportFixture(), {
      result: {
        kind: "subagent-result",
        callId: "call_triage_debugger_2",
        subagentName: "triage",
        output: roundReportFixture(),
      },
    }),
    FAKE_CTX,
    { env: FAKE_ENV, fetchImpl: deepFetch },
  );
  assert.equal(deepFetch.calls.length, 0);
});

test("verdict-score hook: deep-mode skip also holds through the JSON-string wire form", async () => {
  const fetchImpl = fakeFetch();
  const event = triageActionResultEvent(null, {
    result: {
      kind: "subagent-result",
      callId: "call_triage_debugger_3",
      subagentName: "triage",
      output: JSON.stringify(roundReportFixture()),
    },
  });
  await handleActionResult(event, FAKE_CTX, { env: FAKE_ENV, fetchImpl });
  assert.equal(fetchImpl.calls.length, 0);
});

test("verdict-score hook: qa output is entirely unaffected by the triage mode guard", async () => {
  const fetchImpl = fakeFetch();
  const event = {
    type: "action.result",
    data: {
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
      status: "completed",
      result: {
        kind: "subagent-result",
        callId: "call_qa_debugger_1",
        subagentName: "qa",
        output: { verdict: "passed", mode: "deep" }, // qa has no mode concept at all — must not be guarded
      },
    },
  };
  await handleActionResult(event, FAKE_CTX, { env: FAKE_ENV, fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.name, "qa_verdict");
  assert.equal(body.value, "passed");
});
