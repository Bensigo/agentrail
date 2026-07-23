// Structural tests for Jace's BACKLOG-GROOMING surface (issue #1291, epic
// #1257): the read-only `backlog-triage` skill + `fetch_backlog` tool, and the
// three GATED mutation tools (backlog_label / backlog_close / backlog_dedupe).
//
// Filesystem/wiring contract, asserted WITHOUT booting Eve or a model (so they
// never hang):
//   - backlog-triage/SKILL.md exists, frontmatter name matches its directory,
//     declares itself read-only-by-default, names the grooming signals, and
//     routes every mutation through the three gated tools (never a second write
//     path).
//   - The skill is kept DISTINCT from the run-failure "triage" subagent
//     (failure diagnosis) — a naming-collision guard the brief calls out.
//   - fetch_backlog is read-only: no `approval`, no child_process.
//   - Each of the three mutation tools is authored with defineTool and gates
//     every invocation behind `approval: (ctx) => consoleGatedApproval(ctx)`
//     (AC2: proposes-not-applies until approved — the gate is the enforcement;
//     the apply body is proven in backlog_mutation.core.test.mjs).
//   - instructions.md wires the skill + the three gated tools into the persona.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const skillsDir = fileURLToPath(new URL("../agent/skills", import.meta.url));
const toolsDir = fileURLToPath(new URL("../agent/tools", import.meta.url));
const instructionsPath = fileURLToPath(new URL("../agent/instructions.md", import.meta.url));

const GATED_TOOLS = ["backlog_label.ts", "backlog_close.ts", "backlog_dedupe.ts"];
const CONSOLE_GATED_APPROVAL_RE =
  /approval:\s*\(\s*ctx\s*\)\s*=>\s*consoleGatedApproval\(\s*ctx\s*\)/;
// Match a real child_process IMPORT, not the word appearing in prose (these
// tool files' doc-comments say "no child_process" / "never child_process").
const CHILD_PROCESS_IMPORT_RE =
  /(?:from\s+["']node:child_process["'])|(?:from\s+["']child_process["'])|(?:require\(\s*["']node:?child_process["']\s*\))/;

// Strip // and /* */ comments before matching against real code (same idiom as
// no-second-write-path.test.mjs) — these files document their gate posture in
// prose that would otherwise read as a false positive.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

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

function skillSource() {
  return readFileSync(`${skillsDir}/backlog-triage/SKILL.md`, "utf8");
}
function toolSource(name) {
  return readFileSync(`${toolsDir}/${name}`, "utf8");
}

test("backlog-triage skill exists with frontmatter naming it", () => {
  const path = `${skillsDir}/backlog-triage/SKILL.md`;
  assert.ok(existsSync(path), "expected skills/backlog-triage/SKILL.md");
  const fm = frontmatter(readFileSync(path, "utf8"));
  assert.ok(fm, "SKILL.md must have frontmatter");
  assert.equal(fm.name, "backlog-triage", "frontmatter name must match the directory");
  assert.ok(fm.description && fm.description.length > 20, "must have a substantive description");
});

test("backlog-triage is read-only by default and reads via fetch_backlog", () => {
  const src = skillSource();
  assert.match(src, /read-only/i, "must declare itself read-only by default");
  assert.match(src, /fetch_backlog/, "must read the backlog via the fetch_backlog tool");
});

test("backlog-triage names the explicit grooming signals it reasons over", () => {
  const src = skillSource();
  assert.match(src, /age/i, "must use age");
  assert.match(src, /stale/i, "must use staleness");
  assert.match(src, /impact/i, "must use impact labels");
  assert.match(src, /duplicate/i, "must use likely-duplicate detection");
});

test("backlog-triage presents a reasoned ordering in chat (top items first, rationale each)", () => {
  const src = skillSource();
  assert.match(src, /digest|ordering|ranked|prioritiz/i, "must present a groomed ordering");
  assert.match(src, /rationale|why/i, "must give a rationale per item");
});

test("backlog-triage routes EVERY mutation through the three gated tools and no other write path", () => {
  const src = skillSource();
  assert.match(src, /backlog_label/, "must reference backlog_label");
  assert.match(src, /backlog_close/, "must reference backlog_close");
  assert.match(src, /backlog_dedupe/, "must reference backlog_dedupe");
  assert.match(src, /human-approved|approve|approval/i, "must state mutations are human-approved");
  // No second write path: never file new issues, never shell out or hit a tracker API directly.
  assert.match(src, /[Nn]ever call `create_issue`/, "grooming must not file new issues");
  assert.doesNotMatch(
    src,
    /child_process|execFile|gh issue|octokit|linear/i,
    "must not describe any write path other than the gated tools",
  );
});

test("backlog-triage is kept DISTINCT from the run-failure triage subagent (naming-collision guard)", () => {
  const src = skillSource();
  // The skill must explicitly distinguish grooming from failure diagnosis.
  assert.match(src, /grooming/i, "must frame itself as grooming");
  assert.match(
    src,
    /not (run-failure|failure)|failure diagnosis|why (a )?run failed/i,
    "must call out that it is NOT the run-failure triage subagent",
  );
});

test("fetch_backlog is a read-only tool: no approval gate, no child_process", () => {
  const src = stripComments(toolSource("fetch_backlog.ts"));
  assert.match(src, /defineTool\(/, "must be authored with defineTool");
  assert.doesNotMatch(src, /approval:/, "a read-only tool must set no approval gate");
  assert.doesNotMatch(src, CHILD_PROCESS_IMPORT_RE, "must not import child_process");
});

test("each backlog mutation tool is human-gated via consoleGatedApproval (AC2) and never shells out", () => {
  for (const name of GATED_TOOLS) {
    const src = stripComments(toolSource(name));
    assert.match(src, /defineTool\(/, `${name} must be authored with defineTool`);
    assert.match(
      src,
      CONSOLE_GATED_APPROVAL_RE,
      `${name} must gate every invocation behind approval: (ctx) => consoleGatedApproval(ctx)`,
    );
    // Applies over HTTP to the console (holds the GitHub token) — never child_process.
    assert.doesNotMatch(src, CHILD_PROCESS_IMPORT_RE, `${name} must not import child_process`);
  }
});

test("instructions.md wires the backlog-triage skill + the three gated tools", () => {
  const src = readFileSync(instructionsPath, "utf8");
  assert.match(src, /backlog-triage/, "must reference the backlog-triage skill");
  assert.match(src, /fetch_backlog/, "must reference the fetch_backlog read tool");
  for (const name of ["backlog_label", "backlog_close", "backlog_dedupe"]) {
    assert.match(src, new RegExp(name), `must reference the ${name} gated tool`);
  }
});
