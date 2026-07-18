// Structural tests for Jace's onboard-completion answer path (issue #1268 PR②).
//
// Part B's deliverable is entirely instructions/description prose — no new
// tool, no approval change. These tests pin the source, regex-over-source
// style established by reporting-skills.test.mjs:
//   - instructions.md directs REPO/codebase questions on a workspace-bound
//     conversation to `fetch_workspace_memory` FIRST.
//   - instructions.md keeps that guidance clearly separated from
//     codebase-qa's own-source (AgentRail's own codebase) guidance, in BOTH
//     directions, so the two are never conflated.
//   - instructions.md states the honest fallback: an empty/thin result most
//     often means the repo index hasn't landed yet (onboarding still
//     running or not started) — never fabricate repo knowledge to fill it.
//   - fetch_workspace_memory's tool description states memory is seeded per
//     repo by onboarding.
//
// The complementary guarantees this PR must NOT weaken (no new tool, no
// approval change, the enumerated tool set unchanged) are already proven by
// no-second-write-path.test.mjs — this file does not re-implement that
// enumeration, it only pins the new prose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const instructionsPath = fileURLToPath(
  new URL("../agent/instructions.md", import.meta.url),
);
const fetchWorkspaceMemoryToolPath = fileURLToPath(
  new URL("../agent/tools/fetch_workspace_memory.ts", import.meta.url),
);

function section(src, heading) {
  const re = new RegExp(`## ${heading}[\\s\\S]*?(?=\\n## |$)`);
  const m = src.match(re);
  return m ? m[0] : "";
}

test("instructions.md routes REPO/codebase questions on a workspace-bound conversation to fetch_workspace_memory FIRST", () => {
  const src = readFileSync(instructionsPath, "utf8");
  const memorySection = section(src, "Workspace memory \\(read-only\\)");
  assert.ok(memorySection, "instructions.md must have a Workspace memory section");
  assert.match(
    memorySection,
    /workspace-bound conversation/i,
    "the routing guidance must be scoped to a workspace-bound conversation",
  );
  assert.match(
    memorySection,
    /call `fetch_workspace_memory` FIRST/,
    "must direct repo/codebase questions to fetch_workspace_memory FIRST",
  );
});

test("instructions.md keeps codebase-qa (AgentRail's own source) and workspace memory (the connected repo) clearly separated", () => {
  const src = readFileSync(instructionsPath, "utf8");

  // codebase-qa's own bullet must name itself as AgentRail's OWN codebase and
  // explicitly point away from a workspace's connected repo.
  const codebaseQaMatch = src.match(/\*\*codebase-qa\*\*[\s\S]*?(?=\n- \*\*|\n##)/);
  assert.ok(codebaseQaMatch, "instructions.md must have a codebase-qa bullet");
  assert.match(codebaseQaMatch[0], /AgentRail's OWN codebase/);
  assert.match(codebaseQaMatch[0], /NOT a workspace's connected\/onboarded repo/);

  // The Workspace memory section must, symmetrically, name codebase-qa and
  // say it is a DIFFERENT source from fetch_workspace_memory.
  const memorySection = section(src, "Workspace memory \\(read-only\\)");
  assert.match(memorySection, /codebase-qa/);
  assert.match(memorySection, /[Dd]ifferent source/);
  // Prose wraps at ~80 chars in the .md source, so tolerate a line-wrap
  // (whitespace, not necessarily a single space) between the two words.
  assert.match(memorySection, /[Dd]on't\s+conflate/);
});

test("instructions.md states the honest onboarding-index fallback — never fabricate", () => {
  const src = readFileSync(instructionsPath, "utf8");
  const memorySection = section(src, "Workspace memory \\(read-only\\)");
  assert.match(
    memorySection,
    /seeded per repo/i,
    "must explain memory is seeded per repo by onboarding",
  );
  assert.match(
    memorySection,
    /onboarding/i,
    "must name onboarding as the source of the index",
  );
  assert.match(
    memorySection,
    /index hasn't landed yet|hasn't landed yet/i,
    "must give the honest fallback phrasing for an empty/thin result",
  );
  assert.match(
    memorySection,
    /never fabricate|do not invent|not invent/i,
    "must forbid fabricating repo knowledge to fill the gap",
  );
});

test("fetch_workspace_memory's tool description states memory is seeded per repo by onboarding", () => {
  const src = readFileSync(fetchWorkspaceMemoryToolPath, "utf8");
  assert.match(
    src,
    /[Ss]eeded per repo/,
    "the tool description must clarify memory is seeded per repo",
  );
  assert.match(
    src,
    /onboarding/i,
    "the tool description must name onboarding as what seeds it",
  );
});

test("no-op sanity: fetch_workspace_memory.ts still authors no approval field (read-only, unchanged gate posture)", () => {
  const src = readFileSync(fetchWorkspaceMemoryToolPath, "utf8");
  assert.doesNotMatch(
    src,
    /approval:\s*(?:always|once)\(|consoleGatedApproval/,
    "fetch_workspace_memory must stay ungated — this PR touches description text only",
  );
});
