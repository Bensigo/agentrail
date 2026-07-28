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

// Readiness gate (design spec: docs/superpowers/specs/2026-07-28-jace-briefs-
// durable-idea-understanding-design.md, "Readiness gate"; route slice
// apps/console/app/api/v1/runner/briefs/route.ts). An `open` brief item with
// `kind: "unknown"` is a question nobody answered; if it reaches an issue the
// builder invents an acceptance criterion to fill the gap — that is where
// hallucination enters the factory. to-issues is the one place this must be
// enforced at the skill level (create_issue has no notion of briefs).
test("to-issues gates on brief readiness before publishing (Readiness gate)", () => {
  const src = skillSource("to-issues");
  assert.match(
    src,
    /readiness\.ready/,
    "to-issues must check readiness.ready (relayed verbatim by fetch_briefs) before publishing",
  );
  assert.match(
    src,
    /readiness\.blockingItems/,
    "to-issues must read readiness.blockingItems to name the actual unanswered questions",
  );
  assert.match(
    src,
    /kind:\s*"unknown"/,
    'to-issues must name the blocking predicate — kind: "unknown" — not just say "not ready"',
  );
  assert.match(
    src,
    /computeBriefReadiness/,
    "to-issues must attribute the check to the server-computed computeBriefReadiness, not a model judgment call",
  );
  // The field this gate used to read no longer exists (PR #1499 deleted
  // openUnknownCount from fetch_briefs.core.mjs and relays `readiness`
  // verbatim instead) — a stray reference here would mean the skill still
  // gates on a field the tool no longer produces, which fails silently open,
  // not loudly.
  assert.doesNotMatch(
    src,
    /openUnknownCount/,
    "to-issues must NOT reference openUnknownCount — that field was removed; the gate must read readiness instead",
  );
});

test("to-issues treats a MISSING readiness (not computed) the same as ready: false — fails closed, never open", () => {
  const src = skillSource("to-issues");
  // fetch_briefs relays readiness as `undefined` (never a fabricated
  // `ready: true`) when the console it's talking to hasn't computed one yet
  // (an older deployment, or a mode that never carries it). If the skill
  // doesn't say what to do with an ABSENT readiness, an unverifiable gate
  // quietly stops gating — the worst failure mode for a check whose entire
  // job is to stop unanswered questions reaching the builder.
  assert.match(
    src,
    /missing.{0,40}\(not computed\)/is,
    "to-issues must name the 'readiness missing / not computed' case explicitly, not just ready: true/false",
  );
  assert.match(
    src,
    /same as `?ready:\s*false`?/i,
    "to-issues must say a missing readiness is treated the same as ready: false",
  );
  assert.match(
    src,
    /fail(?:s)? closed/i,
    "to-issues must say the gate fails closed (refuses) when it cannot verify readiness, not open",
  );
});

test("to-issues refuses to derive readiness by reading item prose itself (server-computed, not model-derived)", () => {
  const src = skillSource("to-issues");
  // The load-bearing distinction: readiness must be reported (read off a
  // count/field the server already computed), never reached (a judgment call
  // over each item's statement) — a confident model can talk itself past its
  // own judgment, which is exactly the failure this gate exists to close.
  assert.match(
    src,
    /[Dd]o not decide readiness yourself/,
    "to-issues must explicitly forbid the model from deciding readiness by reading item prose",
  );
});

test("to-issues names the actual blocking item(s), not a bare 'not ready'", () => {
  const src = skillSource("to-issues");
  assert.match(
    src,
    /name each one by area and statement, never a bare "not ready"/,
    "to-issues must instruct naming each blocking item's area + statement",
  );
});

test("to-issues spells out both exits for an open unknown: answer it, or mark it out-of-scope", () => {
  const src = skillSource("to-issues");
  assert.match(
    src,
    /\*\*Answer it\.\*\*/,
    "to-issues must name 'answer it' as an exit from the readiness gate",
  );
  assert.match(
    src,
    /\*\*Mark it out-of-scope\.\*\*/,
    "to-issues must name 'mark it out-of-scope' as the other exit from the readiness gate",
  );
  // Deferred must NOT be offered as an exit for an unknown — the design spec
  // is explicit that "an unknown may never be deferred"; naming only two
  // exits (never three) keeps the skill honest about what's actually legal.
  assert.doesNotMatch(
    src,
    /mark it deferred|defer(?:red)? (?:it|the item)/i,
    'to-issues must NOT offer "defer it" as an exit from the readiness gate — an unknown may never be deferred',
  );
});

test("to-issues is honest that the gate is enforced at the skill level, not inside create_issue", () => {
  const src = skillSource("to-issues");
  assert.match(
    src,
    /create_issue.{0,80}has no notion of briefs/s,
    "to-issues must state plainly that create_issue does not know briefs exist",
  );
  assert.match(
    src,
    /not\s+gated by any of this/i,
    "to-issues must say an issue filed outside this flow is not protected by this gate",
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

// Regression coverage for the 2026-07-28 wiring: fetch_briefs/save_brief
// existed (spec PR #1487, store #1489, route #1493, tools #1497) but
// grill-me never called either — so nothing wrote a brief and a resumed
// conversation had no durable record to resume from, only the conversation
// itself (impossible across a compaction or a new session).

test("grill-me calls fetch_briefs and save_brief — a brief actually gets written and resumed", () => {
  const src = skillSource("grill-me");
  assert.match(
    src,
    /fetch_briefs/,
    "grill-me must call fetch_briefs to resolve an existing brief before grilling",
  );
  assert.match(
    src,
    /save_brief/,
    "grill-me must call save_brief to autosave resolved items as the interview progresses",
  );
});

test("grill-me no longer claims there is no persistent store behind it", () => {
  const src = skillSource("grill-me");
  // The pre-briefs version of this skill said exactly this at the bottom of
  // its Output section, because at the time it was true — CONTEXT.md/docs/adr
  // were the only (phantom) write instructions. Briefs make it false: if this
  // string comes back, resumption instructions have regressed to "the
  // conversation is the only record" again.
  assert.doesNotMatch(
    src,
    /no\s+persistent store behind this skill/i,
    "grill-me must not claim there is no persistent store — save_brief/fetch_briefs are that store now",
  );
});

test("grill-me states the resolve-before-anything-else order: anchor first, search only when unanchored", () => {
  const src = skillSource("grill-me");
  assert.match(
    src,
    /mode:\s*"anchor"/,
    "grill-me must call fetch_briefs(mode: \"anchor\") before anything else",
  );
  assert.match(
    src,
    /mode:\s*"search"/,
    "grill-me must fall back to fetch_briefs(mode: \"search\") only when unanchored",
  );
});

test("grill-me requires a human confirmation before treating a brief match as settled (never a silent attach)", () => {
  const src = skillSource("grill-me");
  assert.match(
    src,
    /ask_question/,
    "grill-me's brief-confirmation step must use ask_question, not a silent attach",
  );
  assert.match(
    src,
    /anchor:\s*true/,
    "grill-me must describe anchoring (anchor: true) on save_brief after confirmation",
  );
  assert.match(
    src,
    /anchor:\s*false/,
    "grill-me must describe clearing the anchor (anchor: false) on drift",
  );
});

test("grill-me instructs relaying both save_brief refusal fields", () => {
  const src = skillSource("grill-me");
  assert.match(src, /skippedHumanAuthorityIds/, "grill-me must instruct relaying skippedHumanAuthorityIds");
  assert.match(src, /skippedUnknownResolvedIds/, "grill-me must instruct relaying skippedUnknownResolvedIds");
});

test("grill-me instructs grounding + re-grounding on a stale wiki commit", () => {
  const src = skillSource("grill-me");
  assert.match(src, /grounding/i, "grill-me must instruct recording grounding on save_brief");
  assert.match(
    src,
    /re-read|re-ground/i,
    "grill-me must instruct re-reading/re-grounding when a cited wiki page has since recompiled",
  );
});

test("instructions.md's Briefs section names mode=anchor as the first call", () => {
  const src = readFileSync(instructionsPath, "utf8");
  assert.match(
    src,
    /mode="anchor"/,
    "instructions.md must name mode=\"anchor\" as fetch_briefs' first-call mode",
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
