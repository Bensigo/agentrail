// AC3 — the enumerated-tools test.
//
// The name of this file overstates the invariant it actually enforces: it is
// NOT "no second write path" full stop — an ungated write path exists here by
// design (`send_connect_link`, issue #1263 PR ②), and the gated set has grown
// to FOUR (`create_workspace`, issue #1264 PR ①; `create_repo`, issue #1265
// PR ②; `update_issue`, issue #1345 PR ①). What this test actually proves is
// narrower and precise: every mutating tool is gated, and every ungated tool
// is self-scoped.
//
//   - Every GATED/mutating tool — authored with `defineTool` and
//     `approval: (ctx) => consoleGatedApproval(ctx)` (issue #1273 PR ②;
//     before that, `approval: always()` — Eve's stock HITL gate is now
//     fully retired for these four), so every invocation pauses for a
//     human before it runs — must be in the enumerated
//     `EXPECTED_MUTATING_TOOLS` set below. Today that set is `create_issue`
//     (Jace's only path into the factory: GitHub issues, workspaces,
//     builds), `create_workspace` (creates a real workspace, own product
//     state), `create_repo` (creates a real GitHub repository under the
//     user's own account and connects it to the workspace), and
//     `update_issue` (edits an EXISTING issue's title/body — the #1345
//     revise loop's write path) — all four are the same gate class, see
//     each tool's own file doc-comment. The set is enumerated, not
//     open-ended: adding a FIFTH gated tool requires deliberately editing
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
//      `create_issue` + `create_workspace` + `create_repo` + `update_issue`
//      (gated/mutating), `send_connect_link` (ungated but self-scoped), and
//      `standup` / `codebase_query` / `fetch_workspace_memory` (read-only).
//      Adding/removing a tool file requires updating EXPECTED_TOOL_FILES
//      below — that edit IS the human review this test exists to force.
//   2. Of those, EXACTLY the tools in EXPECTED_MUTATING_TOOLS are GATED —
//      authored with `defineTool` and `approval: (ctx) => consoleGatedApproval(ctx)`.
//      Every other tool sets no `approval` field. A separate negative check
//      below proves Eve's stock `always()` gate is fully retired: it must
//      not appear in ANY tool file, gated or not — the console seam is the
//      only gate mechanism a tool may wire.
//   3. `node:child_process` is imported ONLY by the expected, reviewed sites:
//      the gated `create_issue` and `update_issue` tools (both shell out to
//      the `agentrail issue create`/`issue update` CLI), and the read-only
//      `codebase_query` tool (which shells out via `execFile` — never a
//      shell string — to the read-only `agentrail context` CLI, restricted
//      to an allowlist of read-only subcommands). `create_workspace` and
//      `create_repo` each reach the console over HTTP (like
//      `send_connect_link`), never `child_process`. `standup` reaches the
//      database directly via `postgres` and must NOT appear here.
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
// The gated set's current mechanism (issue #1273 PR ②): a tool is gated by
// wiring its `approval` field to the shared consoleGatedApproval fn, not by
// calling Eve's own always()/once() helpers. Whitespace-tolerant but
// structural — it matches the exact wired shape, not just the presence of
// the word "approval" somewhere in the file (several of these tool files
// document, in prose, why they do or don't carry a gate).
const CONSOLE_GATED_APPROVAL_RE =
  /approval:\s*\(\s*ctx\s*\)\s*=>\s*consoleGatedApproval\(\s*ctx\s*\)/;
// Eve's stock always()/once() approval helpers, retired for the gated set by
// PR ②. A bare `always(` catches both the call itself and (defensively) an
// import of it; either would mean the stock gate crept back in somewhere.
const ALWAYS_CALL_RE = /\balways\(/;

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
  "create_repo.ts", // gated: creates a real GitHub repo under the user's own account + connects it to the workspace — same gate class as create_issue; no child_process (HTTP to the console, like send_connect_link)
  "create_workspace.ts", // gated: creates a real workspace (owned or owner-elect) — same gate class as create_issue; no child_process (HTTP to the console, like send_connect_link)
  "fetch_workspace_memory.ts", // read-only: reads workspace memory over the console bearer API; no approval, no child_process
  "send_connect_link.ts", // ungated write, but narrow + self-scoped (mints a link for the CALLING conversation's own chat identity only, never the factory); no child_process
  "standup.ts",
  "update_issue.ts", // gated (issue #1345): edits an EXISTING issue's title/body in the house format — same gate class as create_issue, via the SAME consoleGatedApproval seam; shells out to `agentrail issue update` (child_process, like create_issue)
].sort();
// The enumerated set of gated/mutating tools. Every tool named here must
// wire `approval: (ctx) => consoleGatedApproval(ctx)`; the test below also
// asserts no OTHER tool does — so this list is a ceiling as well as a floor.
// Adding a fourth entry is a deliberate human edit, not something a maker
// should do silently.
const EXPECTED_MUTATING_TOOLS = [
  "create_issue.ts",
  "create_workspace.ts",
  "create_repo.ts",
  "update_issue.ts",
].sort();
const EXPECTED_CHILD_PROCESS_SITES = [
  "agent/tools/codebase_query.ts",
  "agent/tools/create_issue.ts",
  "agent/tools/update_issue.ts",
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

test("agent/tools exposes exactly the enumerated GATED/mutating tools: create_issue, create_workspace, create_repo, update_issue", () => {
  const files = readdirSync(toolsDir).filter((f) => SOURCE_RE.test(f));
  const mutating = files
    .filter((f) =>
      CONSOLE_GATED_APPROVAL_RE.test(stripComments(readFileSync(`${toolsDir}/${f}`, "utf8"))),
    )
    .sort();
  assert.deepEqual(
    mutating,
    EXPECTED_MUTATING_TOOLS,
    `Every mutating tool must be gated (approval: (ctx) => consoleGatedApproval(ctx)), ` +
      `and the gated set is enumerated, not open-ended: an UNGATED mutating ` +
      `tool, or an unreviewed EXTRA gated tool, is a policy violation the ` +
      `moment it diverges from EXPECTED_MUTATING_TOOLS. Found: ${mutating.join(", ") || "(none)"}`,
  );
});

test("every enumerated gated tool is human-gated via the console seam (defineTool + approval wired to consoleGatedApproval)", () => {
  for (const file of EXPECTED_MUTATING_TOOLS) {
    const src = stripComments(readFileSync(`${toolsDir}/${file}`, "utf8"));
    assert.match(src, /defineTool\(/, `${file} must be authored with defineTool`);
    assert.match(
      src,
      CONSOLE_GATED_APPROVAL_RE,
      `${file} must gate every invocation behind approval: (ctx) => consoleGatedApproval(ctx)`,
    );
  }
});

test("Eve's stock always()/once() approval gate is fully retired — no tool file references it (issue #1273 PR ②)", () => {
  const files = readdirSync(toolsDir).filter((f) => SOURCE_RE.test(f));
  const stillUsingAlways = files
    .filter((f) => ALWAYS_CALL_RE.test(stripComments(readFileSync(`${toolsDir}/${f}`, "utf8"))))
    .sort();
  assert.deepEqual(
    stillUsingAlways,
    [],
    `Eve's stock approval:always() gate must be fully retired in favor of ` +
      `consoleGatedApproval for every tool in this directory (issue #1273 ` +
      `PR ②) — gated or not, no tool file may call always()/once() any ` +
      `more. Found lingering always() in: ${stillUsingAlways.join(", ") || "(none)"}`,
  );
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
    // Same guarantee, current mechanism (issue #1273 PR ②): a subagent
    // wiring `consoleGatedApproval` would ALSO be authoring a second
    // human-gated write path, even though it no longer matches the
    // always()/once() pattern above.
    assert.doesNotMatch(
      src,
      /consoleGatedApproval/,
      `${rel} — a subagent must not wire consoleGatedApproval (that is a second write path, same as approval: always()/once())`,
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
