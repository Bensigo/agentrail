// Contract tests for the QA advisory schema + validator (spec §5).
// The validator is the anti-confabulation gate: a finding with no evidence,
// a verdict that contradicts the findings list, or a suggests_issue with no
// draft must all be rejected.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  QA_SCHEMA,
  QA_VERDICTS,
  QA_SURFACES,
  QA_SEVERITIES,
  validateAdvisory,
} from "../agent/subagents/qa/lib/qa.core.mjs";

function validFinding(overrides = {}) {
  return {
    title: "Save button 500s on the settings page",
    severity: "high",
    route: "/settings",
    repro_steps: ["Open /settings", "Change display name", "Click Save"],
    observed: "Toast shows 'Something went wrong'; network tab shows POST /api/settings -> 500",
    expected: "Settings persist and the page confirms the save",
    suggests_issue: true,
    issue_draft: {
      title: "Settings save returns 500",
      body: "## What happens\nPOST /api/settings returns 500.\n## Repro\n1. Open /settings\n2. Click Save\n## Expected\nSave succeeds.\n## Evidence\nnetwork: POST /api/settings -> 500",
    },
    ...overrides,
  };
}

function validAdvisory(overrides = {}) {
  return {
    verdict: "issues_found",
    summary: "Settings page save flow is broken; dashboard unaffected.",
    tested: [
      { surface: "ui", target: "/settings", result: "save flow fails with a 500" },
      { surface: "api", target: "GET /api/health", result: "200 ok" },
    ],
    findings: [validFinding()],
    not_verifiable_reason: null,
    evidence_refs: [
      "snapshot of /settings after Save click",
      "network: POST /api/settings -> 500",
      "web_fetch: GET /api/health -> 200",
    ],
    ...overrides,
  };
}

test("QA_SCHEMA is a closed object schema with the six contract fields", () => {
  assert.equal(QA_SCHEMA.type, "object");
  assert.equal(QA_SCHEMA.additionalProperties, false);
  assert.deepEqual(
    [...QA_SCHEMA.required].sort(),
    ["evidence_refs", "findings", "not_verifiable_reason", "summary", "tested", "verdict"],
  );
  assert.deepEqual(QA_SCHEMA.properties.verdict.enum, QA_VERDICTS);
  assert.deepEqual(QA_SCHEMA.properties.tested.items.properties.surface.enum, QA_SURFACES);
  assert.deepEqual(QA_SCHEMA.properties.findings.items.properties.severity.enum, QA_SEVERITIES);
});

test("a grounded advisory validates", () => {
  const result = validateAdvisory(validAdvisory());
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("a passed advisory with no findings validates", () => {
  const result = validateAdvisory(
    validAdvisory({ verdict: "passed", findings: [], evidence_refs: ["snapshot of /settings"] }),
  );
  assert.equal(result.ok, true);
});

test("a not_verifiable advisory with a reason validates", () => {
  const result = validateAdvisory(
    validAdvisory({
      verdict: "not_verifiable",
      findings: [],
      not_verifiable_reason: "No app base URL was provided in the task.",
      tested: [],
      evidence_refs: [],
    }),
  );
  assert.equal(result.ok, true);
});

test("rejects non-object advisories", () => {
  for (const bad of [null, undefined, "x", 42, []]) {
    assert.equal(validateAdvisory(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test("rejects an unknown verdict", () => {
  const result = validateAdvisory(validAdvisory({ verdict: "maybe" }));
  assert.equal(result.ok, false);
});

test("rejects issues_found with zero findings", () => {
  const result = validateAdvisory(validAdvisory({ findings: [] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("issues_found")));
});

test("rejects passed with findings attached", () => {
  const result = validateAdvisory(validAdvisory({ verdict: "passed" }));
  assert.equal(result.ok, false);
});

test("rejects not_verifiable without a reason", () => {
  const result = validateAdvisory(
    validAdvisory({ verdict: "not_verifiable", findings: [], not_verifiable_reason: null }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("not_verifiable_reason")));
});

test("rejects a non-null reason on other verdicts", () => {
  const result = validateAdvisory(validAdvisory({ not_verifiable_reason: "but it failed" }));
  assert.equal(result.ok, false);
});

test("rejects a finding with empty repro_steps", () => {
  const result = validateAdvisory(
    validAdvisory({ findings: [validFinding({ repro_steps: [] })] }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("repro_steps")));
});

test("rejects a finding with empty observed", () => {
  const result = validateAdvisory(validAdvisory({ findings: [validFinding({ observed: "" })] }));
  assert.equal(result.ok, false);
});

test("rejects an invalid severity", () => {
  const result = validateAdvisory(
    validAdvisory({ findings: [validFinding({ severity: "catastrophic" })] }),
  );
  assert.equal(result.ok, false);
});

test("rejects suggests_issue without an issue_draft", () => {
  const result = validateAdvisory(
    validAdvisory({ findings: [validFinding({ issue_draft: null })] }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("issue_draft")));
});

test("accepts suggests_issue false with a null draft", () => {
  const result = validateAdvisory(
    validAdvisory({ findings: [validFinding({ suggests_issue: false, issue_draft: null })] }),
  );
  assert.equal(result.ok, true);
});

test("rejects an issue_draft missing title or body", () => {
  const result = validateAdvisory(
    validAdvisory({
      findings: [validFinding({ issue_draft: { title: "", body: "b" } })],
    }),
  );
  assert.equal(result.ok, false);
});

test("rejects findings with zero evidence_refs — no observation, no finding", () => {
  const result = validateAdvisory(validAdvisory({ evidence_refs: [] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("evidence_ref")));
});

test("rejects malformed tested entries", () => {
  const result = validateAdvisory(
    validAdvisory({ tested: [{ surface: "cli", target: "", result: "" }] }),
  );
  assert.equal(result.ok, false);
});
