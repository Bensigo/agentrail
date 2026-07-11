// AC3 — the researcher subagent has ZERO write capability and is isolated from
// the factory's single write path (create_issue).
//
// Two mechanisms make this true, and this test PROVES both:
//
//   A. Isolation. Eve's boundary means a declared subagent inherits nothing
//      from the root's authored slots — it sees only the tools/connections
//      authored under its OWN directory. So it physically cannot see or call
//      root's create_issue. We prove no file under the subagent references
//      create_issue or any other write path (child_process, execFile,
//      gh issue create, octokit, linear).
//
//   B. Harness lock-down. Isolation is NOT enough on its own: Eve injects a
//      DEFAULT HARNESS into every agent at runtime — bash, write_file,
//      read_file, glob, grep, web_fetch, web_search, todo, ask_question,
//      load_skill — regardless of the authored tools list. bash and write_file
//      are genuine write capabilities. So the researcher authors a tools/
//      directory of disable sentinels (each `tools/<name>.ts` default-exports
//      disableTool()) that strips the ENTIRE default harness, leaving only the
//      dynamic connection_search — its sole means of reaching the two read-only
//      MCP connections. We prove the sentinels grant nothing and cover every
//      write-capable harness tool.
//
//   C. Connections. Its two connections are declared with an ALLOW-list
//      (smallest surface), and neither carries an approval gate (a read-only
//      source has nothing to gate — and a blanket always() would read as a
//      second write path).
//
// The complementary guarantee — that root's write surface is UNCHANGED — is
// covered by no-second-write-path.test.mjs (its agent/tools scan is
// non-recursive, so a subagent cannot expand the enumerated tool set, and its
// child_process scan is recursive, so a subagent cannot smuggle one in).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const researcherDir = fileURLToPath(
  new URL("../agent/subagents/researcher", import.meta.url),
);
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

// Strip `//` and `/* */` comments before scanning for write paths, so prose
// that *documents* the read-only guarantee (e.g. "cannot see create_issue")
// isn't read as a write path. None of these files put "//" or "/*" inside a
// string/template literal, so this plain strip is safe here.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("the researcher subagent exists with agent.ts + instructions.md", () => {
  assert.ok(existsSync(`${researcherDir}/agent.ts`), "researcher must have an agent.ts");
  assert.ok(
    existsSync(`${researcherDir}/instructions.md`),
    "researcher must have its own instructions.md",
  );
});

// The default harness Eve injects into EVERY agent at runtime, verified against
// the installed eve@0.19.0 runtime (runtime/framework-tools ALL_FRAMEWORK_TOOLS
// — bash/write_file/read_file/glob/grep/todo/ask_question/web_fetch/web_search/
// load_skill), PLUS the dynamic connection_search that appears only when an
// agent declares connections. A tools/<name>.ts that default-exports
// disableTool() drops that framework tool from the agent's runtime registry;
// the resolver THROWS if <name> isn't a real framework tool, so a stray/misnamed
// sentinel can't slip through a build.
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
// The subset that can mutate the world — the AC3 "zero write capability" core.
const WRITE_CAPABLE_HARNESS_TOOLS = ["bash", "write_file"];

test("the researcher disables the default harness down to connection_search only", () => {
  const toolsDir = `${researcherDir}/tools`;
  assert.ok(
    existsSync(toolsDir),
    "researcher must author a tools/ directory of disableTool() sentinels that " +
      "strip Eve's default harness (isolation alone does NOT remove bash/write_file)",
  );

  const disabled = new Set();
  for (const entry of readdirSync(toolsDir)) {
    if (!entry.endsWith(".ts")) continue;
    const src = readFileSync(`${toolsDir}/${entry}`, "utf8");
    // A sentinel DISABLES — it must never DEFINE a real (capability-granting) tool.
    assert.doesNotMatch(
      src,
      /defineTool\s*\(/,
      `tools/${entry} must be a disable sentinel, not a tool definition`,
    );
    assert.match(
      src,
      /export\s+default\s+disableTool\(\)/,
      `tools/${entry} must default-export disableTool()`,
    );
    assert.match(
      src,
      /from\s+["']eve\/tools["']/,
      `tools/${entry} must import disableTool from "eve/tools"`,
    );
    disabled.add(entry.replace(/\.ts$/, ""));
  }

  // The AC3 core: every write-capable harness tool is disabled.
  for (const name of WRITE_CAPABLE_HARNESS_TOOLS) {
    assert.ok(
      disabled.has(name),
      `write-capable framework tool "${name}" must be disabled (tools/${name}.ts)`,
    );
  }
  // In fact the researcher strips the ENTIRE default harness, so its only
  // runtime tool is connection_search (its read-only RAG channel).
  for (const name of FRAMEWORK_HARNESS_TOOLS) {
    assert.ok(
      disabled.has(name),
      `framework tool "${name}" must be disabled (tools/${name}.ts)`,
    );
  }
  // connection_search must NOT be disabled — it is the researcher's sole means
  // of reaching its two read-only MCP connections (the RAG retrieve step).
  assert.ok(
    !disabled.has("connection_search"),
    "connection_search must remain enabled — it is the researcher's only tool",
  );
  // No stray sentinel (a name that isn't a real framework tool would throw at
  // resolve time, but fail fast here with a clearer message).
  for (const name of disabled) {
    assert.ok(
      FRAMEWORK_HARNESS_TOOLS.includes(name),
      `unexpected sentinel tools/${name}.ts — not a known framework harness tool`,
    );
  }
});

test("no file under the researcher references a write path", () => {
  const WRITE_PATH_RE =
    /defineTool|create_issue|child_process|execFile|gh issue create|octokit|linear/i;
  for (const file of sourceFiles(researcherDir)) {
    const src = stripComments(readFileSync(file, "utf8"));
    assert.doesNotMatch(
      src,
      WRITE_PATH_RE,
      `${file.replace(researcherDir, "researcher")} must not reference any write path`,
    );
  }
});

test("both researcher connections are read-only allow-lists with no approval gate", () => {
  const connDir = `${researcherDir}/connections`;
  const files = readdirSync(connDir).filter((f) => f.endsWith(".ts")).sort();
  assert.deepEqual(
    files,
    ["context7.ts", "playwright.ts"],
    "researcher must declare exactly the context7 + playwright connections",
  );
  for (const f of files) {
    const src = readFileSync(`${connDir}/${f}`, "utf8");
    assert.match(src, /defineMcpClientConnection\(/, `${f} must be an MCP connection`);
    assert.match(src, /tools:\s*\{\s*allow:/, `${f} must restrict tools with an allow-list`);
    assert.doesNotMatch(
      src,
      /approval:\s*(always|once)\(/,
      `${f} is read-only and must not carry an approval gate`,
    );
  }
});
