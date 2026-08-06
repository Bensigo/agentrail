// Unit tests for the reviewer subagent's structured-output contract
// (REVIEW_SCHEMA + validateReview). No SDK, no I/O — mirrors
// qa.core.test.mjs / triage.core.test.mjs's shape: assert a well-formed
// review validates, and every coupling JSON Schema alone can't express
// (verdict<->findings/issueDrafts/degraded, escalate<->issueDrafts count,
// investigated<->judgment) is enforced by the validator.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REVIEW_VERDICTS,
  REVIEW_SEVERITIES,
  MAX_FINDINGS,
  AC_COVERAGE_STATUSES,
  MAX_AC_COVERAGE,
  INVESTIGATION_TOOLS,
  MAX_INVESTIGATED,
  JUDGMENT_FIELDS,
  JUDGMENT_VERDICTS,
  GROUNDED_VERDICTS,
  REVIEW_SCHEMA,
  validateReview,
} from "../legacy/reviewer/lib/reviewer.core.mjs";

function finding(overrides = {}) {
  return {
    id: "f1",
    path: "src/index.ts",
    line: 12,
    severity: "major",
    finding: "Missing null check before dereferencing user.",
    suggestedComment: "This can throw if `user` is null — add a guard before accessing `user.name`.",
    escalate: false,
    ...overrides,
  };
}

function acEntry(overrides = {}) {
  return {
    issueNumber: 42,
    criterion: "AC1: widgets persist across restarts",
    status: "addressed",
    evidence: "persistence write added in src/store.ts hunk",
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

function investigatedEntry(overrides = {}) {
  return {
    id: "i1",
    question: "Does this pattern already exist elsewhere in the repo?",
    tool: "search_code",
    answer: "Found 3 other call sites using the same pattern.",
    ...overrides,
  };
}

// One judgment sub-field, defaulting to a POSITIVE (non-grounded) verdict
// with empty note/basis — the honest baseline that requires no citation.
function judgmentField(overrides = {}) {
  return {
    verdict: "yes",
    note: "",
    basis: [],
    ...overrides,
  };
}

// A full, all-positive judgment block — the honest "nothing to report" case.
function validJudgment(overrides = {}) {
  return {
    simplest: judgmentField({ verdict: "yes" }),
    architecture: judgmentField({ verdict: "consistent" }),
    debt: judgmentField({ verdict: "none_found" }),
    hiddenRisks: judgmentField({ verdict: "none_found" }),
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
    acCoverage: null,
    headSha: "",
    investigated: [],
    judgment: validJudgment(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// REVIEW_SCHEMA shape sanity
// ---------------------------------------------------------------------------

test("REVIEW_SCHEMA declares the expected top-level required fields and enums", () => {
  assert.deepEqual(
    REVIEW_SCHEMA.required.sort(),
    ["acCoverage", "degraded", "findings", "headSha", "investigated", "issueDrafts", "judgment", "summary", "verdict"].sort(),
  );
  assert.deepEqual(REVIEW_VERDICTS, ["reviewed", "degraded"]);
  assert.deepEqual(REVIEW_SEVERITIES, ["blocker", "major", "minor", "nit"]);
  assert.equal(REVIEW_SCHEMA.properties.findings.maxItems, MAX_FINDINGS);
  assert.equal(MAX_FINDINGS, 10);
});

test("REVIEW_SCHEMA findings items require an id matching ^f\\d+$", () => {
  assert.ok(REVIEW_SCHEMA.properties.findings.items.required.includes("id"));
  assert.equal(REVIEW_SCHEMA.properties.findings.items.properties.id.pattern, "^f\\d+$");
});

test("the investigation tool vocabulary includes reviewer suppression lookup, matching the schema enum", () => {
  assert.deepEqual(INVESTIGATION_TOOLS, ["search_code", "read_repo_file", "file_history", "fetch_wiki", "reviewer_suppressions"]);
  assert.deepEqual(REVIEW_SCHEMA.properties.investigated.items.properties.tool.enum, INVESTIGATION_TOOLS);
});

test("the judgment field vocabulary is exactly simplest|architecture|debt|hiddenRisks", () => {
  assert.deepEqual(JUDGMENT_FIELDS, ["simplest", "architecture", "debt", "hiddenRisks"]);
});

test("each judgment field's verdict vocabulary is pinned exactly", () => {
  assert.deepEqual(JUDGMENT_VERDICTS.simplest, ["yes", "no", "cannot_judge"]);
  assert.deepEqual(JUDGMENT_VERDICTS.architecture, ["consistent", "violates", "no_decision_found", "cannot_judge"]);
  assert.deepEqual(JUDGMENT_VERDICTS.debt, ["none_found", "introduces", "cannot_judge"]);
  assert.deepEqual(JUDGMENT_VERDICTS.hiddenRisks, ["none_found", "found", "cannot_judge"]);
});

test("the grounded (negative) verdict per judgment field is pinned exactly", () => {
  assert.deepEqual(GROUNDED_VERDICTS, {
    simplest: "no",
    architecture: "violates",
    debt: "introduces",
    hiddenRisks: "found",
  });
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
      findings: [
        finding({ id: "f1", escalate: false }),
        finding({ id: "f2", escalate: true }),
        finding({ id: "f3", escalate: true }),
      ],
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
    acCoverage: null,
    headSha: "",
    investigated: [],
    judgment: null,
  });
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("validateReview accepts positive (non-grounded) judgment verdicts with empty note and basis on every field", () => {
  const result = validateReview(reviewedReview({ judgment: validJudgment() }));
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("validateReview accepts cannot_judge for every field with empty note and basis", () => {
  const result = validateReview(
    reviewedReview({
      judgment: {
        simplest: judgmentField({ verdict: "cannot_judge" }),
        architecture: judgmentField({ verdict: "cannot_judge" }),
        debt: judgmentField({ verdict: "cannot_judge" }),
        hiddenRisks: judgmentField({ verdict: "cannot_judge" }),
      },
    }),
  );
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("validateReview accepts a grounded verdict with a note and basis citing a real investigated id, per field", () => {
  for (const field of JUDGMENT_FIELDS) {
    const result = validateReview(
      reviewedReview({
        investigated: [investigatedEntry({ id: "i1" })],
        judgment: validJudgment({
          [field]: judgmentField({
            verdict: GROUNDED_VERDICTS[field],
            note: "Found a real, specific issue.",
            basis: ["i1"],
          }),
        }),
      }),
    );
    assert.deepEqual(result, { ok: true, errors: [] }, field);
  }
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
  const many = Array.from({ length: MAX_FINDINGS + 1 }, (_, i) => finding({ id: `f${i + 1}` }));
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

test("validateReview rejects a finding id that doesn't match ^f\\d+$", () => {
  for (const bad of ["1", "F1", "f", "f1a"]) {
    const result = validateReview(reviewedReview({ findings: [finding({ id: bad })] }));
    assert.equal(result.ok, false, bad);
    assert.ok(result.errors.some((e) => /findings\[0\]\.id must match/.test(e)), bad);
  }
});

test("validateReview rejects duplicate finding ids", () => {
  const result = validateReview(
    reviewedReview({
      findings: [finding({ id: "f1", escalate: false }), finding({ id: "f1", escalate: false })],
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /findings\[1\]\.id 'f1' is not unique/.test(e)));
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
// validateReview — headSha
// ---------------------------------------------------------------------------

test("validateReview requires headSha to be a string ('' when unknown)", () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    const result = validateReview(reviewedReview({ headSha: bad }));
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.ok(result.errors.some((e) => /headSha must be a string/.test(e)), JSON.stringify(bad));
  }
});

test("validateReview accepts headSha as an empty string or a real sha", () => {
  assert.deepEqual(validateReview(reviewedReview({ headSha: "" })), { ok: true, errors: [] });
  assert.deepEqual(validateReview(reviewedReview({ headSha: "abc123def456" })), { ok: true, errors: [] });
});

// ---------------------------------------------------------------------------
// validateReview — investigated (the investigation trail)
// ---------------------------------------------------------------------------

test("validateReview rejects a non-array investigated", () => {
  for (const bad of ["nope", {}, 5, null]) {
    const result = validateReview(reviewedReview({ investigated: bad }));
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.ok(result.errors.some((e) => /investigated must be an array/.test(e)), JSON.stringify(bad));
  }
});

test("validateReview rejects a non-object investigated entry", () => {
  const result = validateReview(reviewedReview({ investigated: [null] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("investigated[0] must be an object")));
});

test("validateReview rejects an investigated entry with a blank question or answer", () => {
  for (const bad of [investigatedEntry({ question: "" }), investigatedEntry({ answer: "" })]) {
    const result = validateReview(reviewedReview({ investigated: [bad] }));
    assert.equal(result.ok, false, JSON.stringify(bad));
  }
});

test("validateReview rejects an investigated entry with a tool outside INVESTIGATION_TOOLS", () => {
  const result = validateReview(reviewedReview({ investigated: [investigatedEntry({ tool: "run_shell" })] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /investigated\[0\]\.tool must be one of/.test(e)));
});

test("validateReview rejects investigated ids that don't match ^i\\d+$", () => {
  for (const bad of ["1", "I1", "i", "i1a", "i-1"]) {
    const result = validateReview(reviewedReview({ investigated: [investigatedEntry({ id: bad })] }));
    assert.equal(result.ok, false, bad);
    assert.ok(result.errors.some((e) => /investigated\[0\]\.id must match/.test(e)), bad);
  }
});

test("validateReview rejects duplicate investigated ids", () => {
  const result = validateReview(
    reviewedReview({ investigated: [investigatedEntry({ id: "i1" }), investigatedEntry({ id: "i1" })] }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /investigated\[1\]\.id 'i1' is not unique/.test(e)));
});

test(`investigated is capped at ${MAX_INVESTIGATED} entries, matching the schema's maxItems (MAX_INVESTIGATED literal pin)`, () => {
  assert.equal(MAX_INVESTIGATED, 20);
  assert.equal(REVIEW_SCHEMA.properties.investigated.maxItems, MAX_INVESTIGATED);

  const atMax = Array.from({ length: MAX_INVESTIGATED }, (_, i) => investigatedEntry({ id: `i${i + 1}` }));
  assert.deepEqual(validateReview(reviewedReview({ investigated: atMax })), { ok: true, errors: [] });

  const overMax = Array.from({ length: MAX_INVESTIGATED + 1 }, (_, i) => investigatedEntry({ id: `i${i + 1}` }));
  const badResult = validateReview(reviewedReview({ investigated: overMax }));
  assert.equal(badResult.ok, false);
  assert.ok(badResult.errors.some((e) => e.includes(`at most ${MAX_INVESTIGATED} entries`)));
});

test("judgment basis is capped at 5 entries per field, matching the schema's maxItems (basis-cap literal pin)", () => {
  for (const field of JUDGMENT_FIELDS) {
    assert.equal(REVIEW_SCHEMA.properties.judgment.properties[field].properties.basis.maxItems, 5, field);
  }

  // One over-cap rejection, mirroring the MAX_INVESTIGATED pin above — the
  // full malformed-basis sweep (non-array, non-string items, over-cap) already
  // lives in "validateReview rejects a judgment basis that isn't an array of
  // at most 5 strings"; this just proves the literal pinned above is the
  // number the validator actually enforces.
  const overCap = Array.from({ length: 6 }, (_, i) => `i${i + 1}`);
  const result = validateReview(
    reviewedReview({ judgment: validJudgment({ simplest: judgmentField({ basis: overCap }) }) }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /judgment\.simplest\.basis must be an array of at most 5 strings/.test(e)));
});

// ---------------------------------------------------------------------------
// validateReview — judgment (the grounded judgment block)
// ---------------------------------------------------------------------------

test("validateReview rejects a judgment that is neither an object nor null", () => {
  for (const bad of ["nope", 5, true, []]) {
    const result = validateReview(reviewedReview({ judgment: bad }));
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.ok(result.errors.some((e) => /judgment must be an object or null/.test(e)), JSON.stringify(bad));
  }
});

test("validateReview rejects a judgment missing one of the four required fields", () => {
  for (const bad of [undefined, null, "no", []]) {
    const judgment = validJudgment();
    judgment.simplest = bad;
    const result = validateReview(reviewedReview({ judgment }));
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.ok(result.errors.some((e) => e.includes("judgment.simplest must be an object")), JSON.stringify(bad));
  }
});

test("validateReview rejects an invalid verdict value for a judgment field", () => {
  const result = validateReview(
    reviewedReview({ judgment: validJudgment({ simplest: judgmentField({ verdict: "maybe" }) }) }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /judgment\.simplest\.verdict must be one of/.test(e)));
});

test("validateReview rejects a non-string judgment note", () => {
  const result = validateReview(reviewedReview({ judgment: validJudgment({ simplest: judgmentField({ note: 5 }) }) }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /judgment\.simplest\.note must be a string/.test(e)));
});

test("validateReview rejects a judgment basis that isn't an array of at most 5 strings", () => {
  for (const bad of ["not an array", [1, 2], Array.from({ length: 6 }, (_, i) => `i${i + 1}`)]) {
    const result = validateReview(
      reviewedReview({ judgment: validJudgment({ simplest: judgmentField({ basis: bad }) }) }),
    );
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.ok(
      result.errors.some((e) => /judgment\.simplest\.basis must be an array of at most 5 strings/.test(e)),
      JSON.stringify(bad),
    );
  }
});

test("validateReview rejects a grounded verdict with an empty basis, per field (no investigation, no claim)", () => {
  for (const field of JUDGMENT_FIELDS) {
    const result = validateReview(
      reviewedReview({
        judgment: validJudgment({
          [field]: judgmentField({ verdict: GROUNDED_VERDICTS[field], note: "Found a real issue.", basis: [] }),
        }),
      }),
    );
    assert.equal(result.ok, false, field);
    assert.ok(
      result.errors.some((e) => e.includes(`judgment.${field}`) && /requires a non-empty basis/.test(e)),
      field,
    );
  }
});

test("validateReview rejects a grounded verdict with a blank note, per field", () => {
  for (const field of JUDGMENT_FIELDS) {
    const result = validateReview(
      reviewedReview({
        investigated: [investigatedEntry({ id: "i1" })],
        judgment: validJudgment({
          [field]: judgmentField({ verdict: GROUNDED_VERDICTS[field], note: "", basis: ["i1"] }),
        }),
      }),
    );
    assert.equal(result.ok, false, field);
    assert.ok(
      result.errors.some((e) => e.includes(`judgment.${field}`) && /requires a non-empty note/.test(e)),
      field,
    );
  }
});

test("validateReview rejects a grounded verdict whose basis cites an id not present in investigated", () => {
  const result = validateReview(
    reviewedReview({
      investigated: [investigatedEntry({ id: "i1" })],
      judgment: validJudgment({
        simplest: judgmentField({ verdict: "no", note: "Not the simplest approach.", basis: ["i99"] }),
      }),
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /judgment\.simplest\.basis references unknown investigated id 'i99'/.test(e)));
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

test("validateReview rejects a degraded verdict carrying a non-null judgment", () => {
  const result = validateReview({
    verdict: "degraded",
    summary: "Could not fetch the diff.",
    findings: [],
    issueDrafts: [],
    degraded: { reason: "not_found" },
    acCoverage: null,
    headSha: "",
    investigated: [],
    judgment: validJudgment(),
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /judgment/.test(e) && /degraded/i.test(e)));
});

test("validateReview rejects a degraded verdict carrying non-empty investigated", () => {
  const result = validateReview({
    verdict: "degraded",
    summary: "Could not fetch the diff.",
    findings: [],
    issueDrafts: [],
    degraded: { reason: "not_found" },
    acCoverage: null,
    headSha: "",
    investigated: [investigatedEntry()],
    judgment: null,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /investigated must be empty — the diff was never read/.test(e)));
});

test("validateReview rejects a 'reviewed' verdict with a missing or null judgment", () => {
  for (const bad of [null, undefined]) {
    const review = reviewedReview({ judgment: bad });
    if (bad === undefined) delete review.judgment;
    const result = validateReview(review);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.ok(
      result.errors.some((e) => /judgment must be an object unless verdict is 'degraded'/.test(e)),
      JSON.stringify(bad),
    );
  }
});

// ---------------------------------------------------------------------------
// validateReview — escalate:true <-> issueDrafts count coupling
// ---------------------------------------------------------------------------

test("validateReview rejects a mismatch between escalate:true findings and issueDrafts count (fewer drafts than escalations)", () => {
  const result = validateReview(
    reviewedReview({
      findings: [finding({ id: "f1", escalate: true }), finding({ id: "f2", escalate: true })],
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

// ---------------------------------------------------------------------------
// validateReview — acCoverage (per-AC diff coverage)
// ---------------------------------------------------------------------------

test("a review with issue-sourced and PR-description-sourced coverage entries validates", () => {
  const review = reviewedReview({
    acCoverage: [acEntry(), acEntry({ issueNumber: null, status: "not_in_diff", evidence: "" })],
  });
  const { ok, errors } = validateReview(review);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test("acCoverage: null validates (no usable ACs)", () => {
  const { ok } = validateReview(reviewedReview({ acCoverage: null }));
  assert.equal(ok, true);
});

test("a missing acCoverage key is rejected — the field is required", () => {
  const review = reviewedReview();
  delete review.acCoverage;
  const { ok, errors } = validateReview(review);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("acCoverage")));
});

test("an unknown coverage status is rejected", () => {
  const { ok, errors } = validateReview(reviewedReview({ acCoverage: [acEntry({ status: "unmet" })] }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("status")));
});

test("issueNumber must be a number or null, criterion non-empty, evidence a string", () => {
  const bad = reviewedReview({
    acCoverage: [acEntry({ issueNumber: "42", criterion: "", evidence: 7 })],
  });
  const { ok, errors } = validateReview(bad);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("issueNumber")));
  assert.ok(errors.some((e) => e.includes("criterion")));
  assert.ok(errors.some((e) => e.includes("evidence")));
});

test(`acCoverage is capped at ${MAX_AC_COVERAGE} entries`, () => {
  const entries = Array.from({ length: MAX_AC_COVERAGE + 1 }, (_, i) =>
    acEntry({ criterion: `AC${i + 1}: thing ${i + 1}` })
  );
  const { ok, errors } = validateReview(reviewedReview({ acCoverage: entries }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes(`${MAX_AC_COVERAGE}`)));
});

test("a degraded verdict must carry acCoverage: null — the diff was never read", () => {
  const review = {
    verdict: "degraded",
    summary: "Could not fetch the diff.",
    findings: [],
    issueDrafts: [],
    degraded: { reason: "not_found" },
    acCoverage: [acEntry()],
  };
  const { ok, errors } = validateReview(review);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("acCoverage")));
});

test("the coverage vocabulary is exactly addressed|not_in_diff|unclear", () => {
  assert.deepEqual(AC_COVERAGE_STATUSES, ["addressed", "not_in_diff", "unclear"]);
});

test("validateReview rejects a non-object acCoverage entry", () => {
  const { ok, errors } = validateReview(reviewedReview({ acCoverage: [null] }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("acCoverage[0] must be an object")));
});

test("REVIEW_SCHEMA.properties.acCoverage.maxItems matches MAX_AC_COVERAGE", () => {
  assert.equal(REVIEW_SCHEMA.properties.acCoverage.maxItems, MAX_AC_COVERAGE);
});
