// AC3 — the enumerated-tools test.
//
// The name of this file overstates the invariant it actually enforces: it is
// NOT "no second write path" full stop — an ungated write path exists here by
// design (`send_connect_link`, issue #1263 PR ②), and a SECOND gated tool now
// exists too (`create_workspace`, issue #1264 PR ①). What this test actually
// proves is narrower and precise: every mutating tool is gated, and every
// ungated tool is self-scoped.
//
//   - Every GATED/mutating tool — authored with `defineTool` and
//     `approval: always()`, so every invocation pauses for a human before it
//     runs — must be in the enumerated `EXPECTED_MUTATING_TOOLS` set below.
//     Today that set is `create_issue` (Jace's only path into the factory:
//     GitHub issues, workspaces, builds) and `create_workspace` (creates a
//     real workspace, own product state — same gate class as create_issue,
//     see its own file doc-comment). The set is enumerated, not open-ended:
//     adding a THIRD gated tool requires deliberately editing
//     EXPECTED_MUTATING_TOOLS below — that edit IS the human review this
//     test exists to force, same as EXPECTED_TOOL_FILES below it.
//   - Any OTHER tool is allowed to write something only if it is
//     UNGATED-but-self-scoped: every target of its write must be derived
//     from the tool's OWN session context (e.g. `ctx.session.id`), never
//     from a model-chosen argument, so its blast radius is provably confined
//     to "the identity/session already talking to Jace right now" — never
//     another tenant, another user, or the factory. `send_connect_link` is
//     the sanctioned example: it takes NO model input and only ever
//     overwrites the CALLING conversation's own chat-identity link-token
//     slot, never GitHub or a workspace. See its own file doc-comment for
//     the full argument.
//   - Additional READ-ONLY tools may exist freely (and, where genuinely
//     needed, may shell out via `child_process`) without weakening either
//     guarantee above.
//
// Mechanically, this test proves the above by checking:
//
//   1. `agent/tools/` contains exactly the known, reviewed tool set:
//      `create_issue` + `create_workspace` (gated/mutating),
//      `send_connect_link` (ungated but self-scoped), and `standup` /
//      `codebase_query` / `fetch_workspace_memory` (read-only).
//      Adding/removing a tool file requires updating EXPECTED_TOOL_FILES
//      below — that edit IS the human review this test exists to force.
//   2. Of those, EXACTLY the tools in EXPECTED_MUTATING_TOOLS are GATED —
//      authored with `defineTool` and `approval: always()`. Every other tool
//      sets no `approval` field.
//   3. `node:child_process` is imported ONLY by the expected, reviewed sites:
//      the gated `create_issue` tool, and the read-only `codebase_query` tool
//      (which shells out via `execFile` — never a shell string — to the
//      read-only `agentrail context` CLI, restricted to an allowlist of
//      read-only subcommands). `create_workspace` reaches the console over
//      HTTP (like `send_connect_link`), never `child_process`. `standup`
//      reaches the database directly via `postgres` and must NOT appear here.
//
// String or comment mentions of "agentrail" elsewhere (docs, the driver
// harness's prompt) are not a write path — only an imported child_process is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const toolsDir = fileURLToPath(new URL("../agent/tools", import.meta.url));
const subagentsDir = fileURLToPath(new URL("../agent/subagents", import.meta.url));

const SOURCE_RE = /\.(ts|mjs|js)$/;
const CHILD_PROCESS_IMPORT_RE =
  /(?:from\s+["']node:child_process["'])|(?:from\s+["']child_process["'])|(?:require\(\s*["']node:?child_process["']\s*\))/;
const APPROVAL_ALWAYS_RE = /approval:\s*always\(\)/;

// Strip `//` line comments and `/* */` block comments before matching
// APPROVAL_ALWAYS_RE against real code. Several of these tool files document —
// in prose — that they deliberately do NOT set `approval: always()`, and that
// explanation quotes the very pattern being tested for; without stripping
// comments first, that prose reads as a false positive. None of these files
// have string/template literals containing "//" or "/*", so this plain strip
// is safe here (not a general-purpose JS/TS parser).
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// The known, reviewed tool set. A file appearing here or not is a deliberate
// human decision, not something a maker should silently expand.
const EXPECTED_TOOL_FILES = [
  "codebase_query.ts",
  "create_issue.ts",
  "create_workspace.ts", // gated: creates a real workspace (owned or owner-elect) — same gate class as create_issue; no child_process (HTTP to the console, like send_connect_link)
  "fetch_workspace_memory.ts", // read-only: reads workspace memory over the console bearer API; no approval, no child_process
  "send_connect_link.ts", // ungated write, but narrow + self-scoped (mints a link for the CALLING conversation's own chat identity only, never the factory); no child_process
  "standup.ts",
].sort();
// The enumerated set of gated/mutating tools. Every tool named here must set
// `approval: always()`; the test below also asserts no OTHER tool does — so
// this list is a ceiling as well as a floor. Adding a third entry is a
// deliberate human edit, not something a maker should do silently.
const EXPECTED_MUTATING_TOOLS = ["create_issue.ts", "create_workspace.ts"].sort();
const EXPECTED_CHILD_PROCESS_SITES = [
  "agent/tools/codebase_query.ts",
  "agent/tools/create_issue.ts",
].sort();

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

test("agent/tools exposes exactly the known, reviewed tool set", () => {
  const files = readdirSync(toolsDir)
    .filter((f) => SOURCE_RE.test(f))
    .sort();
  assert.deepEqual(
    files,
    EXPECTED_TOOL_FILES,
    `An unreviewed tool was added or removed under agent/tools/. Every tool ` +
      `must be deliberately classified as mutating or read-only (see the ` +
      `tests below) before EXPECTED_TOOL_FILES is updated. ` +
      `Found: ${files.join(", ") || "(none)"}`,
  );
});

test("agent/tools exposes exactly the enumerated GATED/mutating tools: create_issue, create_workspace", () => {
  const files = readdirSync(toolsDir).filter((f) => SOURCE_RE.test(f));
  const mutating = files
    .filter((f) =>
      APPROVAL_ALWAYS_RE.test(stripComments(readFileSync(`${toolsDir}/${f}`, "utf8"))),
    )
    .sort();
  assert.deepEqual(
    mutating,
    EXPECTED_MUTATING_TOOLS,
    `Every mutating tool must be gated (approval: always()), and the gated ` +
      `set is enumerated, not open-ended: an UNGATED mutating tool, or an ` +
      `unreviewed EXTRA gated tool, is a policy violation the moment it ` +
      `diverges from EXPECTED_MUTATING_TOOLS. Found: ${mutating.join(", ") || "(none)"}`,
  );
});

test("every enumerated gated tool is human-gated (defineTool + approval: always())", () => {
  for (const file of EXPECTED_MUTATING_TOOLS) {
    const src = stripComments(readFileSync(`${toolsDir}/${file}`, "utf8"));
    assert.match(src, /defineTool\(/, `${file} must be authored with defineTool`);
    assert.match(
      src,
      APPROVAL_ALWAYS_RE,
      `${file} must gate every invocation behind approval: always()`,
    );
  }
});

test("no subagent authors a mutating tool or a second write path", () => {
  // Declared subagents (agent/subagents/<id>/) are isolated from root and must
  // stay read-only: none may author its own human-gated mutating tool
  // (approval: always()/once()) or reference the factory's write path. A
  // subagent MAY author read-only tools with defineTool (e.g. triage's
  // fetch_run_evidence), so defineTool itself is not banned here — only actual
  // mutation is. This is the complementary guarantee to each subagent's own
  // read-only test (researcher-read-only, triage-read-only).
  if (!existsSync(subagentsDir)) return; // no subagents yet → nothing to check
  const WRITE_PATH_RE = /create_issue|gh issue create|octokit|linear/i;
  const APPROVAL_GATE_RE = /approval:\s*(?:always|once)\(/;
  for (const file of sourceFiles(subagentsDir)) {
    const src = stripComments(readFileSync(file, "utf8"));
    const rel = file.replace(appRoot, "");
    assert.doesNotMatch(
      src,
      APPROVAL_GATE_RE,
      `${rel} — a subagent must not author a human-gated mutating tool (that is a second write path)`,
    );
    assert.doesNotMatch(
      src,
      WRITE_PATH_RE,
      `${rel} — a subagent must not reference the factory's write path (create_issue / issue-create)`,
    );
  }
});

test("child_process is shelled out from ONLY the expected, reviewed sites", () => {
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
    EXPECTED_CHILD_PROCESS_SITES,
    `child_process must be imported ONLY by the reviewed sites (the gated ` +
      `create_issue tool, and the read-only codebase_query tool, which shells ` +
      `out via execFile — never a shell string — to the read-only agentrail ` +
      `context CLI). standup must NOT appear here: it reaches the database ` +
      `directly via postgres. Found in: ${shellOutSites.join(", ") || "(none)"}`,
  );
});
