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
//   - grill-me actually calls the repo wiki / workspace memory before it
//     grills, never writes CONTEXT.md or docs/adr, and instructions.md wires
//     ask_question in — the specific regressions the 2026-07-27 "blog" trace
//     surfaced (grill-me's only tool call was load_skill itself).

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

// Regression coverage for the observed 2026-07-27 "i want to add a blog our
// app" session: 9 turns, the ONLY tool call was load_skill('grill-me'). Two
// distinct bugs, asserted separately below.

test("grill-me calls the repo wiki and workspace memory before it grills", () => {
  const src = skillSource("grill-me");
  // Turn 9 asked for the tech stack two turns after the human had already
  // said "monorepo" and "console" — info the compiled wiki already had.
  // Nothing routed it in because grill-me never called either read tool.
  // If a future edit drops the preflight, this must go red.
  assert.match(
    src,
    /fetch_repo_wiki/,
    "grill-me must call fetch_repo_wiki before asking the human what the repo already answers",
  );
  assert.match(
    src,
    /fetch_workspace_memory/,
    "grill-me must call fetch_workspace_memory before asking the human what the workspace already knows",
  );
});

test("grill-me never instructs writing CONTEXT.md or docs/adr (phantom writes)", () => {
  const src = skillSource("grill-me");
  // The old skill told Jace to author CONTEXT.md and docs/adr/. Both are
  // impossible in the hosted deployment (no git checkout, per codebase_query's
  // own tool description) — those writes landed in an ephemeral sandbox and
  // vanished, which reads as captured when it wasn't. grill-me may still
  // MENTION CONTEXT.md (challenging the glossary, reading it via the wiki),
  // so this asserts on the WRITE instruction and the deleted format files,
  // not on the bare string.
  assert.doesNotMatch(
    src,
    /update `CONTEXT\.md`/i,
    "grill-me must not instruct updating CONTEXT.md — Jace has no checkout to write it to",
  );
  assert.doesNotMatch(
    src,
    /write it in the format in/i,
    "grill-me must not instruct writing a file in some format — that's the ADR/CONTEXT write instruction coming back",
  );
  assert.doesNotMatch(
    src,
    /CONTEXT-FORMAT|ADR-FORMAT/,
    "grill-me must not link the deleted CONTEXT-FORMAT.md / ADR-FORMAT.md files",
  );
});

test("the deleted CONTEXT-FORMAT.md and ADR-FORMAT.md do not exist under grill-me", () => {
  const dir = `${skillsDir}/grill-me`;
  assert.ok(
    !existsSync(`${dir}/CONTEXT-FORMAT.md`),
    "CONTEXT-FORMAT.md must stay deleted — its only job was the phantom CONTEXT.md write",
  );
  assert.ok(
    !existsSync(`${dir}/ADR-FORMAT.md`),
    "ADR-FORMAT.md must stay deleted — its only job was the phantom docs/adr write",
  );
});

test("instructions.md wires in ask_question for closed-set questions", () => {
  const src = readFileSync(instructionsPath, "utf8");
  // ask_question renders selectable options; before this change it appeared
  // 0 times in instructions.md, so grill-me printed markdown bullets instead
  // and the human pasted a label back verbatim ("Nowhere (no public updates
  // exist)?", question mark included) instead of giving a parseable answer.
  assert.match(
    src,
    /ask_question/,
    "instructions.md must reference the ask_question tool so it actually gets used",
  );
});
