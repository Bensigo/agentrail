// Task 10 (debugging design spec: docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md;
// spec PR #1501) — the regression pins for the debugger's two NESTED MISSION
// INVESTIGATORS, `change` and `anomaly`, living at
// agent/subagents/triage/subagents/{change,anomaly}/ (Eve's nested-declared-
// subagent convention: a full agent root that inherits nothing from its
// parent or from root).
//
// Six things are pinned here, mirroring the house pattern for a subagent's
// own regression suite (test/debugger-schema.test.mjs for the schema shape,
// test/debugger-instructions.test.mjs for instruction-file content,
// test/triage-read-only.test.mjs for sentinel completeness):
//
//   1. CHANGE_SCHEMA / ANOMALY_SCHEMA — pinned shape (required fields,
//      additionalProperties:false, evidence_refs minItems:1 on every
//      claim-bearing array) validated against real fixtures.
//   2. Both investigators' tools/ directories strip the ENTIRE default
//      harness (10 disableTool() sentinels) and author EXACTLY the four
//      read-only evidence-verb tools (fetch_changes, fetch_signals,
//      fetch_traces, search_events — widened from two to four by Task P1,
//      Evidence Providers Wave 2: .superpowers/sdd/plan-providers.md). No
//      file in either investigator's ENTIRE tree (not just tools/) imports a
//      database client — the replacement coverage for what
//      test/triage-read-only.test.mjs's own write-path/DB-client scan used
//      to provide here, before that test's sourceFiles() was deliberately
//      scoped to skip `subagents/` (see that file's own comment). The other
//      write-capability vectors (an approval gate, the create_issue-shaped
//      write path, child_process/execFile) stay independently covered by
//      test/no-second-write-path.test.mjs's own recursive scans.
//   3. Both instructions.md files: mission-scoped ("ONE question"), an
//      Untrusted content section, and the literal absence of any
//      "Sentry"/"Datadog"/"Grafana" string (they have no v1 role in
//      prompts — the simplest enforceable proxy for "never name a provider
//      as the subject of a sentence"). anomaly's additionally names
//      normal_surfaces + first_deviation.
//   4. Both agent.ts files: outputSchema wired to the right schema, and NO
//      haiku-class model override (investigators use the default gateway
//      model — Global Constraints/task brief: "do not pre-optimize").
//   5. THE SYNC TEST: triage's lib/evidence_verbs.core.mjs and both
//      investigators' copies are byte-identical (via content hash) except
//      for the ONE line that cannot mechanically be identical — the
//      relative import of the shared agent/lib/sanitize-untrusted.core.mjs
//      hardener, whose "../" hop count depends on how deep the importing
//      file sits (triage/lib is 3 hops from agent/lib; the nested
//      investigators' lib/ dirs are 5, two levels deeper). A DIFFERENT
//      hash on ANY other line means the copies drifted; a dynamic-import
//      smoke test on top proves the deeper hop count actually resolves
//      (Node throws ERR_MODULE_NOT_FOUND at import time otherwise) and that
//      all three copies behave identically, not just read identically.
//
// The validator below is the SAME minimal, dependency-free JSON-Schema-
// subset interpreter test/debugger-schema.test.mjs already defines
// (deliberately NOT a general engine — this repo has no ajv/schema-
// validator dependency anywhere) — copied rather than imported, matching
// this codebase's convention that test infrastructure is self-contained
// per file, not shared across test files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { CHANGE_SCHEMA } from "../agent/subagents/triage/subagents/change/lib/change.core.mjs";
import { ANOMALY_SCHEMA } from "../agent/subagents/triage/subagents/anomaly/lib/anomaly.core.mjs";

// ---------------------------------------------------------------------------
// Minimal JSON-Schema-subset validator (test-only — see file header).
// Supports exactly what CHANGE_SCHEMA/ANOMALY_SCHEMA use: type
// (object/array/string), required, properties, additionalProperties:false,
// items, minItems, minLength.
// ---------------------------------------------------------------------------

function validateAgainstSchema(schema, data, path = "$") {
  const errors = [];

  if (schema.type === "string") {
    if (typeof data !== "string") {
      errors.push(`${path}: expected string, got ${typeof data}`);
    } else if (typeof schema.minLength === "number" && data.length < schema.minLength) {
      errors.push(`${path}: expected minLength ${schema.minLength}, got length ${data.length}`);
    }
    return { ok: errors.length === 0, errors };
  }

  if (schema.type === "object") {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, errors: [`${path}: expected object`] };
    }
    for (const key of schema.required ?? []) {
      if (!(key in data)) errors.push(`${path}: missing required "${key}"`);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(data)) {
        if (!allowed.has(key)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
    for (const [key, subschema] of Object.entries(schema.properties ?? {})) {
      if (key in data) {
        const res = validateAgainstSchema(subschema, data[key], `${path}.${key}`);
        errors.push(...res.errors);
      }
    }
    return { ok: errors.length === 0, errors };
  }

  if (schema.type === "array") {
    if (!Array.isArray(data)) return { ok: false, errors: [`${path}: expected array`] };
    if (typeof schema.minItems === "number" && data.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} items, got ${data.length}`);
    }
    if (schema.items) {
      data.forEach((item, i) => {
        const res = validateAgainstSchema(schema.items, item, `${path}[${i}]`);
        errors.push(...res.errors);
      });
    }
    return { ok: errors.length === 0, errors };
  }

  return { ok: false, errors: [`${path}: unsupported schema node ${JSON.stringify(schema)}`] };
}

function validate(schema, data) {
  return validateAgainstSchema(schema, data).ok;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function changeFixture() {
  return {
    candidates: [
      {
        what: "Deploy of PR #212 (removed connection-pool size cap)",
        at: "2026-07-29T13:56:00Z",
        why_relevant: "Touches the exact checkout DB path that started erroring 4 minutes later.",
        evidence_refs: ["ev_github_1"],
      },
    ],
    degraded: ["No metrics provider connected for this workspace — cannot confirm pool saturation directly."],
  };
}

function anomalyFixture() {
  return {
    deviations: [
      {
        where: "checkout service, POST /api/checkout",
        shape: "Error rate spikes from ~0.1% to 22% starting 13:59:40Z.",
        evidence_refs: ["ev_factory_9"],
      },
    ],
    signatures: ["FATAL: remaining connection slots are reserved"],
    normal_surfaces: ["auth service — steady error rate and latency throughout the window"],
    first_deviation: "checkout service error rate, 13:59:40Z",
    degraded: [],
  };
}

// ---------------------------------------------------------------------------
// 1. CHANGE_SCHEMA / ANOMALY_SCHEMA — pinned shape
// ---------------------------------------------------------------------------

test("CHANGE_SCHEMA: pinned shape — required, additionalProperties:false, evidence_refs minItems:1", () => {
  assert.equal(CHANGE_SCHEMA.type, "object");
  assert.equal(CHANGE_SCHEMA.additionalProperties, false);
  assert.deepEqual(CHANGE_SCHEMA.required.sort(), ["candidates", "degraded"]);

  const candidateSchema = CHANGE_SCHEMA.properties.candidates.items;
  assert.equal(candidateSchema.additionalProperties, false);
  assert.deepEqual(candidateSchema.required.sort(), ["at", "evidence_refs", "what", "why_relevant"]);
  assert.equal(
    candidateSchema.properties.evidence_refs.minItems,
    1,
    "a change candidate is a claim — it must cite at least one evidence_ref",
  );

  assert.equal(CHANGE_SCHEMA.properties.degraded.type, "array");
});

test("ANOMALY_SCHEMA: pinned shape — required, additionalProperties:false, evidence_refs minItems:1", () => {
  assert.equal(ANOMALY_SCHEMA.type, "object");
  assert.equal(ANOMALY_SCHEMA.additionalProperties, false);
  assert.deepEqual(ANOMALY_SCHEMA.required.sort(), [
    "deviations",
    "first_deviation",
    "normal_surfaces",
    "signatures",
    "degraded",
  ].sort());

  const deviationSchema = ANOMALY_SCHEMA.properties.deviations.items;
  assert.equal(deviationSchema.additionalProperties, false);
  assert.deepEqual(deviationSchema.required.sort(), ["evidence_refs", "shape", "where"]);
  assert.equal(
    deviationSchema.properties.evidence_refs.minItems,
    1,
    "a deviation is a claim — it must cite at least one evidence_ref",
  );

  assert.equal(ANOMALY_SCHEMA.properties.signatures.type, "array");
  assert.equal(ANOMALY_SCHEMA.properties.normal_surfaces.type, "array");
  assert.equal(ANOMALY_SCHEMA.properties.first_deviation.type, "string");
  assert.equal(ANOMALY_SCHEMA.properties.degraded.type, "array");
});

// ---------------------------------------------------------------------------
// 2. Fixture validation
// ---------------------------------------------------------------------------

test("a well-formed change result validates against CHANGE_SCHEMA", () => {
  const res = validateAgainstSchema(CHANGE_SCHEMA, changeFixture());
  assert.ok(res.ok, `expected the change fixture to validate: ${res.errors.join("; ")}`);
});

test("a well-formed anomaly result validates against ANOMALY_SCHEMA", () => {
  const res = validateAgainstSchema(ANOMALY_SCHEMA, anomalyFixture());
  assert.ok(res.ok, `expected the anomaly fixture to validate: ${res.errors.join("; ")}`);
});

test("validate() helper convenience wrapper reads true/false", () => {
  assert.equal(validate(CHANGE_SCHEMA, changeFixture()), true);
  assert.equal(validate(ANOMALY_SCHEMA, anomalyFixture()), true);
  assert.equal(validate(CHANGE_SCHEMA, { nonsense: true }), false);
  assert.equal(validate(ANOMALY_SCHEMA, { nonsense: true }), false);
});

test("a change candidate with an empty evidence_refs array is rejected (a claim needs at least one ref)", () => {
  const bad = changeFixture();
  bad.candidates[0].evidence_refs = [];
  assert.equal(validate(CHANGE_SCHEMA, bad), false);
});

test("an anomaly deviation with an empty evidence_refs array is rejected (a claim needs at least one ref)", () => {
  const bad = anomalyFixture();
  bad.deviations[0].evidence_refs = [];
  assert.equal(validate(ANOMALY_SCHEMA, bad), false);
});

test("an unknown top-level property is rejected on both schemas (additionalProperties:false)", () => {
  assert.equal(validate(CHANGE_SCHEMA, { ...changeFixture(), mode: "deep" }), false);
  assert.equal(validate(ANOMALY_SCHEMA, { ...anomalyFixture(), mode: "deep" }), false);
});

test("normal_surfaces/first_deviation/degraded may legitimately be empty — an ANOMALY_SCHEMA result is still valid", () => {
  const ok = anomalyFixture();
  ok.normal_surfaces = [];
  ok.first_deviation = "";
  ok.degraded = [];
  assert.equal(validate(ANOMALY_SCHEMA, ok), true);
});

// ---------------------------------------------------------------------------
// 3. Sentinel completeness + authored-tool set (both investigators)
// ---------------------------------------------------------------------------

const INVESTIGATORS = ["change", "anomaly"];

// The default harness Eve injects into EVERY agent at runtime (eve@0.19.0
// ALL_FRAMEWORK_TOOLS) — same list triage-read-only.test.mjs pins for the
// debugger itself.
const FRAMEWORK_HARNESS_TOOLS = [
  "ask_question",
  "bash",
  "glob",
  "grep",
  "load_skill",
  "read_file",
  "todo",
  "web_fetch",
  "web_search",
  "write_file",
];
const WRITE_CAPABLE_HARNESS_TOOLS = ["bash", "write_file"];
// Widened from two to four by Task P1 (Evidence Providers Wave 2:
// .superpowers/sdd/plan-providers.md) — fetch_signals/fetch_traces join
// fetch_changes/search_events, all four thin wrappers over the same shared
// evidence_verbs.core.mjs copy. 12 files per investigator tools/ dir (10
// harness sentinels + 2 authored) becomes 14 (10 + 4).
const AUTHORED_TOOLS = ["fetch_changes.ts", "fetch_signals.ts", "fetch_traces.ts", "search_events.ts"].sort();

function investigatorDir(name) {
  return fileURLToPath(new URL(`../agent/subagents/triage/subagents/${name}`, import.meta.url));
}

// Strip `//` and `/* */` comments before matching against source — same
// idiom test/triage-read-only.test.mjs and test/no-second-write-path.test.mjs
// already use, so prose that DOCUMENTS a decision (e.g. naming
// HAIKU_GATEWAY_MODEL_ID to explain why an agent does NOT use it) isn't read
// as a real reference. None of these files put "//" or "/*" inside a
// string/template literal, so this plain strip is safe here.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// Recursive source-file walker, mirroring test/triage-read-only.test.mjs's
// own `sourceFiles` — used below to scan each investigator's ENTIRE tree
// (not just its top-level tools/) for a database-client import. This is the
// replacement for coverage that test/triage-read-only.test.mjs's own
// "no file under triage references a write path or a database client" test
// used to provide for these two directories: that test's `sourceFiles()`
// scans triageDir recursively, but now deliberately SKIPS the `subagents/`
// directory (Task 10 review fix) so it stops misattributing change's/
// anomaly's own authored tools to triage's tool count. That skip removes
// four write-capability vectors' coverage of change/anomaly at once; three
// of the four stay independently enforced by
// test/no-second-write-path.test.mjs's own recursive scans (an approval
// gate — always()/once() or consoleGatedApproval — the create_issue-shaped
// write path, and child_process/execFile). The DB-client vector was NOT
// covered anywhere else, so it is asserted here instead, per-investigator.
const SOURCE_RE = /\.(ts|mjs|js)$/;
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE_RE.test(entry.name)) out.push(full);
  }
  return out;
}

// Mirrors triage-read-only.test.mjs:219 exactly — same regex, same
// "must not import a database client" message. Jace subagents read evidence
// over HTTP only; there is no ClickHouse client in Jace, and no subagent
// ever holds a direct postgres client.
const DB_CLIENT_RE = /from\s+["']postgres["']|from\s+["']@clickhouse\/client|clickhouse-client|createClient\(/i;

for (const name of INVESTIGATORS) {
  const dir = investigatorDir(name);

  test(`${name}: exists with agent.ts + instructions.md + lib/ + tools/`, () => {
    assert.ok(existsSync(`${dir}/agent.ts`), `${name} must have an agent.ts`);
    assert.ok(existsSync(`${dir}/instructions.md`), `${name} must have its own instructions.md`);
    assert.ok(existsSync(`${dir}/lib`), `${name} must have its own lib/`);
    assert.ok(existsSync(`${dir}/tools`), `${name} must have its own tools/`);
  });

  test(`${name}: strips the ENTIRE default harness via disableTool() sentinels`, () => {
    const toolsDir = `${dir}/tools`;
    const entries = readdirSync(toolsDir).filter((f) => f.endsWith(".ts"));

    const disabled = new Set();
    for (const entry of entries) {
      if (AUTHORED_TOOLS.includes(entry)) continue; // the two real tools, asserted below
      const src = readFileSync(`${toolsDir}/${entry}`, "utf8");
      assert.doesNotMatch(
        src,
        /defineTool\s*\(/,
        `${name}/tools/${entry} must be a disable sentinel, not a tool definition`,
      );
      assert.match(
        src,
        /export\s+default\s+disableTool\(\)/,
        `${name}/tools/${entry} must default-export disableTool()`,
      );
      assert.match(
        src,
        /from\s+["']eve\/tools["']/,
        `${name}/tools/${entry} must import disableTool from "eve/tools"`,
      );
      disabled.add(entry.replace(/\.ts$/, ""));
    }

    for (const toolName of WRITE_CAPABLE_HARNESS_TOOLS) {
      assert.ok(disabled.has(toolName), `${name}: write-capable framework tool "${toolName}" must be disabled`);
    }
    for (const toolName of FRAMEWORK_HARNESS_TOOLS) {
      assert.ok(disabled.has(toolName), `${name}: framework tool "${toolName}" must be disabled`);
    }
    assert.equal(disabled.size, FRAMEWORK_HARNESS_TOOLS.length, `${name}: exactly the 10 harness tools must be disabled — no more, no fewer`);
    assert.ok(
      !disabled.has("connection_search"),
      `${name} declares no connections, so there must be no connection_search sentinel`,
    );
    for (const toolName of disabled) {
      assert.ok(
        FRAMEWORK_HARNESS_TOOLS.includes(toolName),
        `${name}: unexpected sentinel tools/${toolName}.ts — not a known framework harness tool`,
      );
    }
  });

  test(`${name}: authors exactly its FOUR read-only tools — fetch_changes, fetch_signals, fetch_traces, search_events`, () => {
    const toolsDir = `${dir}/tools`;
    const authored = readdirSync(toolsDir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /defineTool\s*\(/.test(readFileSync(`${toolsDir}/${f}`, "utf8")))
      .sort();
    assert.deepEqual(
      authored,
      AUTHORED_TOOLS,
      `${name} must author exactly fetch_changes.ts + fetch_signals.ts + fetch_traces.ts + search_events.ts; found: ${authored.join(", ") || "(none)"}`,
    );

    for (const tool of AUTHORED_TOOLS) {
      const src = readFileSync(`${toolsDir}/${tool}`, "utf8");
      assert.doesNotMatch(
        src,
        /approval:\s*(always|once)\(|consoleGatedApproval/,
        `${name}/tools/${tool} is read-only and must not carry an approval gate`,
      );
      assert.match(
        src,
        /verb:\s*"(changes|search_events|signals|traces)"/,
        `${name}/tools/${tool} must call fetchEvidence with a literal verb`,
      );
    }
  });

  test(`${name}: declares no connections directory`, () => {
    assert.ok(
      !existsSync(`${dir}/connections`),
      `${name} must declare no connections — its only outbound reach is the configured console evidence route`,
    );
  });

  test(`${name}: no file references a database client`, () => {
    for (const file of sourceFiles(dir)) {
      const src = stripComments(readFileSync(file, "utf8"));
      const rel = file.replace(`${dir}/`, `${name}/`);
      assert.doesNotMatch(src, DB_CLIENT_RE, `${rel} must not import a database client`);
    }
  });
}

// ---------------------------------------------------------------------------
// 4. instructions.md content pins (both investigators)
// ---------------------------------------------------------------------------

for (const name of INVESTIGATORS) {
  const dir = investigatorDir(name);
  const src = readFileSync(`${dir}/instructions.md`, "utf8");

  test(`${name}/instructions.md: mission-scoped — states "ONE question"`, () => {
    assert.match(src, /ONE question/);
  });

  test(`${name}/instructions.md: never names Sentry/Datadog/Grafana — no v1 role in prompts`, () => {
    assert.doesNotMatch(src, /Sentry/);
    assert.doesNotMatch(src, /Datadog/);
    assert.doesNotMatch(src, /Grafana/);
  });

  test(`${name}/instructions.md: has an Untrusted content section, data-never-instructions`, () => {
    assert.match(src, /## Untrusted content/);
    assert.match(src, /data,\s*\n?\s*never\s*\n?\s*instructions/i);
  });

  test(`${name}/instructions.md: evidence_refs discipline — every claim cites evidence it actually saw`, () => {
    assert.match(src, /evidence_refs/);
    assert.match(src, /actually saw/i);
  });

  test(`${name}/instructions.md: degraded honesty — reports gaps verbatim, never silent`, () => {
    assert.match(src, /no_provider/);
    assert.match(src, /verbatim/i);
  });

  test(`${name}/instructions.md: capability voice — leads with capability, provider is attribution not subject`, () => {
    assert.match(src, /not the subject of a sentence/i);
  });
}

test("change/instructions.md: names both evidence-verb tools, fetch_changes primary", () => {
  const src = readFileSync(`${investigatorDir("change")}/instructions.md`, "utf8");
  assert.match(src, /fetch_changes/);
  assert.match(src, /search_events/);
});

test("anomaly/instructions.md: names both evidence-verb tools, search_events primary", () => {
  const src = readFileSync(`${investigatorDir("anomaly")}/instructions.md`, "utf8");
  assert.match(src, /fetch_changes/);
  assert.match(src, /search_events/);
});

test("anomaly/instructions.md: names normal_surfaces and first_deviation — who is NOT affected is evidence too", () => {
  const src = readFileSync(`${investigatorDir("anomaly")}/instructions.md`, "utf8");
  assert.match(src, /normal_surfaces/);
  assert.match(src, /first_deviation/);
  assert.match(src, /NOT affected is evidence/i);
});

// ---------------------------------------------------------------------------
// 5. agent.ts content pins (both investigators) — outputSchema wired, and
// NO haiku-class model override (Global Constraints/task brief: investigators
// use the default gateway model; "do not pre-optimize"). Reuses stripComments
// from section 3 above — both agent.ts files legitimately NAME
// HAIKU_GATEWAY_MODEL_ID in prose (explaining, by contrast, why THIS agent
// does not use it, the way triage's sibling does), so a raw string search
// would false-positive on the very sentence that justifies the pinned
// decision.
// ---------------------------------------------------------------------------

test("change/agent.ts: outputSchema is CHANGE_SCHEMA, no haiku override, description opens with the pinned phrase", () => {
  const src = readFileSync(`${investigatorDir("change")}/agent.ts`, "utf8");
  const code = stripComments(src);
  assert.match(code, /outputSchema:\s*CHANGE_SCHEMA/);
  assert.doesNotMatch(
    code,
    /HAIKU_GATEWAY_MODEL_ID/,
    "change's actual code (comments stripped) must not reference HAIKU_GATEWAY_MODEL_ID — it uses the default gateway model",
  );
  assert.match(code, /chooseModel\(process\.env\)/, "change must call chooseModel with no gatewayModelId override");
  assert.match(
    src,
    /Answers ONE question: what changed in this window that could plausibly affect the failing surface/,
  );
});

test("anomaly/agent.ts: outputSchema is ANOMALY_SCHEMA, no haiku override, description opens with the pinned phrase", () => {
  const src = readFileSync(`${investigatorDir("anomaly")}/agent.ts`, "utf8");
  const code = stripComments(src);
  assert.match(code, /outputSchema:\s*ANOMALY_SCHEMA/);
  assert.doesNotMatch(
    code,
    /HAIKU_GATEWAY_MODEL_ID/,
    "anomaly's actual code (comments stripped) must not reference HAIKU_GATEWAY_MODEL_ID — it uses the default gateway model",
  );
  assert.match(code, /chooseModel\(process\.env\)/, "anomaly must call chooseModel with no gatewayModelId override");
  assert.match(
    src,
    /Answers ONE question: where and when does the system deviate from baseline/,
  );
});

// ---------------------------------------------------------------------------
// 6. THE SYNC TEST — triage's evidence_verbs.core.mjs and both investigators'
// copies stay byte-identical, so drift is impossible without a failing test
// naming all three paths (mandatory, plan-pinned — see file header point 5).
// ---------------------------------------------------------------------------

const EVIDENCE_VERBS_PATHS = {
  triage: fileURLToPath(new URL("../agent/subagents/triage/lib/evidence_verbs.core.mjs", import.meta.url)),
  change: fileURLToPath(
    new URL("../agent/subagents/triage/subagents/change/lib/evidence_verbs.core.mjs", import.meta.url),
  ),
  anomaly: fileURLToPath(
    new URL("../agent/subagents/triage/subagents/anomaly/lib/evidence_verbs.core.mjs", import.meta.url),
  ),
};

// The ONE line that cannot be byte-identical: the relative import of the
// shared agent/lib/sanitize-untrusted.core.mjs hardener. triage/lib/ sits 3
// directory hops from agent/lib/; the nested investigators' lib/ dirs sit 5
// hops (two levels deeper — .../triage/subagents/<name>/lib/ vs .../triage/lib/).
// Both hop counts are verified to actually resolve on disk below — this
// normalization is not an excuse, it's a documented, checked exception.
// Line 67 (was 65 before Task P1 added two header lines widening VERBS from
// two to four — see evidence_verbs.core.mjs's own header comment).
const SANITIZE_IMPORT_RE = /from\s+"(?:\.\.\/)+lib\/sanitize-untrusted\.core\.mjs"/;
const SANITIZE_IMPORT_PLACEHOLDER = 'from "<sanitize-untrusted-import>"';

function normalizeForHash(src) {
  return src.replace(SANITIZE_IMPORT_RE, SANITIZE_IMPORT_PLACEHOLDER);
}

function hashOf(path) {
  return createHash("sha256").update(normalizeForHash(readFileSync(path, "utf8"))).digest("hex");
}

test("the sanitize-untrusted import is the ONLY line differing between triage's evidence_verbs.core.mjs and each investigator's copy", () => {
  const triageLines = readFileSync(EVIDENCE_VERBS_PATHS.triage, "utf8").split("\n");
  for (const name of ["change", "anomaly"]) {
    const lines = readFileSync(EVIDENCE_VERBS_PATHS[name], "utf8").split("\n");
    assert.equal(
      lines.length,
      triageLines.length,
      `${EVIDENCE_VERBS_PATHS[name]} must have the same line count as ${EVIDENCE_VERBS_PATHS.triage}`,
    );
    const diffLines = [];
    for (let i = 0; i < triageLines.length; i++) {
      if (triageLines[i] !== lines[i]) diffLines.push(i + 1);
    }
    assert.deepEqual(
      diffLines,
      [67],
      `expected exactly line 67 (the sanitize-untrusted import) to differ between ` +
        `${EVIDENCE_VERBS_PATHS.triage} and ${EVIDENCE_VERBS_PATHS[name]}; found differing lines: ${diffLines.join(", ") || "(none)"}`,
    );
    assert.match(
      lines[66],
      SANITIZE_IMPORT_RE,
      `${EVIDENCE_VERBS_PATHS[name]}:67 must still import hardenUntrusted from a relative ".../lib/sanitize-untrusted.core.mjs" path`,
    );
  }
});

test("SYNC: triage/lib, change/lib, and anomaly/lib evidence_verbs.core.mjs are byte-identical via content hash (normalized for the one mechanically-necessary import-depth line)", () => {
  const hashes = {
    triage: hashOf(EVIDENCE_VERBS_PATHS.triage),
    change: hashOf(EVIDENCE_VERBS_PATHS.change),
    anomaly: hashOf(EVIDENCE_VERBS_PATHS.anomaly),
  };
  assert.equal(
    hashes.change,
    hashes.triage,
    `change's evidence_verbs.core.mjs (${EVIDENCE_VERBS_PATHS.change}) has drifted from triage's ` +
      `(${EVIDENCE_VERBS_PATHS.triage}) — copies must stay in sync`,
  );
  assert.equal(
    hashes.anomaly,
    hashes.triage,
    `anomaly's evidence_verbs.core.mjs (${EVIDENCE_VERBS_PATHS.anomaly}) has drifted from triage's ` +
      `(${EVIDENCE_VERBS_PATHS.triage}) — copies must stay in sync`,
  );
  assert.equal(
    hashes.anomaly,
    hashes.change,
    `change's and anomaly's evidence_verbs.core.mjs copies (${EVIDENCE_VERBS_PATHS.change}, ` +
      `${EVIDENCE_VERBS_PATHS.anomaly}) have drifted from each other`,
  );
});

test("SYNC: each copy's deeper sanitize-untrusted import hop count actually resolves on disk (not just text-identical)", () => {
  for (const name of ["triage", "change", "anomaly"]) {
    const src = readFileSync(EVIDENCE_VERBS_PATHS[name], "utf8");
    const m = src.match(SANITIZE_IMPORT_RE);
    assert.ok(m, `${EVIDENCE_VERBS_PATHS[name]} must import hardenUntrusted from a relative sanitize-untrusted path`);
    const specifier = m[0].slice('from "'.length, -1);
    const resolved = fileURLToPath(new URL(specifier, `file://${EVIDENCE_VERBS_PATHS[name]}`));
    assert.ok(
      existsSync(resolved),
      `${EVIDENCE_VERBS_PATHS[name]}'s import "${specifier}" must resolve to a real file on disk (got ${resolved})`,
    );
  }
});

test("SYNC: all three evidence_verbs.core.mjs copies actually import() and behave identically, not just read identically", async () => {
  const [triageMod, changeMod, anomalyMod] = await Promise.all([
    import(EVIDENCE_VERBS_PATHS.triage),
    import(EVIDENCE_VERBS_PATHS.change),
    import(EVIDENCE_VERBS_PATHS.anomaly),
  ]);

  for (const mod of [changeMod, anomalyMod]) {
    assert.deepEqual(mod.VERBS, triageMod.VERBS);
    assert.deepEqual(mod.DEGRADATION_REASONS, triageMod.DEGRADATION_REASONS);
  }

  // A cheap, deterministic call through every copy's real fetchEvidence —
  // proves the deeper relative import actually resolved at runtime (a wrong
  // hop count throws ERR_MODULE_NOT_FOUND at import() above, before this
  // line ever runs) and that all three copies produce an identical result
  // for the same bad input.
  const blankSessionCall = { eveSessionId: "", verb: "changes", windowStart: "a", windowEnd: "b", transport: async () => {
    throw new Error("transport must not be called for a blank eveSessionId");
  } };
  const [triageResult, changeResult, anomalyResult] = await Promise.all([
    triageMod.fetchEvidence(blankSessionCall),
    changeMod.fetchEvidence(blankSessionCall),
    anomalyMod.fetchEvidence(blankSessionCall),
  ]);
  assert.deepEqual(changeResult, triageResult);
  assert.deepEqual(anomalyResult, triageResult);
  assert.deepEqual(triageResult, { ok: false, degraded: true, reason: "bad_request", note: triageResult.note });
});
