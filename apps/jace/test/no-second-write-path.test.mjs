// AC3 — no second write path into the factory (the "enumerated-tools" test).
//
// Jace's model can only act on the outside world through the Eve tools
// registered under `agent/tools/`. This test enumerates that directory and the
// app's runtime source to PROVE the factory write path is reachable only
// through the single, human-gated `create_issue` tool:
//
//   1. `agent/tools/` contains exactly one tool module: `create_issue`.
//   2. That tool is human-gated — authored with `defineTool` and
//      `approval: always()`, so every invocation pauses for a human.
//   3. The concrete shell-out capability (`node:child_process`, the only way to
//      invoke the `agentrail` CLI) lives in exactly ONE runtime file — the
//      gated tool. The pure core takes `execFileFn` by injection and cannot
//      shell out on its own; nothing else can either.
//
// String or comment mentions of "agentrail" elsewhere (docs, the driver
// harness's prompt) are not a write path — only an imported child_process is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const toolsDir = fileURLToPath(new URL("../agent/tools", import.meta.url));

const SOURCE_RE = /\.(ts|mjs|js)$/;
const CHILD_PROCESS_IMPORT_RE =
  /(?:from\s+["']node:child_process["'])|(?:from\s+["']child_process["'])|(?:require\(\s*["']node:?child_process["']\s*\))/;

// Recursively collect runtime source files under a directory.
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (SOURCE_RE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test("agent/tools exposes exactly one tool: create_issue", () => {
  const files = readdirSync(toolsDir)
    .filter((f) => SOURCE_RE.test(f))
    .sort();
  assert.deepEqual(
    files,
    ["create_issue.ts"],
    `Jace must expose exactly ONE tool (the gated create_issue); a second tool ` +
      `is a second potential write path. Found: ${files.join(", ") || "(none)"}`,
  );
});

test("the create_issue tool is human-gated (defineTool + approval: always())", () => {
  const src = readFileSync(`${toolsDir}/create_issue.ts`, "utf8");
  assert.match(
    src,
    /defineTool\(/,
    "create_issue must be authored with defineTool",
  );
  assert.match(
    src,
    /approval:\s*always\(\)/,
    "create_issue must gate every invocation behind approval: always()",
  );
});

test("only the gated tool can shell out into the factory (single child_process site)", () => {
  const runtimeDirs = [
    fileURLToPath(new URL("../agent", import.meta.url)),
    fileURLToPath(new URL("../scripts", import.meta.url)),
  ];
  const shellOutSites = [];
  for (const dir of runtimeDirs) {
    for (const file of sourceFiles(dir)) {
      const src = readFileSync(file, "utf8");
      if (CHILD_PROCESS_IMPORT_RE.test(src)) {
        shellOutSites.push(file.replace(appRoot, ""));
      }
    }
  }
  shellOutSites.sort();
  assert.deepEqual(
    shellOutSites,
    ["agent/tools/create_issue.ts"],
    `child_process (the only way to invoke the agentrail CLI) must live ONLY ` +
      `in the gated create_issue tool. Found in: ${shellOutSites.join(", ") || "(none)"}`,
  );
});
