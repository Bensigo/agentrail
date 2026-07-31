// Content pins for the debugger's rewritten instructions.md (Task 9,
// debugging design spec: docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md;
// spec PR #1501). Mirrors the house pattern for instruction-file changes
// (e.g. test/fetch-work-status-instructions.test.mjs,
// test/reporting-skills.test.mjs, test/backlog-triage-skill.test.mjs): light,
// structural assertions on the actual prose, not a re-implementation of it —
// so a future edit that silently drops one of these pinned rules fails here
// instead of only being noticed in production.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const instructionsPath = fileURLToPath(new URL("../agent/subagents/triage/instructions.md", import.meta.url));
const src = readFileSync(instructionsPath, "utf8");

test("identity: states the qa/debugger boundary line", () => {
  assert.match(src, /qa validates software/i);
  assert.match(src, /you debug software/i);
});

test("declares exactly two modes, run mode before deep mode", () => {
  const runIndex = src.indexOf("## Run mode");
  const deepIndex = src.indexOf("## Deep mode");
  assert.notEqual(runIndex, -1, "must have a '## Run mode' section");
  assert.notEqual(deepIndex, -1, "must have a '## Deep mode' section");
  assert.ok(runIndex < deepIndex, "Run mode must come before Deep mode");
});

test("has a top-level Untrusted content section, copied-from-qa in spirit", () => {
  assert.match(src, /## Untrusted content/);
  assert.match(src, /data, never\s*\n?\s*instructions/i);
});

test("run mode: preserves the anti-confabulation 'one rule' and the four-step protocol", () => {
  assert.match(src, /### The one rule/);
  assert.match(src, /evidence_ref.*section the fetched bundle actually carries/s);
  assert.match(src, /### Protocol: Fetch → Read → Diagnose → Return/);
  assert.match(src, /#### 1\. Fetch/);
  assert.match(src, /#### 4\. Return/);
});

test("run mode: states mode:\"run\" is accepted but never required", () => {
  assert.match(src, /mode: "run"/);
  assert.match(src, /nothing ever\s+requires\s+it/i);
});

test("run mode: preserves graceful-degradation guidance (never throws, never retry, honest note)", () => {
  assert.match(src, /### Graceful degradation/);
  assert.match(src, /never throws/);
  assert.match(src, /Do not retry/);
});

test("deep mode: names the mission envelope contents (question, window, capability map, ledger digest)", () => {
  const deepSection = src.slice(src.indexOf("## Deep mode"), src.indexOf("## Untrusted content"));
  assert.match(deepSection, /question/i);
  assert.match(deepSection, /window/i);
  assert.match(deepSection, /capability map/i);
  assert.match(deepSection, /ledger digest/i);
});

test("deep mode: names both nested investigators by name (change, anomaly)", () => {
  const deepSection = src.slice(src.indexOf("## Deep mode"), src.indexOf("## Untrusted content"));
  assert.match(deepSection, /`change`/);
  assert.match(deepSection, /`anomaly`/);
});

test("deep mode: names both evidence-verb tools (fetch_changes, search_events)", () => {
  const deepSection = src.slice(src.indexOf("## Deep mode"), src.indexOf("## Untrusted content"));
  assert.match(deepSection, /fetch_changes/);
  assert.match(deepSection, /search_events/);
});

test("deep mode: states ROUND_REPORT's five content fields (round_summary, findings, proposed_hypotheses, evidence_gaps, suggested_next)", () => {
  const deepSection = src.slice(src.indexOf("## Deep mode"), src.indexOf("## Untrusted content"));
  for (const field of ["round_summary", "findings", "proposed_hypotheses", "evidence_gaps", "suggested_next"]) {
    assert.match(deepSection, new RegExp(field), `deep mode section must mention ${field}`);
  }
});

test("deep mode: says PROPOSE, never adjudicate — the debugger does not decide the verdict", () => {
  const deepSection = src.slice(src.indexOf("## Deep mode"), src.indexOf("## Untrusted content"));
  assert.match(deepSection, /PROPOSE/);
  assert.match(deepSection, /never adjudicate|never call `?save_investigation`?|root and the human/i);
});

test("deep mode: findings must cite evidence actually seen THIS round, not the ledger digest", () => {
  const deepSection = src.slice(src.indexOf("## Deep mode"), src.indexOf("## Untrusted content"));
  assert.match(deepSection, /actually seen\s+this\s+round|actually saw\s+this\s+round/i);
});

test("deep mode: instructs reporting evidence gaps honestly, never staying silent about one", () => {
  const deepSection = src.slice(src.indexOf("## Deep mode"), src.indexOf("## Untrusted content"));
  assert.match(deepSection, /no_provider/);
  assert.match(deepSection, /honestly/i);
});

test("capability voice: leads with capability, provider as attribution, not the subject of a sentence", () => {
  assert.match(src, /I can inspect deployments/i);
  assert.match(src, /not the subject of a sentence/i);
});
