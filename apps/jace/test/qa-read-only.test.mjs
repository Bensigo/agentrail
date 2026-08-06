// The qa subagent's capability boundary, enforced as tests (spec AC3/AC4):
//  - Eve injects a default framework harness (bash, write_file, …) into EVERY
//    agent at runtime; each tools/<name>.ts default-exporting disableTool()
//    strips that tool. A MISNAMED sentinel throws at resolve under Node 24,
//    so we assert exact names.
//  - web_fetch is deliberately NOT sentineled (API-level QA needs it) and
//    connection_search is deliberately NOT sentineled (this agent declares
//    MCP connections; stripping connection_search would blind it to them).
//  - The subagent's own sources import no process/fs/DB capability beyond
//    its three explicitly enumerated evidence-upload tools, and its connections carry explicit allowlists
//    with no approval gate.
//
// QA has three narrowly-scoped evidence upload tools: the historical generic
// image uploader plus exact-plan UI and API uploaders. None can post a review,
// change code, create a PR, or merge; their server boundaries derive or
// validate the exact Record/plan identity. The test keeps the set explicit so
// a new write tool cannot silently broaden the QA capability surface.
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

// The exact ceiling for QA-authored writes. Adding a fourth requires a
// deliberate review of its scope and corresponding proof.
const AUTHORED_TOOLS = [
  "upload_evidence_image.ts",
  "upload_verification_artifact.ts",
  "upload_verification_api_artifact.ts",
];

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

test("tools/ contains the 9 sentinels plus the three enumerated evidence upload tools — web_fetch and connection_search stay live", () => {
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

test("qa sources carry no process/fs/DB capability and define only enumerated evidence upload tools", () => {
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
        `${rel} must not define a tool outside ${AUTHORED_TOOLS.join(", ")}`,
      );
    }
  }
});

test("upload_evidence_image is a narrowly-scoped historical image upload: defineTool, no approval gate, session-derived targeting, and a pure core", () => {
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

test("upload_evidence_image's inputSchema is EXACTLY the 7 caller-supplied fields — no eveSessionId/workspaceId/key/url the model could use to target a cross-tenant destination or a raw storage key", () => {
  // Mirrors reviewer-read-only.test.mjs's assertion style (a structural scan
  // of the tool's own source, not a live call): the session — and therefore
  // the workspace — is resolved server-side from ctx (see the test above),
  // never accepted as model input; the destination key/url are computed by
  // the console (artifactKey) and returned, never supplied. This is an
  // enumerated ceiling AND floor (ok-listed-fields.md idiom used throughout
  // this codebase, e.g. no-second-write-path.test.mjs's EXPECTED_TOOL_FILES):
  // adding a field to the schema is a deliberate edit here, not something
  // that should slip through silently.
  const file = path.join(TOOLS_DIR, "upload_evidence_image.ts");
  const src = readFileSync(file, "utf8");

  const schemaMatch = src.match(/inputSchema:\s*z\.object\(\{([\s\S]*?)\n\s*\}\),\n\s*async execute/);
  assert.ok(schemaMatch, "could not locate upload_evidence_image.ts's inputSchema: z.object({ ... }) block");
  const schemaBody = schemaMatch[1];

  const FORBIDDEN_FIELDS = ["eveSessionId", "workspaceId", "key", "url"];
  for (const field of FORBIDDEN_FIELDS) {
    assert.doesNotMatch(
      schemaBody,
      new RegExp(`\\b${field}\\s*:`),
      `upload_evidence_image.ts's inputSchema must not accept a model-supplied '${field}' — ` +
        `the session (and therefore workspace) is resolved server-side from ctx, and the ` +
        `destination key/url are computed by the console and returned, never accepted`,
    );
  }

  // The positive floor: exactly these 7 top-level fields, nothing more,
  // nothing less. A field name is a line matching `<name>: z` at the
  // schema body's own indentation — `\b` (not a literal `.`) because some
  // fields chain onto the next line (e.g. `index: z\n  .number()...`)
  // rather than opening with `z.` on the same line.
  const declaredFields = [...schemaBody.matchAll(/^\s*(\w+):\s*z\b/gm)].map((m) => m[1]).sort();
  const EXPECTED_FIELDS = ["acId", "index", "imageBase64", "contentType", "repo", "prNumber", "headSha"].sort();
  assert.deepEqual(
    declaredFields,
    EXPECTED_FIELDS,
    `upload_evidence_image.ts's inputSchema must declare exactly ${EXPECTED_FIELDS.join(", ")} — found ${declaredFields.join(", ") || "(none)"}`,
  );
});

test("plan-bound UI and API upload tools are the only additional QA writes and delegate to their guarded cores", () => {
  const planBoundTools = [
    ["upload_verification_artifact.ts", "upload_verification_artifact.core.mjs", "runUploadVerificationArtifact"],
    ["upload_verification_api_artifact.ts", "upload_verification_api_artifact.core.mjs", "runUploadVerificationApiArtifact"],
  ];
  for (const [fileName, coreName, runnerName] of planBoundTools) {
    const src = readFileSync(path.join(TOOLS_DIR, fileName), "utf8");
    assert.match(src, /defineTool\(/, `${fileName} must be an explicit QA tool`);
    assert.doesNotMatch(src, /\bapproval\s*:/, `${fileName} must not add an approval bypass`);
    assert.match(src, new RegExp(`from\\s+["']\\.\\.\\/lib\\/${coreName}["']`), `${fileName} must delegate to its guarded core`);
    assert.match(src, new RegExp(`${runnerName}\\(`), `${fileName} must invoke its guarded core`);
    assert.match(src, /collectedBy:\s*`qa:\$\{ctx\?\.session\?\.id/, `${fileName} must record the collecting QA session`);
  }
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
