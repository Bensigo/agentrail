// The qa subagent's capability boundary, enforced as tests (spec AC3/AC4):
//  - Eve injects a default framework harness (bash, write_file, …) into EVERY
//    agent at runtime; each tools/<name>.ts default-exporting disableTool()
//    strips that tool. A MISNAMED sentinel throws at resolve under Node 24,
//    so we assert exact names.
//  - web_fetch is deliberately NOT sentineled (API-level QA needs it) and
//    connection_search is deliberately NOT sentineled (this agent declares
//    MCP connections; stripping connection_search would blind it to them).
//  - The subagent's own sources import no process/fs/DB capability beyond
//    its ONE authored tool, and its connections carry explicit allowlists
//    with no approval gate.
//
// WIDENING FROM ZERO TOOLS TO ONE (upload_evidence_image) is this task's own
// change (B2a §2, design: docs/superpowers/specs/
// 2026-08-02-b2-behavioral-evidence-design.md) — mirrors how
// reviewer-read-only.test.mjs documents its own one-to-five widening. QA
// stays otherwise exactly as isolated and read-only as before: the one
// authored tool is a narrowly-scoped, ungated write into Jace's OWN
// evidence-image store (never GitHub, never a second path into the
// factory), proved below the same way reviewer's authored tools are proved
// read-only — by scanning the tool's own source, not by trusting a comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const QA_DIR = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "agent",
  "subagents",
  "qa",
);
const TOOLS_DIR = path.join(QA_DIR, "tools");
const CONNECTIONS_DIR = path.join(QA_DIR, "connections");

// Eve's injected harness is 10 tools; qa keeps web_fetch, so 9 sentinels.
const QA_SENTINELED_TOOLS = [
  "bash",
  "write_file",
  "read_file",
  "glob",
  "grep",
  "web_search",
  "todo",
  "ask_question",
  "load_skill",
];
const KEPT_HARNESS_TOOLS = ["web_fetch"];

// The ONE authored tool (B2a §2). Legitimately uses defineTool, so it is
// EXCLUDED from the sentinel-only assertions and from the defineTool
// write-path scan below — same posture as reviewer-read-only.test.mjs's own
// AUTHORED_TOOLS ceiling-and-floor. Adding a second is a deliberate human
// edit here, not something a maker should do silently.
const AUTHORED_TOOLS = ["upload_evidence_image.ts"];

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

test("every sentinel exists and default-exports disableTool()", () => {
  for (const name of QA_SENTINELED_TOOLS) {
    const file = path.join(TOOLS_DIR, `${name}.ts`);
    assert.ok(existsSync(file), `missing sentinel tools/${name}.ts`);
    const src = readFileSync(file, "utf8");
    assert.match(src, /export\s+default\s+disableTool\(\)/, `${name}.ts must disable the tool`);
    assert.match(src, /from\s+["']eve\/tools["']/, `${name}.ts must import from eve/tools`);
    assert.ok(!src.includes("defineTool("), `${name}.ts must not define a tool`);
  }
});

test("tools/ contains the 9 sentinels plus the ONE authored tool (upload_evidence_image) — web_fetch and connection_search stay live", () => {
  const present = readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""))
    .sort();
  assert.deepEqual(
    present,
    [...QA_SENTINELED_TOOLS, ...AUTHORED_TOOLS.map((t) => t.replace(/\.ts$/, ""))].sort(),
  );
  for (const kept of [...KEPT_HARNESS_TOOLS, "connection_search"]) {
    assert.ok(!present.includes(kept), `${kept} must NOT be sentineled for qa`);
  }
});

test("qa sources carry no process/fs/DB capability, and author at most the one enumerated tool (upload_evidence_image)", () => {
  const banned = [
    /child_process/,
    /node:fs/,
    /from\s+["']fs["']/,
    /from\s+["']pg["']/,
    /drizzle/i,
  ];
  for (const file of sourceFiles(QA_DIR)) {
    const rel = path.relative(QA_DIR, file);
    const src = readFileSync(file, "utf8");
    for (const pattern of banned) {
      assert.ok(!pattern.test(src), `${rel} matches banned pattern ${pattern}`);
    }
    const isAuthoredTool = AUTHORED_TOOLS.some((t) => rel === path.join("tools", t));
    if (!isAuthoredTool) {
      assert.ok(
        !src.includes("defineTool("),
        `${rel} must not define a tool (only tools/${AUTHORED_TOOLS[0]} may)`,
      );
    }
  }
});

test("the one authored tool (upload_evidence_image) is a real, narrowly-scoped write: defineTool, no approval gate, resolves session the SUBAGENT way, calls the pure core", () => {
  const file = path.join(TOOLS_DIR, "upload_evidence_image.ts");
  assert.ok(existsSync(file), "missing apps/jace/agent/subagents/qa/tools/upload_evidence_image.ts");
  const src = readFileSync(file, "utf8");

  assert.match(src, /defineTool\(/, "upload_evidence_image.ts must be authored with defineTool");
  assert.doesNotMatch(
    src,
    /\bapproval\s*:/,
    "upload_evidence_image.ts must not wire any approval field — narrow + scoped, ungated by design (see its own doc-comment)",
  );
  // Same subagent-child-session pattern as the reviewer's context tools
  // (e.g. read_repo_file.ts): ctx.session.parent?.rootSessionId ?? ctx.session.id.
  assert.match(
    src,
    /ctx\?\.session\?\.parent\?\.rootSessionId\s*\?\?\s*ctx\?\.session\?\.id/,
    "upload_evidence_image.ts must resolve eveSessionId the SUBAGENT way (ctx.session.parent?.rootSessionId ?? ctx.session.id)",
  );
  assert.match(
    src,
    /from\s+["']\.\.\/lib\/upload_evidence_image\.core\.mjs["']/,
    "upload_evidence_image.ts must delegate to its pure core, not inline the HTTP call",
  );
  assert.match(src, /runUploadEvidenceImage\(/, "upload_evidence_image.ts must call runUploadEvidenceImage");
});

test("exactly two connections, allowlisted, with no approval gate", () => {
  const files = readdirSync(CONNECTIONS_DIR).filter((f) => f.endsWith(".ts")).sort();
  assert.deepEqual(files, ["agent-browser.ts", "browser-use.ts"]);
  for (const f of files) {
    const src = readFileSync(path.join(CONNECTIONS_DIR, f), "utf8");
    assert.match(src, /defineMcpClientConnection\(/, `${f} must be an MCP client connection`);
    assert.match(src, /tools:\s*\{\s*allow:/, `${f} must declare an explicit allowlist`);
    assert.ok(!/approval\s*:/.test(src), `${f} must not carry an approval gate`);
  }
});
