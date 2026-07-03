// AC4 (static) — the codebase Q&A path never shells out via a command string.
//
// A companion to context_cli.core.test.mjs's runtime proof: this test reads the
// runtime source and asserts there is NO shell-string subprocess anywhere in the
// app —
//   * no `exec(` / `execSync(` (child_process's shell-string entry points),
//   * no `spawn(... { shell: true })` and no bare `shell: true` option,
//   * no template/`+`-concatenated command string handed to a child process.
//
// The Q&A core (context_cli.core.mjs) imports NO child_process at all — it only
// builds an args array and delegates to an injected execFile-style function. The
// single real shell-out site in the app is the gated create_issue tool, which
// uses execFile (args array), asserted by no-second-write-path.test.mjs. This
// test locks the whole app to the execFile-with-args-array discipline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_RE = /\.(ts|mjs|js)$/;

function sourceFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // directory may not exist
  }
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE_RE.test(entry.name)) out.push(full);
  }
  return out;
}

// Strip line and block comments so we assert on CODE, not documentation. A doc
// comment that *describes* the forbidden pattern ("never use shell:true") must
// not itself trip the check — only an actual code occurrence should.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/^\s*\/\/.*$/gm, ""); // whole-line // comments
}

function codeOf(file) {
  return stripComments(readFileSync(file, "utf8"));
}

const runtimeDirs = ["agent", "scripts"].map((d) =>
  fileURLToPath(new URL(`../${d}`, import.meta.url)),
);

// The shell:true escape hatch (exec/execSync are matched inline below).
const SHELL_TRUE_RE = /shell\s*:\s*true/;

test("AC4: no runtime file uses a shell-string subprocess (exec/execSync)", () => {
  const offenders = [];
  for (const dir of runtimeDirs) {
    for (const file of sourceFiles(dir)) {
      const code = codeOf(file);
      // Ignore `execFile`/`execFileSync` (args-array form) — only flag the
      // shell-string `exec(`/`execSync(`. Exclude the "File" prefix.
      const shellCalls = [...code.matchAll(/\bexec(Sync)?\s*\(/g)].filter((m) => {
        const before = code.slice(Math.max(0, m.index - 4), m.index);
        return !before.endsWith("File"); // exclude execFile / execFileSync
      });
      if (shellCalls.length) offenders.push(file.replace(appRoot, ""));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `shell-string exec()/execSync() found (use execFile with an args array instead): ${offenders.join(", ")}`,
  );
});

test("AC4: no runtime file passes shell:true to a subprocess", () => {
  const offenders = [];
  for (const dir of runtimeDirs) {
    for (const file of sourceFiles(dir)) {
      if (SHELL_TRUE_RE.test(codeOf(file))) offenders.push(file.replace(appRoot, ""));
    }
  }
  assert.deepEqual(offenders, [], `shell:true found: ${offenders.join(", ")}`);
});

test("AC4: the Q&A core imports no child_process (delegates via injected execFileFn)", () => {
  const qaCore = fileURLToPath(
    new URL("../agent/lib/context_cli.core.mjs", import.meta.url),
  );
  const code = codeOf(qaCore);
  // No import/require of child_process in CODE (doc comments may mention it).
  assert.ok(
    !/(?:import\s+[^;]*from\s+["']node:child_process["'])|(?:from\s+["']child_process["'])|(?:require\(\s*["']node:?child_process["']\s*\))/.test(
      code,
    ),
    "context_cli.core.mjs must not import child_process; it takes execFileFn by injection",
  );
  // And it must build an args array, not concatenate a command string.
  assert.match(code, /return \["context", sub, value, "--json"\]/);
});
