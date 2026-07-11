// The qa subagent's capability boundary, enforced as tests (spec AC3/AC4):
//  - Eve injects a default framework harness (bash, write_file, …) into EVERY
//    agent at runtime; each tools/<name>.ts default-exporting disableTool()
//    strips that tool. A MISNAMED sentinel throws at resolve under Node 24,
//    so we assert exact names.
//  - web_fetch is deliberately NOT sentineled (API-level QA needs it) and
//    connection_search is deliberately NOT sentineled (this agent declares
//    MCP connections; stripping connection_search would blind it to them).
//  - The subagent's own sources import no process/fs/DB capability, and its
//    connections carry explicit allowlists with no approval gate.
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

test("tools/ contains ONLY the 9 sentinels — web_fetch and connection_search stay live", () => {
  const present = readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""))
    .sort();
  assert.deepEqual(present, [...QA_SENTINELED_TOOLS].sort());
  for (const kept of [...KEPT_HARNESS_TOOLS, "connection_search"]) {
    assert.ok(!present.includes(kept), `${kept} must NOT be sentineled for qa`);
  }
});

test("qa sources carry no process/fs/DB capability and author no tools", () => {
  const banned = [
    /child_process/,
    /node:fs/,
    /from\s+["']fs["']/,
    /from\s+["']pg["']/,
    /drizzle/i,
    /defineTool\(/,
  ];
  for (const file of sourceFiles(QA_DIR)) {
    const src = readFileSync(file, "utf8");
    for (const pattern of banned) {
      assert.ok(
        !pattern.test(src),
        `${path.relative(QA_DIR, file)} matches banned pattern ${pattern}`,
      );
    }
  }
});

test("exactly two connections, allowlisted, with no approval gate", () => {
  const files = readdirSync(CONNECTIONS_DIR).filter((f) => f.endsWith(".ts")).sort();
  assert.deepEqual(files, ["agent_browser.ts", "browser_use.ts"]);
  for (const f of files) {
    const src = readFileSync(path.join(CONNECTIONS_DIR, f), "utf8");
    assert.match(src, /defineMcpClientConnection\(/, `${f} must be an MCP client connection`);
    assert.match(src, /tools:\s*\{\s*allow:/, `${f} must declare an explicit allowlist`);
    assert.ok(!/approval\s*:/.test(src), `${f} must not carry an approval gate`);
  }
});
