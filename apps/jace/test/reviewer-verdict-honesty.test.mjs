// #1481 — root's `agent/instructions.md` "Reviewing a pull request"
// section IS the mechanism that stops root from upgrading the reviewer's
// verdict into an approval. The reviewer subagent's own
// `agent/subagents/reviewer/instructions.md` carries the matching charter
// for AC coverage, keeping it diff-honest rather than confabulated. Like
// fetch-work-status-instructions.test.mjs (whose header explains the
// convention), both files' prose carries functional weight the way code
// usually does: delete a rule and every other test still passes, silently
// re-enabling the bug it guards.
//
// The bug this guards, observed in prod 2026-07-27 on PR #1478: the reviewer
// returned the on-contract `verdict: "reviewed"` with a single minor
// documentation nit, and root relayed it to the human as "Verdict: Approved
// with a small documentation tweak" — an approval the reviewer never gave,
// on a PR that had real unflagged defects (#1480). Root had also handed the
// subagent an ad-hoc `outputSchema` whose verdict enum
// (approve/needs_changes/blocker) contains no value the subagent can produce.
//
// Asserts the PROSE states each rule, not that a model follows it — matching
// on the load-bearing keywords, not exact wording, so a reword doesn't break
// this but a deletion does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AC_COVERAGE_STATUSES,
  JUDGMENT_FIELDS,
  JUDGMENT_VERDICTS,
  INVESTIGATION_TOOLS,
} from "../agent/subagents/reviewer/lib/reviewer.core.mjs";

const instructionsPath = fileURLToPath(new URL("../agent/instructions.md", import.meta.url));
const verdictsPath = fileURLToPath(
  new URL("../agent/subagents/reviewer/lib/reviewer.core.mjs", import.meta.url),
);

function instructions() {
  return readFileSync(instructionsPath, "utf8");
}

test("the reviewer's verdict vocabulary is exactly reviewed|degraded — the contract the rules below describe", () => {
  // Pins the two files in lockstep: if REVIEW_VERDICTS ever grows an
  // approval-shaped value, the prose rules need revisiting, not silently
  // contradicting the schema.
  const src = readFileSync(verdictsPath, "utf8");
  assert.match(src, /REVIEW_VERDICTS\s*=\s*\[\s*"reviewed"\s*,\s*"degraded"\s*\]/);
});

test("instructions.md states that `reviewed` is NOT an approval", () => {
  const src = instructions();
  assert.match(
    src,
    /`reviewed` does\s+NOT\s+mean\s+approved/i,
    "must state the rule that shipped a false approval to a human",
  );
  assert.match(
    src,
    /[Zz]ero findings is a legitimate\s+`reviewed`/,
    "must say an empty review is still not a sign-off",
  );
});

test("instructions.md forbids root passing its own outputSchema to the reviewer", () => {
  const src = instructions();
  assert.match(
    src,
    /[Nn]ever hand the\s+`reviewer`\s+an\s+`outputSchema`/,
    "root inventing a competing verdict enum is what forced the mistranslation",
  );
});

test("instructions.md states a review is a bounded investigation, not a full audit", () => {
  const src = instructions();
  // Superseded 2026-08-01: the reviewer now has mandatory repo investigation
  // (search_code/read_repo_file/file_history/fetch_wiki), so "sees ONLY the
  // diff, has no repo access" is no longer true — the honest bound is a
  // BOUNDED, declared read budget, not zero repo access.
  assert.match(
    src,
    /review is not a full\s+audit/i,
    "must bound what the reviewer's investigation can establish",
  );
  // `\s+`/`[^.]*`, not literal spacing: markdown wraps this section at ~75
  // cols, so a phrase can straddle a newline today and a different one after
  // any reflow. The rule is what must survive, not the line breaks.
  assert.match(
    src,
    /bounded[^.]*read budget/i,
    "must name the actual limitation — a bounded read budget, not full repo access",
  );
  assert.match(
    src,
    /investigation trail/i,
    "must point at the investigation trail as the record of what was actually consulted",
  );
});

test("instructions.md still keeps the pre-existing degraded-verdict honesty rule (regression)", () => {
  const src = instructions();
  assert.match(
    src,
    /verdict is `degraded`/,
    "the new rules are additive — the degraded rule must survive them",
  );
});

const reviewerInstructionsPath = fileURLToPath(
  new URL("../agent/subagents/reviewer/instructions.md", import.meta.url),
);

test("reviewer instructions state the coverage vocabulary in lockstep with AC_COVERAGE_STATUSES", () => {
  const prose = readFileSync(reviewerInstructionsPath, "utf8");
  for (const status of AC_COVERAGE_STATUSES) {
    assert.ok(
      prose.includes(`\`${status}\``),
      `instructions must define coverage status \`${status}\``,
    );
  }
});

test("reviewer instructions carry both canonical null-coverage wordings", () => {
  const prose = readFileSync(reviewerInstructionsPath, "utf8");
  assert.ok(prose.includes("No recognizable acceptance criteria found"));
  assert.ok(prose.includes("could not be reliably parsed"));
});

test("reviewer instructions pin the source order: linked-issue ACs beat the PR body's own list", () => {
  const prose = readFileSync(reviewerInstructionsPath, "utf8");
  assert.ok(/never overrides or extends/.test(prose));
  assert.ok(/issueNumber: null/.test(prose) || /`issueNumber` of `null`/.test(prose));
});

test("root instructions: acCoverage is relayed verbatim to post_pr_review, never re-judged", () => {
  const prose = instructions();
  assert.ok(prose.includes("acCoverage"));
  assert.ok(/acCoverage[^.]*verbatim/i.test(prose));
});

// B2a's Task 6 (2026-08-02, docs/superpowers/plans/2026-08-02-b2a-visual-
// evidence.md): when qa's ac_results get folded into acCoverage for
// behavioral ACs, their evidence_images must ride that same fold verbatim —
// this is root's only instruction that the field exists at all, so deleting
// it silently stops evidence from ever reaching post_pr_review's acCoverage
// argument even though the tool and renderer both support it.
test("root instructions: qa's evidence_images ride the acCoverage fold verbatim into the posted per-AC lines", () => {
  const prose = instructions();
  assert.ok(prose.includes("evidence_images"));
  assert.match(prose, /evidence_images[^.]*verbatim/i);
});

test("root instructions: null coverage is reported as a diff-only review, echoing the reviewer's reason", () => {
  const prose = instructions();
  assert.ok(/diff-only/.test(prose));
  assert.ok(/no recognizable ACs|not reliably parseable/i.test(prose));
});

test("root instructions: the chat coverage rundown carries the reviewer's evidence for not_in_diff/unclear entries", () => {
  const prose = instructions();
  // `\s+`, not a literal space — same reflow-tolerant idiom as the
  // "review is not a full audit" / "bounded ... read budget" pin above: the
  // rule must survive a rewrap, not pin today's exact line break.
  assert.ok(
    /include\s+the\s+reviewer's\s+`evidence`/.test(prose),
    "must say the chat rundown carries the reviewer's evidence for not_in_diff/unclear entries",
  );
});

// --- Task 7 pins: identity, Investigate protocol, grounding -----------------
//
// Same posture as the pins above: these assert the PROSE states the rule,
// not that a model follows it. Multi-word phrases use `\s+` between words
// (not a literal space) for the same reason as the "bounded ... read budget"
// pin — this file wraps at ~75 cols, so a phrase can straddle a line break
// after a future reword without the rule itself having changed.

function reviewerInstructions() {
  return readFileSync(reviewerInstructionsPath, "utf8");
}

test("reviewer instructions state the repository, not just the diff, is what judgment is exercised over", () => {
  const prose = reviewerInstructions();
  assert.match(
    prose,
    /repository\s+is\s+the\s+system\s+under\s+evaluation/,
    "identity must anchor judgment to the repo the diff changes, not the diff in isolation",
  );
});

test("reviewer instructions name every investigation tool, backticked, in lockstep with INVESTIGATION_TOOLS", () => {
  const prose = reviewerInstructions();
  for (const tool of INVESTIGATION_TOOLS) {
    assert.ok(prose.includes(`\`${tool}\``), `instructions must name tool \`${tool}\``);
  }
});

test("reviewer instructions pin both investigation budget numbers", () => {
  const prose = reviewerInstructions();
  assert.match(prose, /about\s+15/, "must state the target read budget");
  assert.match(prose, /never\s+more\s+than\s+20/, "must state the hard read cap");
});

test("reviewer instructions state the grounding rule: no investigation, no claim", () => {
  const prose = reviewerInstructions();
  assert.match(
    prose,
    /no\s+investigation,?\s+no\s+claim/,
    "grounded judgment verdicts must require a cited investigated id",
  );
});

test("reviewer instructions state that skipped mandatory checks are declared, never silent", () => {
  const prose = reviewerInstructions();
  assert.match(
    prose,
    /skips\s+are\s+declared,?\s+never\s+silent/,
    "a skipped mandatory check must still get an investigated entry",
  );
});

test("reviewer instructions name every judgment field, backticked, in lockstep with JUDGMENT_FIELDS", () => {
  const prose = reviewerInstructions();
  for (const field of JUDGMENT_FIELDS) {
    assert.ok(prose.includes(`\`${field}\``), `instructions must name judgment field \`${field}\``);
  }
});

test("reviewer instructions pin `cannot_judge` as a shared, legitimate verdict across every judgment axis", () => {
  const prose = reviewerInstructions();
  // Lockstep with the exported vocab, same pattern as the AC_COVERAGE_STATUSES
  // pin above: cannot_judge is not just prose — it is a real value in every
  // field's verdict enum, and the prose must say so is honest, not a failure.
  for (const field of JUDGMENT_FIELDS) {
    assert.ok(
      JUDGMENT_VERDICTS[field].includes("cannot_judge"),
      `JUDGMENT_VERDICTS.${field} must include cannot_judge`,
    );
  }
  assert.ok(prose.includes("`cannot_judge`"), "instructions must name `cannot_judge` as a legitimate verdict");
});

test("reviewer instructions state the reviewer judges only what's visible — it cannot know minds", () => {
  const prose = reviewerInstructions();
  assert.match(
    prose,
    /you\s+cannot\s+know\s+minds/,
    "must bound judgment to what's visible, never the author's intent",
  );
});

test("reviewer instructions' protocol heading names all five phases, Read included", () => {
  const prose = reviewerInstructions();
  assert.ok(
    prose.includes("Fetch → Investigate → Read → Judge → Return"),
    "the heading must not undercount the numbered sections that actually exist",
  );
});

// --- Task 9 pins: root relays judgment verbatim, presents it unsoftened ----
//
// Same posture as the Task 7 pins above: these assert the PROSE states the
// rule, not that a model follows it — matching load-bearing keywords, not
// exact wording, so a reword doesn't break this but a deletion does.

test("root instructions: judgment is relayed to post_pr_review verbatim, never re-judged", () => {
  const prose = instructions();
  assert.ok(prose.includes("judgment"));
  assert.match(prose, /judgment[^.]*verbatim/i);
});

test("root instructions: the chat presentation of the judgment names the investigation count", () => {
  const prose = instructions();
  assert.match(
    prose,
    /investigated \d+|investigation count/,
    "must surface how many questions the review actually investigated",
  );
});

test("root instructions: a cannot_judge verdict is never softened into a pass", () => {
  const prose = instructions();
  assert.match(
    prose,
    /cannot_judge[\s\S]{0,300}never soften|never soften[\s\S]{0,300}cannot_judge/i,
    "cannot_judge must be presented as exactly that, never upgraded",
  );
});
