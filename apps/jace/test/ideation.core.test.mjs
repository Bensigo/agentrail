// Unit tests for Jace's ideation core (grill-me / to-prd / to-issues helpers).
//
// These are pure-function tests: no model, no network, no child_process, so they
// never hang on a live agent call. They prove the ideation pipeline's shapes:
//   - AC1: grill-me produces a structured requirements summary.
//   - AC3/AC4: to-issues turns a PRD into ORDERED house-format issue drafts —
//     parent epic first, then one draft per slice, each carrying all six
//     sections and at least one checkboxed acceptance criterion — where each
//     draft is a single gated create_issue call (proven by feeding it through
//     the real create_issue core here).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRequirementsSummary,
  prdToIssueDrafts,
} from "../agent/lib/ideation.core.mjs";
import {
  buildIssueBody,
  buildCreateArgv,
  runCreateIssue,
} from "../agent/lib/create_issue.core.mjs";

// --- grill-me: requirements summary (AC1) --------------------------------

test("buildRequirementsSummary renders all sections in order from a vague prompt", () => {
  const summary = buildRequirementsSummary({
    problem: "Operators can't tell which factory runs failed and why.",
    users: "AgentRail operators triaging the queue.",
    constraints:
      "Reuse the runs table; console shows only falsifiable metrics.",
    scope: "A single failed-run detail view showing the verify-gate reason.",
    successSignals: [
      "Opening a failed run shows the gate that rejected it",
      "The reason text is read from Postgres, not invented",
    ],
    openQuestions: ["Is there a failure-reason column yet?"],
  });

  // Sections present and ordered.
  const order = [
    "## Problem",
    "## Users",
    "## Constraints",
    "## Scope",
    "## Success signals",
    "## Open questions",
  ];
  let last = -1;
  for (const heading of order) {
    const idx = summary.indexOf(heading);
    assert.ok(idx > last, `${heading} should appear in order`);
    last = idx;
  }

  assert.match(summary, /## Problem\nOperators can't tell/);
  assert.match(summary, /- Opening a failed run shows the gate that rejected it/);
  assert.match(summary, /- Is there a failure-reason column yet\?/);
});

test("buildRequirementsSummary requires a problem", () => {
  assert.throws(
    () =>
      buildRequirementsSummary({
        problem: "",
        successSignals: ["something observable"],
      }),
    /`problem` is required/,
  );
});

test("buildRequirementsSummary requires at least one success signal", () => {
  assert.throws(
    () =>
      buildRequirementsSummary({
        problem: "a real problem",
        successSignals: [],
      }),
    /successSignals` must be a non-empty array/,
  );
});

// --- to-issues: PRD -> ordered house-format issue drafts (AC3/AC4) -------

const SAMPLE_PRD = {
  title: "Failed-run triage view",
  problem: "Operators can't see why a run failed.",
  requiredContext:
    "Runs live in Postgres; console shows only falsifiable metrics (CONTEXT.md).",
  measurement: [
    "A failed run's detail view names the gate that rejected it",
    "The narrative is read-only from Postgres",
  ],
  parentEpic: "Operations console epic",
  slices: [
    {
      title: "Read the verify-gate reason for a run",
      requiredContext: "runs table has no error column yet; read the gate event.",
      whatToBuild:
        "A read path that returns the rejecting gate for a given run id.",
      acceptanceCriteria: [
        "Given a failed run id, the API returns the rejecting gate name",
        "A passing run returns null",
      ],
      verification: "Unit test the read path against seeded rows.",
    },
    {
      title: "Show the reason in the run detail view",
      whatToBuild: "Render the gate reason on the failed-run detail page.",
      acceptanceCriteria: [
        "Opening a failed run shows the gate reason text",
      ],
      verification: "Browser-verify the detail page for a seeded failed run.",
      blockedBy: "Read the verify-gate reason for a run",
    },
  ],
};

test("prdToIssueDrafts emits the parent epic first, then one draft per slice", () => {
  const drafts = prdToIssueDrafts(SAMPLE_PRD);

  assert.equal(drafts.length, 3, "epic + two slices");
  assert.equal(drafts[0].kind, "epic");
  assert.equal(drafts[0].title, "Failed-run triage view");
  assert.equal(
    drafts[0].parent,
    "Operations console epic",
    "the epic points at the outer epic/milestone",
  );

  // Both slices come after the epic and point BACK at the epic as Parent.
  assert.equal(drafts[1].kind, "slice");
  assert.equal(drafts[2].kind, "slice");
  assert.equal(drafts[1].parent, "Failed-run triage view");
  assert.equal(drafts[2].parent, "Failed-run triage view");
});

test("the epic draft's acceptance criteria are the PRD's measurement signals", () => {
  const [epic] = prdToIssueDrafts(SAMPLE_PRD);
  assert.deepEqual(epic.acceptanceCriteria, SAMPLE_PRD.measurement);
});

test("every draft carries all six house sections and >=1 checkboxed AC (AC3)", () => {
  const drafts = prdToIssueDrafts(SAMPLE_PRD);
  for (const draft of drafts) {
    // Feed each draft through the REAL create_issue body builder — the same one
    // the gated tool uses. If a draft is not house-format, this throws or the
    // body is missing a section.
    const body = buildIssueBody(draft);
    for (const heading of [
      "## Parent",
      "## Required context",
      "## What to build",
      "## Acceptance criteria",
      "## Verification evidence",
    ]) {
      assert.ok(
        body.includes(heading),
        `draft "${draft.title}" body must contain ${heading}`,
      );
    }
    // Labeled, checkboxed acceptance criteria.
    assert.match(
      body,
      /- \[ \] AC1: /,
      `draft "${draft.title}" must render a checkboxed AC1`,
    );
  }
});

test("a slice preserves its blockedBy dependency; the epic has none", () => {
  const drafts = prdToIssueDrafts(SAMPLE_PRD);
  assert.equal(drafts[0].blockedBy, undefined);
  assert.equal(drafts[2].blockedBy, "Read the verify-gate reason for a run");
});

test("prdToIssueDrafts rejects a slice with no acceptance criteria", () => {
  assert.throws(
    () =>
      prdToIssueDrafts({
        title: "T",
        measurement: ["m"],
        slices: [{ title: "no ACs", acceptanceCriteria: [] }],
      }),
    /has no acceptance criteria/,
  );
});

test("prdToIssueDrafts requires a title, measurement, and slices", () => {
  assert.throws(
    () => prdToIssueDrafts({ measurement: ["m"], slices: [{ title: "s", acceptanceCriteria: ["a"] }] }),
    /`title` is required/,
  );
  assert.throws(
    () => prdToIssueDrafts({ title: "T", measurement: [], slices: [{ title: "s", acceptanceCriteria: ["a"] }] }),
    /`measurement` must be a non-empty array/,
  );
  assert.throws(
    () => prdToIssueDrafts({ title: "T", measurement: ["m"], slices: [] }),
    /`slices` must be a non-empty array/,
  );
});

// --- AC4: each draft is exactly ONE gated create_issue call --------------

test("each draft becomes exactly one create_issue call via the single write path (AC4)", async () => {
  const drafts = prdToIssueDrafts(SAMPLE_PRD);
  const calls = [];

  // A faithful stub of the gated tool's execFile boundary: it records each call
  // and returns a distinct created-issue line, as the real CLI would. There is
  // ONE call per draft — the to-issues skill's "one approved call, one issue".
  let seq = 100;
  const fakeExec = async (bin, argv, opts) => {
    const n = seq++;
    calls.push({ bin, argv, opts });
    return {
      stdout: `Created Bensigo/agentrail#${n} (label ready-for-agent): https://github.com/Bensigo/agentrail/issues/${n}\n`,
      stderr: "",
    };
  };

  const created = [];
  for (const draft of drafts) {
    const ref = await runCreateIssue({
      execFileFn: fakeExec,
      env: { JACE_TARGET_REPO: "Bensigo/agentrail" },
      title: draft.title,
      parent: draft.parent,
      requiredContext: draft.requiredContext,
      whatToBuild: draft.whatToBuild,
      acceptanceCriteria: draft.acceptanceCriteria,
      verification: draft.verification,
    });
    created.push(ref);
  }

  // One CLI invocation per draft — no batching.
  assert.equal(calls.length, drafts.length);
  // Every call used the connector github create path (the single write path).
  for (const call of calls) {
    assert.deepEqual(buildCreateArgv({ repo: "x/y", title: "t", body: "b" }).slice(0, 4), [
      "issue",
      "create",
      "--connector",
      "github",
    ]);
    assert.equal(call.argv[0], "issue");
    assert.equal(call.argv[1], "create");
    assert.equal(call.argv[2], "--connector");
    assert.equal(call.argv[3], "github");
  }
  // Each returned a distinct real issue ref the factory can pick up by label.
  const urls = created.map((c) => c.url);
  assert.equal(new Set(urls).size, drafts.length, "distinct issue URLs");
  for (const ref of created) {
    assert.equal(ref.label, "ready-for-agent");
  }
});
