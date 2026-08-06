// The reviewer subagent has ZERO write capability and is isolated from the
// factory's write paths (post_pr_review, issue-filing), while authoring
// exactly its SIX read-only tools: fetch_pr_diff (the PR's metadata + diff)
// plus the four context tools that let it investigate beyond the diff —
// read_repo_file (one file/dir at a ref), search_code (capped textual usage
// search), file_history (recent commits touching a path), fetch_wiki
// (the repo's compiled wiki, list/get/search), and reviewer_suppressions
// (per-repo Judgment Ledger suppression rules). Widening from ONE tool to
// SIX is this task's own change (design:
// docs/superpowers/specs/2026-07-31-reviewer-judgment-engine-design.md §2,
// "the posture rework") — the read-only, zero-write guarantee this file
// exists to prove is otherwise untouched. Copies the structure of
// triage-read-only.test.mjs (which made the analogous one-to-five
// widening for the debugger's own evidence-verb tools).
//
// Two mechanisms make the zero-write guarantee true, and this test PROVES both:
//
//   A. Isolation. eve's boundary means a declared subagent inherits nothing from
//      the root's authored slots — it sees only the tools authored under its OWN
//      directory. So it physically cannot see or call root's gated write tools
//      (post_pr_review, create_issue, etc.). We prove no file under the subagent
//      references any write path (child_process, execFile, gh issue create,
//      octokit, linear) or an approval gate, nor a database client (postgres /
//      clickhouse — reviewer reads everything over HTTP only; Jace keeps NO
//      ClickHouse client).
//
//   B. Harness lock-down. Isolation is NOT enough on its own: eve injects a
//      DEFAULT HARNESS into every agent at runtime — bash, write_file, read_file,
//      glob, grep, web_fetch, web_search, todo, ask_question, load_skill —
//      regardless of the authored tools list. bash and write_file are genuine
//      write capabilities. So reviewer authors a tools/ directory of disable
//      sentinels (each `tools/<name>.ts` default-exports disableTool()) that
//      strips the ENTIRE default harness. Because reviewer declares NO connections,
//      the dynamic connection_search is never injected, so there is no
//      connection_search sentinel either. The four context tools sit BESIDE
//      those sentinels in the same tools/ directory — none of the sentinels are
//      removed or replaced.
//
// All SIX authored tools are read-only, proved three ways: none sets an
// `approval` field (approval gates are reserved for root's gated write tools);
// none of their transport code contains a POST/PUT/DELETE method string (every
// one of the six is GET-only); and each reaches exactly one configured
// console endpoint via the global fetch (pr-review for fetch_pr_diff,
// repo-file for read_repo_file, code-search for search_code, file-history for
// file_history, repo-wiki for fetch_wiki, reviewer-suppressions for
// reviewer_suppressions).
//
// What replaces the old "ONE read tool" injection-defense framing (design §2):
// everything any of the six tools fetches — the diff, a file's content,
// search fragments, commit messages, wiki prose, suppression rules — is the SAME untrusted
// surface, never an instruction; that rule (plus the investigation budget)
// lives in instructions.md, not here. This file proves the STRUCTURAL half of
// the posture (isolation + harness lock-down + GET-only + no write path), not
// the prompt-level content-handling rule.
//
// The complementary guarantee — that root's write surface is UNCHANGED and that
// NO subagent authors a mutating tool — is covered by no-second-write-path.test.mjs
// (its agent/tools scan is non-recursive, so a subagent cannot expand the
// enumerated tool set; its child_process scan is recursive over agent/, so a
// subagent cannot smuggle one in; and it asserts no subagent file sets
// an approval gate).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const reviewerDir = fileURLToPath(
  new URL("../legacy/reviewer", import.meta.url),
);
const SOURCE_RE = /\.(ts|mjs|js)$/;

// The six authored tools (widened from one to six by this task — design
// §2). Each legitimately uses defineTool, so all five are EXCLUDED from the
// sentinel-only assertions and from the defineTool write-path scan. Adding a
// sixth is a deliberate edit here, same posture as no-second-write-path.
// test.mjs's own EXPECTED_TOOL_FILES ceiling-and-floor.
const AUTHORED_TOOLS = [
  "fetch_pr_diff.ts",
  "read_repo_file.ts",
  "search_code.ts",
  "file_history.ts",
  "fetch_wiki.ts",
  "reviewer_suppressions.ts",
].sort();

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE_RE.test(entry.name)) out.push(full);
  }
  return out;
}

// Strip `//` and `/* */` comments before scanning, so prose that DOCUMENTS the
// read-only guarantee (e.g. "cannot see root's gated write tools", "keeps NO
// ClickHouse client") isn't read as a real reference. None of these files put
// "//" or "/*" inside a string/template literal, so this plain strip is safe
// here.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("the reviewer subagent exists with agent.ts + instructions.md", () => {
  assert.ok(existsSync(`${reviewerDir}/agent.ts`), "reviewer must have an agent.ts");
  assert.ok(
    existsSync(`${reviewerDir}/instructions.md`),
    "reviewer must have its own instructions.md",
  );
});

// The default harness eve injects into EVERY agent at runtime (eve@0.19.0
// ALL_FRAMEWORK_TOOLS). A tools/<name>.ts that default-exports disableTool()
// drops that framework tool; the resolver THROWS if <name> isn't a real
// framework tool, so a stray/misnamed sentinel can't slip through a build.
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
// The subset that can mutate the world — the "zero write capability" core.
const WRITE_CAPABLE_HARNESS_TOOLS = ["bash", "write_file"];

test("reviewer strips the ENTIRE default harness via disableTool() sentinels", () => {
  const toolsDir = `${reviewerDir}/tools`;
  assert.ok(
    existsSync(toolsDir),
    "reviewer must author a tools/ directory of disableTool() sentinels that " +
      "strip eve's default harness (isolation alone does NOT remove bash/write_file)",
  );

  const disabled = new Set();
  for (const entry of readdirSync(toolsDir)) {
    if (!entry.endsWith(".ts")) continue;
    if (AUTHORED_TOOLS.includes(entry)) continue; // the six real tools, asserted below
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

  // The core: every write-capable harness tool is disabled.
  for (const name of WRITE_CAPABLE_HARNESS_TOOLS) {
    assert.ok(
      disabled.has(name),
      `write-capable framework tool "${name}" must be disabled (tools/${name}.ts)`,
    );
  }
  // In fact reviewer strips the ENTIRE default harness — all ten framework tools.
  for (const name of FRAMEWORK_HARNESS_TOOLS) {
    assert.ok(
      disabled.has(name),
      `framework tool "${name}" must be disabled (tools/${name}.ts)`,
    );
  }
  // No connection_search sentinel: reviewer declares no connections, so eve never
  // injects connection_search — a sentinel for it would THROW at resolve time.
  assert.ok(
    !disabled.has("connection_search"),
    "reviewer declares no connections, so there must be no connection_search sentinel",
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

test("reviewer authors exactly its SIX read-only tools — fetch_pr_diff, read_repo_file, search_code, file_history, fetch_wiki, reviewer_suppressions", () => {
  // Enumerate every source file that authors a tool (defineTool). It must be
  // exactly the five read-only tools, nothing else.
  const authored = sourceFiles(reviewerDir)
    .filter((f) => /defineTool\s*\(/.test(stripComments(readFileSync(f, "utf8"))))
    .map((f) => f.replace(`${reviewerDir}/`, ""))
    .sort();
  assert.deepEqual(
    authored,
    AUTHORED_TOOLS.map((t) => `tools/${t}`).sort(),
    `reviewer must author exactly its six tools (${AUTHORED_TOOLS.join(", ")}); found: ${authored.join(", ") || "(none)"}`,
  );

  // Every one of the five is READ-ONLY: none may carry an approval gate (an
  // approval gate — always()/once() or consoleGatedApproval — is a write-path
  // signal reserved for root's gated write tools).
  for (const tool of AUTHORED_TOOLS) {
    const toolSrc = stripComments(readFileSync(`${reviewerDir}/tools/${tool}`, "utf8"));
    assert.doesNotMatch(
      toolSrc,
      /approval:\s*(always|once)\(|consoleGatedApproval/,
      `the read-only ${tool} tool must not carry an approval gate (always/once or consoleGatedApproval)`,
    );
  }
});

test("every authored tool's transport is GET-only — no POST/PUT/DELETE method string, no approval field", () => {
  // The brief's explicit widening of the read-only proof beyond "no approval
  // gate": a read-only tool's own realTransport must never be wired to a
  // mutating HTTP method, and must never carry ANY approval field (not just
  // the always()/once()/consoleGatedApproval shapes checked above — a bare
  // `approval:` key of any shape would be a write-path signal here).
  const METHOD_RE = /method:\s*["'](POST|PUT|DELETE|PATCH)["']/;
  const APPROVAL_KEY_RE = /\bapproval\s*:/;
  for (const tool of AUTHORED_TOOLS) {
    const src = stripComments(readFileSync(`${reviewerDir}/tools/${tool}`, "utf8"));
    assert.doesNotMatch(src, METHOD_RE, `tools/${tool} must not wire a POST/PUT/DELETE/PATCH transport method`);
    assert.doesNotMatch(src, APPROVAL_KEY_RE, `tools/${tool} must not wire any approval field`);
  }
});

test("no file under reviewer references a write path or a database client", () => {
  // NB: defineTool is intentionally NOT banned here — reviewer's five authored
  // tools use it read-only (asserted above). What's banned is any actual
  // mutation / second write path, and any direct DB client (Jace subagents
  // read over HTTP; there is NO ClickHouse client in Jace, and standup's
  // postgres edge is root's, not a subagent's).
  const WRITE_PATH_RE =
    /create_issue|child_process|execFile|gh issue create|octokit|linear/i;
  const DB_CLIENT_RE = /from\s+["']postgres["']|from\s+["']@clickhouse\/client|clickhouse-client|createClient\(/i;
  for (const file of sourceFiles(reviewerDir)) {
    const src = stripComments(readFileSync(file, "utf8"));
    const rel = file.replace(`${reviewerDir}/`, "reviewer/");
    assert.doesNotMatch(src, WRITE_PATH_RE, `${rel} must not reference any write path`);
    assert.doesNotMatch(src, DB_CLIENT_RE, `${rel} must not import a database client`);
  }
});

test("reviewer declares no connections directory (no MCP surface, HTTP-only reach)", () => {
  assert.ok(
    !existsSync(`${reviewerDir}/connections`),
    "reviewer must declare no connections — its only outbound reach is the five " +
      "configured console endpoints via its six authored tools (fetch_pr_diff, " +
      "read_repo_file, search_code, file_history, fetch_wiki, reviewer_suppressions)",
  );
});
