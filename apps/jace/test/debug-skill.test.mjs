// Structural/content-pin tests for Jace's `debug` skill + its three
// playbooks (Task 11, debugging design spec:
// docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md; spec PR
// #1501; `.superpowers/sdd/spec.md` is the working copy this implementation
// follows) and the root instructions.md "Debugging" section that routes to
// it. Mirrors the house pattern for skill + instructions-wiring content pins
// (test/reporting-skills.test.mjs, test/backlog-triage-skill.test.mjs,
// test/debugger-instructions.test.mjs): light, structural assertions on the
// actual prose, without booting Eve or a model, so a future edit that
// silently drops one of these pinned rules fails here instead of only being
// noticed in production.
//
// COORDINATOR DECISIONS this file encodes (see .superpowers/sdd/progress.md,
// Task 10 entry): (1) the debugger's own `skills/` dir is NOT created — its
// `load_skill` is deliberately stripped (T9 sentinels) — so ALL playbooks
// live under the ROOT `debug` skill as `references/*.md` files; root reads
// the matching one and folds an extract into the mission envelope. (2) NO
// `intent:debugging` trace-tag work — dropped from v1 entirely, asserted
// nowhere here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const skillsDir = fileURLToPath(new URL("../agent/skills", import.meta.url));
const instructionsPath = fileURLToPath(new URL("../agent/instructions.md", import.meta.url));
const debugSkillPath = `${skillsDir}/debug/SKILL.md`;

const PLAYBOOK_FILES = ["regression-after-deploy.md", "latency-creep.md", "cannot-reproduce.md"];

const PINNED_SECTIONS = [
  "## Investigation resolution (before anything else)",
  "## Witness interview",
  "## Stabilize check",
  "## Rounds",
  "## Verdict",
  "## Handoff",
  "## Capability voice",
];

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

function skillSource() {
  return readFileSync(debugSkillPath, "utf8");
}

function playbookPath(name) {
  return `${skillsDir}/debug/references/${name}`;
}

function playbookSource(name) {
  return readFileSync(playbookPath(name), "utf8");
}

function debugFiles() {
  return [
    { label: "debug/SKILL.md", src: skillSource() },
    ...PLAYBOOK_FILES.map((name) => ({ label: `debug/references/${name}`, src: playbookSource(name) })),
  ];
}

// ---------------------------------------------------------------------------
// Existence + frontmatter
// ---------------------------------------------------------------------------

test("debug skill exists as SKILL.md with frontmatter naming the skill", () => {
  assert.ok(existsSync(debugSkillPath), "expected agent/skills/debug/SKILL.md");
  const fm = frontmatter(skillSource());
  assert.ok(fm, "debug/SKILL.md must have frontmatter");
  assert.equal(fm.name, "debug", "frontmatter name must match its directory");
  assert.ok(fm.description && fm.description.length > 20, "must have a substantive description");
});

test("the three playbook reference files exist under debug/references/", () => {
  for (const name of PLAYBOOK_FILES) {
    assert.ok(existsSync(playbookPath(name)), `expected agent/skills/debug/references/${name}`);
  }
});

// ---------------------------------------------------------------------------
// Section order (the seven pinned sections)
// ---------------------------------------------------------------------------

test("debug skill declares all seven pinned sections, in pinned order", () => {
  const src = skillSource();
  const indexes = PINNED_SECTIONS.map((heading) => {
    const idx = src.indexOf(heading);
    assert.notEqual(idx, -1, `missing pinned heading: ${heading}`);
    return idx;
  });
  for (let i = 1; i < indexes.length; i++) {
    assert.ok(
      indexes[i] > indexes[i - 1],
      `"${PINNED_SECTIONS[i]}" must come after "${PINNED_SECTIONS[i - 1]}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// #1498-style ordering pin: fetch_investigations(mode: "anchor") is the
// FIRST tool/subagent mention anywhere in the file (frontmatter included).
// ---------------------------------------------------------------------------

test('fetch_investigations(mode: "anchor") is the first tool/subagent mention in the file', () => {
  const src = skillSource();
  const anchorIdx = src.indexOf('fetch_investigations(mode: "anchor")');
  assert.notEqual(anchorIdx, -1, 'expected the literal call fetch_investigations(mode: "anchor")');

  const otherNames = [
    "save_investigation",
    "record_verdict",
    "fetch_evidence_capabilities",
    "create_issue",
    "triage",
    "qa",
    "fetch_changes",
    "search_events",
    "ask_question",
    "load_skill",
  ];
  for (const name of otherNames) {
    const idx = src.indexOf(name);
    if (idx === -1) continue; // never mentioned at all is fine
    assert.ok(
      idx > anchorIdx,
      `"${name}" appears at index ${idx}, before fetch_investigations(mode: "anchor") at ${anchorIdx}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Section 1 — Investigation resolution
// ---------------------------------------------------------------------------

test("Investigation resolution: anchor first, search only when unanchored, confirm-once", () => {
  const src = skillSource();
  assert.match(src, /fetch_investigations\(mode: "anchor"\)/);
  assert.match(src, /fetch_investigations\(mode: "search"\)/);
  assert.match(src, /continue INV `checkout-500s`, or is this new\?/);
  assert.match(src, /never silently attach or fork/i);
});

test("Investigation resolution: reopen-vs-new rule KEYS ON VERDICT (undetermined->reopen, root_caused->new+recurrence_of), never on status or unverifiable fix-shipped", () => {
  const src = skillSource();
  const section = src.slice(src.indexOf("## Investigation resolution"), src.indexOf("## Witness interview"));
  assert.match(section, /verdict/i);
  assert.match(section, /`undetermined`[\s\S]{0,60}reopen it/i);
  assert.match(section, /`root_caused`[\s\S]{0,200}recurrence_of/i);
  assert.match(section, /links:\s*\[\{\s*targetSlug/);
  assert.match(section, /role:\s*"recurrence_of"/);
  assert.match(section, /hypothesis to test, never truth/i);
  // The old, wrong keying must not survive: "concluded" is a status, not a
  // verdict, and "fix shipped" is unverifiable from the conversation.
  assert.doesNotMatch(section, /`concluded`/, "must not key the second branch on status:concluded");
  assert.match(section, /no reliable way to verify/i, "must state plainly that fix-shipped is unverifiable here");
});

// ---------------------------------------------------------------------------
// Section 2 — Witness interview
// ---------------------------------------------------------------------------

test("Witness interview: verbatim capture, first-seen, blast radius incl. NOT affected, repro, severity->depth budget", () => {
  const src = skillSource();
  const section = src.slice(src.indexOf("## Witness interview"), src.indexOf("## Stabilize check"));
  assert.match(section, /symptomStatement/);
  assert.match(section, /verbatim/i);
  assert.match(section, /[Nn]ever paraphrase/);
  assert.match(section, /First-seen/i);
  assert.match(section, /[Bb]last radius/);
  assert.match(section, /NOT affected/);
  assert.match(section, /[Rr]eproduction|repro/i);
  assert.match(section, /depth[ _]budget/i);
  assert.match(section, /evidence source/i);
});

test("Witness interview: severity->depth-budget claim is HONEST — pacing discipline root applies itself, not a server computation (Fix Round 1, FIX 4)", () => {
  const src = skillSource();
  const section = src.slice(src.indexOf("## Witness interview"), src.indexOf("## Stabilize check"));
  assert.match(section, /not yet live/i);
  assert.match(section, /defaults to\s*\n?\s*8/i);
  assert.doesNotMatch(section, /computed server-side/i, "must not claim the depth budget is currently computed server-side from severity");
});

// ---------------------------------------------------------------------------
// Section 3 — Stabilize check
// ---------------------------------------------------------------------------

test("Stabilize check: one mitigation question, deploy-correlated rollback surfaced immediately, advisory only", () => {
  const src = skillSource();
  const section = src.slice(src.indexOf("## Stabilize check"), src.indexOf("## Rounds"));
  assert.match(section, /ONE question/);
  assert.match(section, /[Rr]ollback/);
  assert.match(section, /deploy correlates with first-seen/i);
  assert.match(section, /surface the rollback candidate\s+immediately/i);
  assert.match(section, /advisory only/i);
  assert.match(section, /never execute one/i);
});

// ---------------------------------------------------------------------------
// Section 4 — Rounds
// ---------------------------------------------------------------------------

test("Rounds: mission envelope names question, window, capability map, ledger digest, playbook extract", () => {
  const src = skillSource();
  const section = src.slice(src.indexOf("## Rounds"), src.indexOf("## Verdict"));
  assert.match(section, /[Tt]he question/);
  assert.match(section, /[Tt]he window/);
  assert.match(section, /capability map/i);
  assert.match(section, /ledger digest/i);
  assert.match(section, /playbook extract/i);
  assert.match(section, /references\//);
  assert.match(section, /regression-after-deploy\.md/);
  assert.match(section, /latency-creep\.md/);
  assert.match(section, /cannot-reproduce\.md/);
});

test("Rounds: the capability map bullet names the REAL tool, fetch_evidence_capabilities (Fix Round 1, FIX 2)", () => {
  const src = skillSource();
  const section = src.slice(src.indexOf("## Rounds"), src.indexOf("## Verdict"));
  assert.match(section, /fetch_evidence_capabilities/);
});

test("Rounds: ROUND_REPORT deltas — findings->finding, hypotheses adjudicated (may downgrade, never upgrade), gaps->timeline_event", () => {
  const src = skillSource();
  const section = src.slice(src.indexOf("## Rounds"), src.indexOf("## Verdict"));
  assert.match(section, /ROUND_REPORT/);
  assert.match(section, /findings.{0,40}kind: "finding"/s);
  assert.match(section, /proposed_hypotheses.{0,60}kind: "hypothesis"/s);
  assert.match(section, /adjudicate/i);
  assert.match(section, /downgrade/i);
  assert.match(section, /never\s+\*\*upgrade\*\*|never upgrade/i);
  assert.match(section, /evidence_gaps.{0,60}timeline_event/s);
  assert.match(section, /[Aa]utosave between rounds/);
});

test("Rounds: round_summary has a durable home — persisted as its own timeline_event note every round (FOLD-IN B)", () => {
  const src = skillSource();
  const section = src.slice(src.indexOf("## Rounds"), src.indexOf("## Verdict"));
  assert.match(section, /round_summary/);
  assert.match(section, /round_summary[\s\S]{0,60}timeline_event/);
});

test("Rounds: triage never calls save_investigation itself — only root persists", () => {
  const src = skillSource();
  const section = src.slice(src.indexOf("## Rounds"), src.indexOf("## Verdict"));
  assert.match(section, /`?triage`?\s+never\s+calls\s*`?save_investigation`?/i);
  // Strengthened (Fix Round 1, FOLD-IN A): the positive pin above requires
  // "triage" to be immediately followed by an optional backtick then
  // whitespace (`` `triage` `` is how every mention in this file is
  // formatted) before the verb, so it can never accidentally match this
  // negative check. The negative check itself now catches three phrasings,
  // not one: "calls" (any tense/modal, including "will call"), "persists"
  // ("persist(s) ... via save_investigation" — the transcription-is-lossy
  // failure mode named in the spec's own Out-of-scope section), for each of
  // triage / the debugger / the investigators.
  assert.doesNotMatch(
    section,
    /(?:triage|debugger|investigators?)`?\s+(?:should\s+|must\s+|will\s+)?(?:calls?|persists?)\b[\s\S]{0,60}`?save_investigation`?/i,
    "must never instruct triage/the debugger/investigators to call OR persist (even indirectly, e.g. 'will call'/'persists ... via') save_investigation",
  );
});

test("the strengthened triage/save_investigation negative regex actually catches 'will call' and 'persists ... via' phrasings (not vacuous)", () => {
  const NEGATIVE_RE =
    /(?:triage|debugger|investigators?)`?\s+(?:should\s+|must\s+|will\s+)?(?:calls?|persists?)\b[\s\S]{0,60}`?save_investigation`?/i;
  assert.match("the debugger will call save_investigation directly", NEGATIVE_RE);
  assert.match("triage persists its round_summary via save_investigation", NEGATIVE_RE);
  assert.match("investigators call save_investigation when they finish", NEGATIVE_RE);
  // And the legitimate positive pin, verbatim from the skill, must NOT
  // false-positive against the very check meant to forbid its opposite.
  assert.doesNotMatch(
    "`triage` never calls `save_investigation` or `record_verdict` itself — this adjudicate-then-persist step belongs to you alone.",
    NEGATIVE_RE,
  );
});

test("Rounds: hard rules — recurrence before evidence, change sweep first, hypothesis-test missions need a ledgered hypothesis", () => {
  const src = skillSource();
  const section = src.slice(src.indexOf("### Hard rules"), src.indexOf("## Verdict"));
  assert.match(section, /[Rr]ecurrence before evidence/);
  assert.match(section, /[Cc]hange sweep first/);
  assert.match(section, /once a window exists/i);
  assert.match(section, /ledgered hypothes[ei]s/i);
  assert.match(section, /[Rr]elay refusal arrays verbatim/);
});

// ---------------------------------------------------------------------------
// Section 5 — Verdict (mirrors to-issues' readiness-gate language)
// ---------------------------------------------------------------------------

test("Verdict: relay eligibility verbatim, never decide it yourself, fails closed on absence", () => {
  const src = skillSource();
  const section = src.slice(src.indexOf("## Verdict"), src.indexOf("## Handoff"));
  assert.match(section, /eligibility/);
  assert.match(section, /verbatim/);
  assert.match(section, /[Dd]o not decide eligibility\s+yourself/);
  assert.match(section, /fail(?:s)? closed/i);
  assert.match(section, /same as\s*\n?\s*`?eligible:\s*false`?/i);
});

test("Verdict: names the positive path — eligible -> record_verdict root_caused with REQUIRED confidence (Fix Round 1, FIX 1)", () => {
  const src = skillSource();
  const section = src.slice(src.indexOf("## Verdict"), src.indexOf("## Handoff"));
  assert.match(section, /eligible:\s*true/);
  assert.match(section, /record_verdict/);
  assert.match(section, /root_caused/);
  assert.match(section, /confidence/);
  assert.match(section, /REQUIRED for a `?root_caused`? verdict/i);
  assert.match(section, /409/);
  assert.match(section, /mechanismSummary/);
});

test("Verdict: an open hypothesis has exactly two exits, settle or undetermined — never a deferred third", () => {
  const src = skillSource();
  const section = src.slice(src.indexOf("## Verdict"), src.indexOf("## Handoff"));
  assert.match(section, /exactly two honest exits/i);
  assert.match(section, /`undetermined`/);
  assert.match(section, /missingEvidence/);
  assert.match(section, /honest,?\s*\*{0,2}durable/i);
  assert.doesNotMatch(section, /defer/i, "must not offer deferral as an exit for an open hypothesis");
});

test("debug skill never mentions 'defer' anywhere (no deferred hypothesis exit)", () => {
  const src = skillSource();
  assert.doesNotMatch(src, /defer/i);
});

// ---------------------------------------------------------------------------
// Section 6 — Handoff
// ---------------------------------------------------------------------------

test("Handoff: mitigative vs preventative via gated create_issue (one approved call), qa fix-verification, lesson_candidate, console-only promotion", () => {
  const src = skillSource();
  const section = src.slice(src.indexOf("## Handoff"), src.indexOf("## Capability voice"));
  assert.match(section, /create_issue/);
  assert.match(section, /\bmitigative\b/);
  assert.match(section, /\bpreventative\b/);
  assert.match(section, /one approved call per issue/i);
  assert.match(section, /Role:\s*mitigative/);
  assert.match(section, /Role:\s*preventative/);
  assert.match(section, /dispatch `?qa`?/i);
  assert.match(section, /discriminating test/i);
  assert.match(section, /lesson_candidate/);
  assert.match(section, /console.{0,20}only|only.{0,20}console/is);
  assert.match(section, /no\s+model-side write path/i);
});

// ---------------------------------------------------------------------------
// Section 7 — Capability voice
// ---------------------------------------------------------------------------

test("Capability voice: capability-first rendering, providers as attribution only, gaps voiced at most twice", () => {
  const src = skillSource();
  const section = src.slice(src.indexOf("## Capability voice"));
  assert.match(section, /capability-first/i);
  assert.match(section, /I can inspect deployments \(GitHub, Railway\)/);
  assert.match(section, /never\s+becomes the subject of a sentence/i);
  assert.match(section, /at most twice/i);
  assert.match(section, /always\*{0,2}\s+recorded[\s\S]{0,60}evidence gap|evidence gap[\s\S]{0,60}always/i);
});

test("Capability voice: calls fetch_evidence_capabilities once at intake, grounding the rendering in reality (Fix Round 1, FIX 2)", () => {
  const src = skillSource();
  const section = src.slice(src.indexOf("## Capability voice"));
  assert.match(section, /fetch_evidence_capabilities/);
  assert.match(section, /once at intake/i);
});

// ---------------------------------------------------------------------------
// Provider-name discipline — enforced across the skill AND all three
// playbooks: Sentry/Datadog/Grafana absent entirely; GitHub/Railway allowed
// only immediately after an open-paren on the SAME line.
// ---------------------------------------------------------------------------

test("no banned observability provider names appear anywhere (Sentry/Datadog/Grafana absent entirely)", () => {
  for (const { label, src } of debugFiles()) {
    assert.doesNotMatch(src, /Sentry/i, `${label} must not name Sentry`);
    assert.doesNotMatch(src, /Datadog/i, `${label} must not name Datadog`);
    assert.doesNotMatch(src, /Grafana/i, `${label} must not name Grafana`);
  }
});

// Fix Round 1, FIX 5: the original check only asked "does SOME '(' appear
// earlier on this line" (`line.lastIndexOf("(", idx) !== -1`) — which a line
// like "(see above) GitHub is great" satisfies (there IS an earlier "("),
// even though that paren was already CLOSED before "GitHub" and the word is
// genuinely the sentence's subject. The fix: count "(" minus ")" in the
// PREFIX before the mention and require it to be strictly positive — i.e.
// the parenthetical must still be OPEN at that exact position, not merely
// have existed earlier on the line.
function isInsideOpenParen(line, idx) {
  const prefix = line.slice(0, idx);
  const opens = (prefix.match(/\(/g) || []).length;
  const closes = (prefix.match(/\)/g) || []).length;
  return opens - closes > 0;
}

test("isInsideOpenParen: rejects a mention after a CLOSED parenthetical — the exact bypass the old test missed", () => {
  const bypassLine = "(see above) GitHub is great";
  const idx = bypassLine.indexOf("GitHub");
  assert.equal(
    isInsideOpenParen(bypassLine, idx),
    false,
    "a closed paren earlier on the line must not count as 'open' at the mention",
  );
  // The OLD check would have wrongly passed this exact line (some earlier
  // "(" exists), which is precisely why it needed replacing, not patching.
  assert.notEqual(bypassLine.lastIndexOf("(", idx), -1, "sanity: the old, weaker check WOULD have passed this line");
});

test("isInsideOpenParen: accepts a mention genuinely inside a still-open parenthetical", () => {
  const goodLine = "I can inspect deployments (GitHub, Railway).";
  assert.equal(isInsideOpenParen(goodLine, goodLine.indexOf("GitHub")), true);
  assert.equal(isInsideOpenParen(goodLine, goodLine.indexOf("Railway")), true);
});

test("GitHub/Railway are never a sentence subject — every occurrence sits inside a still-OPEN parenthetical on its own line", () => {
  for (const { label, src } of debugFiles()) {
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      for (const provider of ["GitHub", "Railway"]) {
        let from = 0;
        let idx;
        while ((idx = line.indexOf(provider, from)) !== -1) {
          assert.ok(
            isInsideOpenParen(line, idx),
            `${label} line ${i + 1} mentions "${provider}" outside a still-open parenthetical: ${line}`,
          );
          from = idx + provider.length;
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Playbooks — each names >= 2 discriminating tests under a pinned heading,
// and covers its assigned shape/trap.
// ---------------------------------------------------------------------------

test("each playbook has a 'Discriminating tests' heading listing at least two items", () => {
  for (const name of PLAYBOOK_FILES) {
    const src = playbookSource(name);
    const headingMatch = src.match(/^##+ Discriminating tests\s*$/m);
    assert.ok(headingMatch, `${name} must have a "## Discriminating tests" heading`);
    const rest = src.slice(headingMatch.index + headingMatch[0].length);
    const nextHeadingMatch = rest.match(/^##+ /m);
    const section = nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;
    const items = section.split("\n").filter((l) => /^\s*-\s+\S/.test(l));
    assert.ok(items.length >= 2, `${name} must list >= 2 discriminating tests, found ${items.length}`);
  }
});

test("regression-after-deploy: change sweep first, rollback surfaced early, recency-bias trap", () => {
  const src = playbookSource("regression-after-deploy.md");
  assert.match(src, /change.sweep/i);
  assert.match(src, /[Rr]ollback/);
  assert.match(src, /recency bias/i);
  assert.match(src, /deploy.{0,60}timestamp/is);
  assert.match(src, /traffic/i);
});

test("latency-creep: anomaly-first with a signals gap, averaging-hides-p99 trap, cohort cut, first-deviation ordering", () => {
  const src = playbookSource("latency-creep.md");
  assert.match(src, /anomaly/i);
  assert.match(src, /no_provider/);
  assert.match(src, /signals/);
  assert.match(src, /p99/i);
  assert.match(src, /cohort/i);
  assert.match(src, /first/i);
});

test("cannot-reproduce: witness depth, exact-cohort differential, heisenbug trap, honest undetermined", () => {
  const src = playbookSource("cannot-reproduce.md");
  assert.match(src, /witness interview/i);
  assert.match(src, /heisenbug/i);
  assert.match(src, /exact cohort|EXACT cohort/);
  assert.match(src, /undetermined/);
  assert.match(src, /what would settle it|would actually settle it|settle it next time/i);
});

// ---------------------------------------------------------------------------
// instructions.md — the routing section
// ---------------------------------------------------------------------------

test('instructions.md has the pinned "## Debugging" heading, placed after Briefs', () => {
  const src = readFileSync(instructionsPath, "utf8");
  assert.match(src, /## Debugging \(fetch_investigations \/ save_investigation \/ record_verdict\)/);
  const briefsIdx = src.indexOf("## Briefs");
  const debugIdx = src.indexOf("## Debugging (fetch_investigations");
  assert.notEqual(briefsIdx, -1, "expected an existing ## Briefs section");
  assert.ok(debugIdx > briefsIdx, "the Debugging section must come after Briefs");
});

test("instructions.md's Debugging section: mode guidance (run-scoped -> run mode; recurrence/production/degraded -> investigation)", () => {
  const src = readFileSync(instructionsPath, "utf8");
  const start = src.indexOf("## Debugging (fetch_investigations");
  const end = src.indexOf("## Diagnosing a failed run");
  assert.notEqual(end, -1, "expected the existing 'Diagnosing a failed run' section to still follow");
  const section = src.slice(start, end);
  assert.match(section, /run mode/i);
  assert.match(section, /[Rr]ecurrence/);
  assert.match(section, /production/i);
  assert.match(section, /debug`? skill/);
});

test("instructions.md's Debugging section states the qa/triage boundary (\"qa validates\")", () => {
  const src = readFileSync(instructionsPath, "utf8");
  const start = src.indexOf("## Debugging (fetch_investigations");
  const end = src.indexOf("## Diagnosing a failed run");
  const section = src.slice(start, end);
  assert.match(section, /qa validates/i);
});

test("instructions.md's Debugging section lists all four investigation tools, one line each (fetch_evidence_capabilities added Fix Round 1, FIX 2)", () => {
  const src = readFileSync(instructionsPath, "utf8");
  const start = src.indexOf("## Debugging (fetch_investigations");
  const end = src.indexOf("## Diagnosing a failed run");
  const section = src.slice(start, end);
  assert.match(section, /fetch_investigations/);
  assert.match(section, /fetch_evidence_capabilities/);
  assert.match(section, /save_investigation/);
  assert.match(section, /record_verdict/);
});

test("instructions.md wires the debug skill into Jace's persona", () => {
  const src = readFileSync(instructionsPath, "utf8");
  assert.match(src, /`debug`\s+skill|\bdebug skill\b/);
});
