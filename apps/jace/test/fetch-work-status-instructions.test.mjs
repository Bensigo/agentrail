// Important 6 — instructions.md's "Answering 'how's that going'" section IS
// the mechanism for fetch_work_status's honesty posture (this app's prose
// carries functional weight the way code usually does). Nothing else pins
// it: delete the section and every one of the app's 974+ other tests still
// passes, silently disabling the feature this whole branch built. This file
// is the structural guard, mirroring the wiring-test convention already used
// for backlog-triage (test/backlog-triage-skill.test.mjs) and standup/
// codebase-qa (test/reporting-skills.test.mjs) — assert the PROSE states each
// rule, not that a model actually follows it (that's out of scope for a fast,
// deterministic unit test).
//
// Deliberately specific enough to fail if a rule is deleted or gutted, but
// not so brittle it breaks on a reworded sentence — each assertion matches on
// the load-bearing keywords/values of the rule, not exact prose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const instructionsPath = fileURLToPath(new URL("../agent/instructions.md", import.meta.url));

function instructions() {
  return readFileSync(instructionsPath, "utf8");
}

test("instructions.md wires the fetch_work_status tool into the 'how's that going' rule", () => {
  const src = instructions();
  assert.match(src, /fetch_work_status/, "must reference the fetch_work_status read tool");
  assert.match(
    src,
    /how's that going/i,
    "must name the intent this tool answers, not just the tool",
  );
});

test("instructions.md states the degraded-read honesty rule for fetch_work_status", () => {
  const src = instructions();
  assert.match(
    src,
    /[Dd]egraded\?.*[Ss]ay so plainly.*`note`/s,
    "must instruct reporting a degraded result's note plainly, never guessing at the work",
  );
});

test("instructions.md states the resolvedAs: 'unrecognised' rule", () => {
  const src = instructions();
  assert.match(src, /resolvedAs:\s*"unrecognised"/, "must reference resolvedAs: \"unrecognised\"");
  assert.match(
    src,
    /couldn't make sense of that reference/i,
    "must give the honest phrasing for an unrecognised ref, distinct from 'nothing is going on'",
  );
});

test("instructions.md states the truncated rule", () => {
  const src = instructions();
  assert.match(
    src,
    /`truncated`.*more rows than you got back/i,
    "must state that truncated means more rows exist than were returned",
  );
  assert.match(src, /most\s+recent/i, "must give the honest phrasing — 'N most recent'");
});

test("instructions.md states the resolved-but-empty rung (Important 5)", () => {
  const src = instructions();
  assert.match(
    src,
    /[Rr]esolved but the arrays came back empty/,
    "must name the resolved-with-empty-arrays case explicitly",
  );
  assert.match(
    src,
    /not proof (the item doesn't exist|nothing)/i,
    "must say an empty result is not proof nothing exists",
  );
  assert.match(
    src,
    /in this workspace/i,
    "must scope the honest phrasing to THIS workspace, not 'anywhere'",
  );
});

test("instructions.md states the cross-repo bare-#N collision warning (Important 5)", () => {
  const src = instructions();
  assert.match(
    src,
    /bare\s*`#42`.*WRONG repo|bare.*number.*ANY of them/is,
    "must warn that a bare issue/PR number can match the wrong repo in a multi-repo workspace",
  );
});

test("instructions.md states success !== merged and does not describe GitHub CI (Important 2)", () => {
  const src = instructions();
  assert.match(
    src,
    /`success`.*(local verify gate|OWN.*gate)/is,
    "must tie a run's success status to its OWN local verify gate",
  );
  assert.match(src, /NOT mean a PR merged/i, "must explicitly deny that success means merged");
  assert.match(src, /not\s+.*GitHub CI|NOT mean.*GitHub CI/is, "must explicitly deny that success means GitHub CI is green");
});

test("instructions.md states the lastLivenessAt staleness rule (Minor 7)", () => {
  const src = instructions();
  assert.match(src, /lastLivenessAt/, "must reference lastLivenessAt");
  assert.match(
    src,
    /running.*(isn't necessarily|not necessarily).*alive|hours old/is,
    "must say a stale-liveness running run isn't confirmed alive",
  );
});

test("instructions.md maps queue states to the house vocabulary and forbids raw internals (Minor 8)", () => {
  const src = instructions();
  // \s+ tolerates a markdown line-wrap splitting a two-word label.
  for (const term of ["Assigned", "In\\s+progress", "Blocked", "Needs\\s+you", "Shipped"]) {
    assert.match(src, new RegExp(term), `must map to the house word "${term}"`);
  }
  assert.match(
    src,
    /[Nn]ever say `queue_entry`, `tier`, or `remaining_budget`/,
    "must forbid raw internal vocabulary in chat",
  );
  assert.match(
    src,
    /never paste a run's raw UUID/i,
    "must forbid pasting a raw run UUID into chat",
  );
});

test("instructions.md tells the model not to call both standup and fetch_work_status for one question (Minor 12)", () => {
  const src = instructions();
  assert.match(
    src,
    /don't call both/i,
    "must state standup and fetch_work_status should not both be called for the same question",
  );
});

test("instructions.md still states the no-failure-reason-column rule", () => {
  const src = instructions();
  assert.match(
    src,
    /`runs` table has no failure-reason column/,
    "must still state the runs table carries no failure-reason column",
  );
  assert.match(src, /[Nn]ever confabulate/, "must forbid confabulating a failure reason");
});
