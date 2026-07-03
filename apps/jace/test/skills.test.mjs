// Structural tests for Jace's ideation skills.
//
// These assert the filesystem/wiring contract for the ideation front office
// without booting Eve or a model (so they never hang):
//   - grill-me, to-prd, to-issues, and emit-issue-brief each exist as a
//     SKILL.md with valid frontmatter (name matches its directory).
//   - The DRAFTING skills (grill-me, to-prd) are read-only: they must not
//     present create_issue as a write path — they explicitly say they publish
//     nothing. (AC1/AC2 stay conversation-only; only publishing crosses the
//     boundary.)
//   - Only to-issues (and emit-issue-brief, the shaper) reference the gated
//     create_issue tool — the single write path (AC3).
//   - instructions.md wires all four skills into Jace's persona.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const skillsDir = fileURLToPath(new URL("../agent/skills", import.meta.url));
const instructionsPath = fileURLToPath(
  new URL("../agent/instructions.md", import.meta.url),
);

const IDEATION_SKILLS = ["grill-me", "to-prd", "to-issues"];
const ALL_SKILLS = [...IDEATION_SKILLS, "emit-issue-brief"];

/** Parse the leading `--- ... ---` YAML-ish frontmatter into a flat map. */
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

test("all ideation skills exist as SKILL.md with frontmatter naming the skill", () => {
  for (const name of ALL_SKILLS) {
    const path = `${skillsDir}/${name}/SKILL.md`;
    assert.ok(existsSync(path), `expected skill file ${name}/SKILL.md`);
    const fm = frontmatter(readFileSync(path, "utf8"));
    assert.ok(fm, `${name}/SKILL.md must have frontmatter`);
    assert.equal(
      fm.name,
      name,
      `${name}/SKILL.md frontmatter name must match its directory`,
    );
    assert.ok(
      fm.description && fm.description.length > 20,
      `${name}/SKILL.md must have a substantive description`,
    );
  }
});

test("the three new ideation skills were added (dir contains them)", () => {
  const dirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const name of IDEATION_SKILLS) {
    assert.ok(dirs.includes(name), `skills/ must contain ${name}`);
  }
});

test("drafting skills (grill-me, to-prd) are read-only — they publish nothing", () => {
  for (const name of ["grill-me", "to-prd"]) {
    const src = skillSource(name);
    // They must explicitly state they are read-only / create nothing, and must
    // NOT instruct calling create_issue as their own action.
    assert.match(
      src,
      /read-only/i,
      `${name} must declare itself read-only`,
    );
    assert.match(
      src,
      /[Nn]ever call `create_issue`/,
      `${name} must forbid calling create_issue from within the drafting skill`,
    );
  }
});

test("to-issues routes publication through the single gated create_issue tool (AC3)", () => {
  const src = skillSource("to-issues");
  assert.match(src, /create_issue/, "to-issues must reference create_issue");
  assert.match(
    src,
    /approval:\s*always\(\)|human-approved|individually (?:human-)?approved/i,
    "to-issues must state each create_issue call is human-approved",
  );
  // No second write path: to-issues must not reach for github/linear directly
  // or shell out itself.
  assert.doesNotMatch(
    src,
    /child_process|execFile|gh issue create|linear|octokit/i,
    "to-issues must NOT describe any write path other than the create_issue tool",
  );
  // Publishing order: PRD epic first, then slices, one approved call each.
  assert.match(src, /parent epic/i, "to-issues publishes the PRD as a parent epic");
  assert.match(
    src,
    /one approved call, one issue/i,
    "to-issues must enforce one approved call per issue",
  );
});

test("instructions.md wires all four skills into Jace's persona", () => {
  const src = readFileSync(instructionsPath, "utf8");
  for (const name of ALL_SKILLS) {
    assert.match(
      src,
      new RegExp(name),
      `instructions.md must reference the ${name} skill`,
    );
  }
  // The single-write-path invariant survives: grill-me/to-prd write nothing.
  assert.match(
    src,
    /grill-me and to-prd write NOTHING|write NOTHING/i,
    "instructions.md must keep drafting read-only",
  );
});
