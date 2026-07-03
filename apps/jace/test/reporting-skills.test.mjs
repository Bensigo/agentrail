// Structural tests for Jace's READ-ONLY reporting skills (standup, codebase-qa).
//
// Filesystem/wiring contract, asserted without booting Eve or a model:
//   - standup and codebase-qa each exist as a SKILL.md whose frontmatter name
//     matches its directory.
//   - Both declare themselves read-only and forbid calling create_issue (they
//     publish nothing — no second write path).
//   - standup states the "why did it fail" no-confabulation rule (AC1/AC2).
//   - codebase-qa states the cite-tool-output rule (AC3) and the execFile-style,
//     never-a-shell-string rule (AC4).
//   - instructions.md wires both skills into Jace's persona.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const skillsDir = fileURLToPath(new URL("../agent/skills", import.meta.url));
const instructionsPath = fileURLToPath(
  new URL("../agent/instructions.md", import.meta.url),
);

const REPORTING_SKILLS = ["standup", "codebase-qa"];

function frontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function skillSource(name) {
  return readFileSync(`${skillsDir}/${name}/SKILL.md`, "utf8");
}

test("reporting skills exist as SKILL.md with frontmatter naming the skill", () => {
  const dirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const name of REPORTING_SKILLS) {
    assert.ok(dirs.includes(name), `skills/ must contain ${name}`);
    const path = `${skillsDir}/${name}/SKILL.md`;
    assert.ok(existsSync(path), `expected skill file ${name}/SKILL.md`);
    const fm = frontmatter(readFileSync(path, "utf8"));
    assert.ok(fm, `${name}/SKILL.md must have frontmatter`);
    assert.equal(fm.name, name, `${name} frontmatter name must match its directory`);
    assert.ok(
      fm.description && fm.description.length > 20,
      `${name} must have a substantive description`,
    );
  }
});

test("both reporting skills are read-only and never call create_issue", () => {
  for (const name of REPORTING_SKILLS) {
    const src = skillSource(name);
    assert.match(src, /read-only/i, `${name} must declare itself read-only`);
    assert.match(
      src,
      /[Nn]ever\s+call `create_issue`/,
      `${name} must forbid calling create_issue`,
    );
    // No second write path described inside the skill. (The execFile-vs-shell
    // rule is enforced against CODE in qa-no-shell-string.test.mjs; here we only
    // guard against a non-create_issue publish path being described.)
    assert.doesNotMatch(
      src,
      /gh issue create|octokit|linear/i,
      `${name} must not describe a write path other than create_issue`,
    );
  }
});

test("standup states the no-confabulation failure rule (AC1/AC2)", () => {
  const src = skillSource("standup");
  // Schema-backed only + the runs table has no error/reason column.
  assert.match(src, /schema-backed/i);
  assert.match(src, /no\b.*\b(error|reason)\b/i);
  // The honest no-source answer for "why did run X fail".
  assert.match(src, /why did run/i);
  assert.match(src, /answerWhyFailed/);
  assert.match(src, /never invent|not\s+invent|no failure-detail source/i);
});

test("codebase-qa states cite-tool-output (AC3) and execFile-not-shell (AC4)", () => {
  const src = skillSource("codebase-qa");
  // AC3 — grounded in / cites the agentrail context tool output, not memory.
  assert.match(src, /agentrail context/i);
  assert.match(src, /cite/i);
  assert.match(src, /not\s+.*memory|never.*memory|do not answer from memory/i);
  // AC4 — execFile-style args array, never a shell string.
  assert.match(src, /execFile-style|args array/i);
  assert.match(src, /never.*shell string|not.*shell string|shell string/i);
});

test("instructions.md wires both reporting skills into Jace's persona", () => {
  const src = readFileSync(instructionsPath, "utf8");
  for (const name of REPORTING_SKILLS) {
    assert.match(src, new RegExp(name), `instructions.md must reference ${name}`);
  }
});
