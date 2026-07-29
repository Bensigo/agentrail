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
