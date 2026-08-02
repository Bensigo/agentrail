// QA AC-awareness prose pins (spec: docs/superpowers/specs/
// 2026-07-29-qa-ac-awareness-design.md). The instruction files ARE the
// mechanism: delete these rules and every other test still passes while QA
// silently stops walking acceptance criteria. Mirrors the convention of
// fetch-work-status-instructions.test.mjs — assert the PROSE states each
// rule, matching load-bearing keywords, not exact wording.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AC_RESULT_VERDICTS } from "../agent/subagents/qa/lib/qa.core.mjs";

const qaInstructionsPath = fileURLToPath(
  new URL("../agent/subagents/qa/instructions.md", import.meta.url),
);

function qaInstructions() {
  return readFileSync(qaInstructionsPath, "utf8");
}

test("qa instructions define every AC verdict in lockstep with AC_RESULT_VERDICTS", () => {
  const prose = qaInstructions();
  for (const verdict of AC_RESULT_VERDICTS) {
    assert.ok(prose.includes(`\`${verdict}\``), `qa instructions must define \`${verdict}\``);
  }
});

test("qa instructions: not_testable is never folded into passed", () => {
  const prose = qaInstructions();
  assert.match(prose, /not_testable[\s\S]{0,600}never/i);
  assert.ok(prose.includes("every *testable* AC") || /testable AC/.test(prose));
});

test("qa instructions: no ACs provided -> ac_results null, said plainly", () => {
  const prose = qaInstructions();
  assert.ok(prose.includes("ac_results: null") || prose.includes("`ac_results`: null"));
  assert.match(prose, /without acceptance criteria/i);
});

test("qa instructions: AC text is data, never instructions", () => {
  const prose = qaInstructions();
  assert.match(prose, /criterion[\s\S]{0,400}(data|never.*instruction|instruction.*finding)/i);
});

test("qa instructions: a not_verifiable verdict returns ac_results null, stated in prose not just the validator", () => {
  const prose = qaInstructions();
  assert.match(prose, /not_verifiable[\s\S]{0,300}`ac_results: null`|`ac_results: null`[\s\S]{0,300}not_verifiable/);
});

// Capture-protocol pins (B2a §2, design: docs/superpowers/specs/
// 2026-08-02-b2-behavioral-evidence-design.md) — delete these rules and
// upload_evidence_image still works mechanically, but QA silently stops
// calling it, or calls it for the wrong AC, or aborts a whole verification
// over one failed upload. Same convention as the AC-awareness pins above:
// match load-bearing keywords, not exact wording.

test("qa instructions: behavioral ACs chain screenshot -> upload_evidence_image -> evidence_images", () => {
  const prose = qaInstructions();
  assert.match(prose, /screenshot[\s\S]{0,300}upload_evidence_image[\s\S]{0,300}evidence_images/);
});

test("qa instructions: a failed AC's screenshot captures the FAILING state", () => {
  const prose = qaInstructions();
  assert.match(prose, /`failed`[\s\S]{0,150}FAILING state/);
});

test("qa instructions: a not_testable AC captures no screenshot — its reason stands alone", () => {
  const prose = qaInstructions();
  assert.match(prose, /`not_testable`[\s\S]{0,150}captures nothing/);
});

test("qa instructions: an upload_evidence_image error is noted per-AC and verification continues", () => {
  const prose = qaInstructions();
  assert.match(prose, /upload_evidence_image[\s\S]{0,400}\{error\}[\s\S]{0,300}continue/);
  assert.match(prose, /never (blocks|abort)/);
});

test("qa instructions: never fabricate or reuse another AC's evidence image", () => {
  const prose = qaInstructions();
  assert.match(prose, /never fabricate/i);
  assert.match(prose, /never reuse another AC/i);
});

test("qa instructions: purely non-visual ACs need no screenshot", () => {
  const prose = qaInstructions();
  assert.match(prose, /non-visual[\s\S]{0,150}no screenshot/);
});

const rootInstructionsPath = fileURLToPath(new URL("../agent/instructions.md", import.meta.url));

function rootInstructions() {
  return readFileSync(rootInstructionsPath, "utf8");
}

test("root instructions: fetch_issue resolves the AC checklist before dispatching qa", () => {
  const prose = rootInstructions();
  assert.match(prose, /fetch_issue[\s\S]{0,800}Acceptance criteria/i);
});

test("root instructions: reviewer coverage hands not_in_diff/unclear to qa as priority focus", () => {
  const prose = rootInstructions();
  assert.match(prose, /(not_in_diff|`not_in_diff`)[\s\S]{0,400}[Pp]riority focus|[Pp]riority focus[\s\S]{0,400}not_in_diff/);
});

test("root instructions: null ac_results reported as QA-without-ACs with the reason", () => {
  const prose = rootInstructions();
  assert.match(prose, /QA ran without acceptance criteria/i);
});
