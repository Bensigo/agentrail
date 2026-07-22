// Unit tests for the reviewer subagent's structured-output contract
// (REVIEW_SCHEMA + validateReview). No SDK, no I/O — mirrors
// qa.core.test.mjs / triage.core.test.mjs's shape: assert a well-formed
// review validates, and every coupling JSON Schema alone can't express
// (verdict<->findings/issueDrafts/degraded, escalate<->issueDrafts count)
// is enforced by the validator.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REVIEW_VERDICTS,
  REVIEW_SEVERITIES,
  MAX_FINDINGS,
  REVIEW_SCHEMA,
  validateReview,
} from "../agent/subagents/reviewer/lib/reviewer.core.mjs";

function finding(overrides = {}) {
  return {
    path: "src/index.ts",
    line: 12,
    severity: "major",
    finding: "Missing null check before dereferencing user.",
    suggestedComment: "This can throw if `user` is null — add a guard before accessing `user.name`.",
    escalate: false,
    ...overrides,
  };
}

function issueDraft(overrides = {}) {
  return {
    title: "Harden null handling in the widgets service",
    parent: "",
    requiredContext: "Grew out of a PR review finding a missing null guard.",
    whatToBuild: "Add defensive null checks across the widgets service's public entry points.",
    acceptanceCriteria: ["A request with a missing user field returns a 400, not a 500."],
    verificationEvidence: "A new test posts a request with no user and asserts a 400.",
    ...overrides,
  };
}

function reviewedReview(overrides = {}) {
  return {
    verdict: "reviewed",
    summary: "Solid change; one missing null check.",
    findings: [finding()],
    issueDrafts: [],
    degraded: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// REVIEW_SCHEMA shape sanity
// ---------------------------------------------------------------------------

test("REVIEW_SCHEMA declares the expected top-level required fields and enums", () => {
  assert.deepEqual(REVIEW_SCHEMA.required.sort(), ["degraded", "findings", "issueDrafts", "summary", "verdict"].sort());
  assert.deepEqual(REVIEW_VERDICTS, ["reviewed", "degraded"]);
  assert.deepEqual(REVIEW_SEVERITIES, ["blocker", "major", "minor", "nit"]);
  assert.equal(REVIEW_SCHEMA.properties.findings.maxItems, MAX_FINDINGS);
  assert.equal(MAX_FINDINGS, 10);
});

// ---------------------------------------------------------------------------
// validateReview — happy paths
// ---------------------------------------------------------------------------

test("validateReview accepts a well-formed 'reviewed' review with zero findings (a clean PR is a legitimate outcome)", () => {
  const result = validateReview(reviewedReview({ findings: [], issueDrafts: [] }));
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("validateReview accepts a well-formed 'reviewed' review with findings and no escalation", () => {
  const result = validateReview(reviewedReview());
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("validateReview accepts escalate:true findings paired 1:1 with issueDrafts, in order", () => {
  const result = validateReview(
    reviewedReview({
      findings: [finding({ escalate: false }), finding({ escalate: true }), finding({ escalate: true })],
      issueDrafts: [issueDraft(), issueDraft({ title: "second draft" })],
    }),
  );
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("validateReview accepts a finding with line: null (a file-level finding)", () => {
  const result = validateReview(reviewedReview({ findings: [finding({ line: null })] }));
  assert.equal(result.ok, true);
});

test("validateReview accepts a well-formed 'degraded' review", () => {
  const result = validateReview({
    verdict: "degraded",
    summary: "Could not fetch the diff.",
    findings: [],
    issueDrafts: [],
    degraded: { reason: "not_found" },
  });
  assert.deepEqual(result, { ok: true, errors: [] });
});

// ---------------------------------------------------------------------------
// validateReview — structural failures
// ---------------------------------------------------------------------------

test("validateReview rejects a non-object", () => {
  for (const bad of [null, undefined, "string", 42, [], []]) {
    const result = validateReview(bad);
    assert.equal(result.ok, false);
  }
});

test("validateReview rejects an invalid verdict", () => {
  const result = validateReview(reviewedReview({ verdict: "approved" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /verdict must be one of/.test(e)));
});

test("validateReview rejects a blank summary", () => {
  const result = validateReview(reviewedReview({ summary: "" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /summary must be a non-empty string/.test(e)));
});

test("validateReview rejects more than MAX_FINDINGS findings", () => {
  const many = Array.from({ length: MAX_FINDINGS + 1 }, () => finding());
  const result = validateReview(reviewedReview({ findings: many }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /at most 10 entries/.test(e)));
});

test("validateReview rejects a finding with a bad severity, non-string path, non-number/null line, or non-boolean escalate", () => {
  for (const bad of [
    finding({ severity: "critical" }),
    finding({ path: "" }),
    finding({ line: "12" }),
    finding({ escalate: "yes" }),
    finding({ finding: "" }),
    finding({ suggestedComment: "" }),
  ]) {
    const result = validateReview(reviewedReview({ findings: [bad] }));
    assert.equal(result.ok, false, JSON.stringify(bad));
  }
});

test("validateReview rejects an issueDraft with a missing title, non-string parent/requiredContext, or empty acceptanceCriteria", () => {
  for (const bad of [
    issueDraft({ title: "" }),
    issueDraft({ parent: null }),
    issueDraft({ requiredContext: undefined }),
    issueDraft({ whatToBuild: "" }),
    issueDraft({ acceptanceCriteria: [] }),
    issueDraft({ acceptanceCriteria: [""] }),
    issueDraft({ acceptanceCriteria: "not an array" }),
    issueDraft({ verificationEvidence: "" }),
  ]) {
    const result = validateReview(
      reviewedReview({
        findings: [finding({ escalate: true })],
        issueDrafts: [bad],
      }),
    );
    assert.equal(result.ok, false, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// validateReview — verdict couplings (the anti-confabulation core)
// ---------------------------------------------------------------------------

test("validateReview rejects verdict 'degraded' with a null degraded", () => {
  const result = validateReview({
    verdict: "degraded",
    summary: "gap",
    findings: [],
    issueDrafts: [],
    degraded: null,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /requires a non-null degraded/.test(e)));
});

test("validateReview rejects verdict 'degraded' carrying any findings or issueDrafts", () => {
  const withFindings = validateReview({
    verdict: "degraded",
    summary: "gap",
    findings: [finding()],
    issueDrafts: [],
    degraded: { reason: "not_found" },
  });
  assert.equal(withFindings.ok, false);
  assert.ok(withFindings.errors.some((e) => /must carry zero findings/.test(e)));

  const withDrafts = validateReview({
    verdict: "degraded",
    summary: "gap",
    findings: [],
    issueDrafts: [issueDraft()],
    degraded: { reason: "not_found" },
  });
  assert.equal(withDrafts.ok, false);
  assert.ok(withDrafts.errors.some((e) => /must carry zero issueDrafts/.test(e)));
});

test("validateReview rejects a non-null degraded when verdict is 'reviewed'", () => {
  const result = validateReview(reviewedReview({ degraded: { reason: "not_found" } }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /degraded must be null unless verdict is 'degraded'/.test(e)));
});

test("validateReview rejects a degraded object with a blank reason", () => {
  const result = validateReview({
    verdict: "degraded",
    summary: "gap",
    findings: [],
    issueDrafts: [],
    degraded: { reason: "" },
  });
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// validateReview — escalate:true <-> issueDrafts count coupling
// ---------------------------------------------------------------------------

test("validateReview rejects a mismatch between escalate:true findings and issueDrafts count (fewer drafts than escalations)", () => {
  const result = validateReview(
    reviewedReview({
      findings: [finding({ escalate: true }), finding({ escalate: true })],
      issueDrafts: [issueDraft()],
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /must have exactly one matching issueDraft each/.test(e)));
});

test("validateReview rejects a mismatch between escalate:true findings and issueDrafts count (more drafts than escalations)", () => {
  const result = validateReview(
    reviewedReview({
      findings: [finding({ escalate: false })],
      issueDrafts: [issueDraft()],
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /must have exactly one matching issueDraft each/.test(e)));
});

test("validateReview accepts zero escalations and zero issueDrafts", () => {
  const result = validateReview(reviewedReview({ findings: [finding({ escalate: false })], issueDrafts: [] }));
  assert.equal(result.ok, true);
});
