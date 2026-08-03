// AC3 — the enumerated-tools test.
//
// The name of this file overstates the invariant it actually enforces: it is
// NOT "no second write path" full stop — ungated write paths exist here by
// design (`send_connect_link`, issue #1263 PR ②; `post_pr_review`, see
// UNGATED_ADVISORY_WRITES below), and the gated set has grown to EIGHT
// (`create_workspace`, issue #1264 PR ①; `create_repo`, issue #1265 PR ②;
// `update_issue`, issue #1345 PR ①; `create_goal`, issue #1289; and the three
// backlog-grooming writes `backlog_label` / `backlog_close` / `backlog_dedupe`,
// issue #1291). What this test actually proves is narrower and precise: every
// mutating tool is gated unless it is one of the enumerated, argued
// exceptions, and every ungated tool's blast radius is bounded server-side.
//
//   - Every GATED/mutating tool — authored with `defineTool` and
//     `approval: (ctx) => consoleGatedApproval(ctx)` (issue #1273 PR ②;
//     before that, `approval: always()` — Eve's stock HITL gate is now
//     fully retired for these six), so every invocation pauses for a
//     human before it runs — must be in the enumerated
//     `EXPECTED_MUTATING_TOOLS` set below. Today that set is `create_issue`
//     (Jace's only path into the factory: GitHub issues, workspaces,
//     builds), `create_workspace` (creates a real workspace, own product
//     state), `create_repo` (creates a real GitHub repository under the
//     user's own account and connects it to the workspace), `update_issue`
//     (edits an EXISTING issue's title/body — the #1345 revise loop's write
//     path), and `create_goal` (issue #1289: creates a real workspace goal
//     the Jace goal loop then pursues — the goal's OWN issue filing still
//     goes through `create_issue`, never a second path into the factory) —
//     all the same gate class, see each tool's own file doc-comment. The set
//     is enumerated, not open-ended: adding another gated tool requires
//     deliberately editing EXPECTED_MUTATING_TOOLS below — that edit IS the
//     human review this test exists to force, same as EXPECTED_TOOL_FILES
//     below it.
//   - `post_pr_review` is the ONE mutating tool deliberately left UNGATED,
//     and it is enumerated just as tightly (UNGATED_ADVISORY_WRITES below).
//     It was gated until 2026-07-28, when prod showed the gate did not merely
//     add friction — it silently swallowed the action. The console delivers
//     approval prompts on Telegram ONLY, so on a `discord` session the
//     approval row was recorded, never shown to the owner, and the tool
//     polled until its 30-minute TTL expired: two such rows sat `pending` and
//     the review never landed. Handing Jace a PR to review is itself the
//     instruction to comment on it, so the gate was removed rather than
//     patched. Three properties carry the safety line the gate used to share,
//     and each is ASSERTED below rather than merely claimed here:
//       (a) advisory-only — the console hardcodes the GitHub review `event`
//           to "COMMENT" server-side, so this can never approve or request
//           changes on a PR;
//       (b) server-scoped target — the console resolves the workspace from
//           `eveSessionId` and rejects a `repo` that workspace hasn't
//           connected, so a model-chosen repo cannot escape the tenant;
//       (c) severity-filtered in code — only `blocker`/`major` are posted and
//           an unlabelled comment is dropped, so "don't post noise" does not
//           depend on the model choosing to obey a prompt.
//     A SECOND ungated mutating tool is a policy violation until it is added
//     there with its own argument.
//   - `save_brief` (design: docs/superpowers/specs/2026-07-28-jace-briefs-
//     durable-idea-understanding-design.md; spec PR #1487) is the SECOND
//     enumerated ungated mutating tool. Its argument is different from
//     post_pr_review's: rather than "the approval channel doesn't reach every
//     surface", the design spec's own reasoning is "it is internal and
//     reversible, and `create_issue` remains the only boundary crossing" —
//     it only ever writes into AgentRail's own brief store (never GitHub, a
//     workspace, or any other outside system), the write is a per-item DELTA
//     the console's own route enforces invariants against (an
//     `authority: 'human'` item is locked against every future `save_brief`
//     call; an `unknown`-kind item can never land `resolved`), and per-turn
//     autosave is the entire point — gating it would defeat the reason this
//     tool exists (surviving a context compaction by externalizing
//     understanding as it happens, not in an end-of-conversation batch).
//   - `save_investigation` (debugging design spec:
//     docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md; spec
//     PR #1501) is the THIRD enumerated ungated mutating tool — the SAME
//     argument as `save_brief`, applied to production incidents instead of
//     product ideas: it only ever writes into AgentRail's own investigation
//     store, every write is a per-item DELTA the console route enforces
//     invariants against (human-authority lock, evidence immutability —
//     `kind: 'evidence'` items are written ONLY by the evidence capability
//     layer, never this tool — hypothesis evidence-gating, and kind-fixed-
//     at-creation), and it REJECTS `verdict`/`status` outright (400) so this
//     tool can never become a side door around the verdict gate below.
//   - `record_verdict` (same spec) is the FOURTH enumerated ungated mutating
//     tool, and its argument is DIFFERENT from the other three: it is
//     ungated not because the write is low-stakes, but because it is
//     FAIL-CLOSED and SERVER-VALIDATED — `recordVerdict`
//     (packages/db-postgres/src/queries/investigations.ts) independently
//     re-checks eligibility (root_caused) or a non-empty missingEvidence
//     (undetermined) inside its own transaction, so the model cannot force a
//     verdict through by merely asserting one is warranted; a human approval
//     gate would only ever rubber-stamp what the server already decided. On
//     success it also fire-and-forgets a Langfuse score — the same class of
//     side effect `agent/hooks/langfuse-verdict-score.ts` already performs
//     automatically, ungated, for every triage/qa completion.
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
//      `create_issue` + `create_workspace` + `create_repo` + `update_issue` +
//      `create_goal` (gated/mutating), `send_connect_link` + `post_pr_review`
//      + `save_brief` + `save_investigation` + `record_verdict` (ungated but
//      self-scoped/argued), and `standup` / `codebase_query` /
//      `fetch_workspace_memory` / `fetch_backlog` / `fetch_repo_wiki` /
//      `fetch_work_status` / `fetch_briefs` / `fetch_investigations` /
//      `fetch_evidence_capabilities` / `fetch_issue` (read-only).
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
//      `send_connect_link`), never `child_process`. `standup` also reaches
//      the console over HTTP now (via `fetch_work_status.core.mjs`, retiring
//      its old direct-Postgres edge) and must NOT appear here either.
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
  "backlog_close.ts", // gated (issue #1291): closes ONE existing open issue during backlog grooming (optional reason comment) — same gate class as create_issue; no child_process (HTTP to the console, like post_pr_review)
  "backlog_dedupe.ts", // gated (issue #1291): closes ONE existing open issue as a duplicate of a canonical issue — same gate class as create_issue; no child_process (HTTP to the console, like post_pr_review)
  "backlog_label.ts", // gated (issue #1291): adds/removes labels on ONE existing open issue during backlog grooming — same gate class as create_issue; no child_process (HTTP to the console, like post_pr_review)
  "codebase_query.ts",
  "create_goal.ts", // gated (issue #1289): creates a real workspace goal the Jace goal loop then pursues — same gate class as create_issue; no child_process (HTTP to the console, like create_workspace/create_repo)
  "create_issue.ts",
  "create_repo.ts", // gated: creates a real GitHub repo under the user's own account + connects it to the workspace — same gate class as create_issue; no child_process (HTTP to the console, like send_connect_link)
  "create_workspace.ts", // gated: creates a real workspace (owned or owner-elect) — same gate class as create_issue; no child_process (HTTP to the console, like send_connect_link)
  "fetch_backlog.ts", // read-only (issue #1291): reads the workspace's OPEN backlog over the console token API for grooming; no approval, no child_process
  "fetch_briefs.ts", // read-only (briefs spec PR #1487): reads BRIEFS — the durable understanding of one product idea (list/get/search) — over the console token API; no approval, no child_process
  "fetch_evidence_capabilities.ts", // read-only (debugging spec PR #1501, T11 review fix round 1): reads the workspace's EVIDENCE CAPABILITY MAP (which verbs have a connected/credentialed provider) — no params, no anchored investigation needed — over the console token API; no approval, no child_process
  "fetch_investigations.ts", // read-only (debugging spec PR #1501): reads INVESTIGATIONS — the durable record of one production incident (anchor/list/get/search), relays verdict eligibility verbatim — over the console token API; no approval, no child_process
  "fetch_issue.ts", // read-only (QA AC-awareness spec, docs/superpowers/specs/2026-07-29-qa-ac-awareness-design.md): reads ONE GitHub issue (number/title/body/state) over the console token API, to resolve its acceptance criteria before dispatching qa; no approval, no child_process
  "fetch_repo_wiki.ts", // read-only (wiki spec PR 5): reads the connected repo's COMPILED wiki (list/get/search) over the console token API; no approval, no child_process
  "fetch_work_status.ts", // read-only: reads in-flight/recent runs + issue-queue entries (optionally scoped to a ref) over the console token API for "how's that going"; no approval, no child_process
  "fetch_workspace_memory.ts", // read-only: reads workspace memory over the console bearer API; no approval, no child_process
  "post_pr_review.ts", // UNGATED by design (see this file's header + UNGATED_ADVISORY_WRITES): posts an ADVISORY, COMMENT-only PR review, severity-filtered to blocker/major in code; no child_process (HTTP to the console, like create_repo/create_goal)
  "record_verdict.ts", // UNGATED by design (see this file's header + UNGATED_ADVISORY_WRITES): FAIL-CLOSED, server-validated verdict write (computeVerdictEligibility re-checked server-side, not trusted from the model) + a fire-and-forget Langfuse score on success only; no child_process (HTTP to the console, like save_brief)
  "request_preview_boot.ts", // operational + ungated by design (B2b reviewer wiring): requests/polls a console preview boot for the calling root session; no repo/workspace mutation, no approval, no child_process
  "save_brief.ts", // UNGATED by design (see this file's header + UNGATED_ADVISORY_WRITES): autosaves a per-item DELTA into AgentRail's own brief store only (never GitHub/a workspace/any outside system); human-authority + unknown-can't-resolve invariants enforced at the console route, not here; no child_process (HTTP to the console, like post_pr_review)
  "save_investigation.ts", // UNGATED by design (see this file's header + UNGATED_ADVISORY_WRITES): autosaves a per-item DELTA into AgentRail's own investigation store only (never GitHub/a workspace/any outside system); human-authority + evidence-immutability + hypothesis-evidence-gating + kind-fixed-at-creation invariants enforced at the console route, not here; REJECTS verdict/status outright; no child_process (HTTP to the console, like save_brief)
  "send_connect_link.ts", // ungated write, but narrow + self-scoped (mints a link for the CALLING conversation's own chat identity only, never the factory); no child_process
  "standup.ts", // read-only: reads recent runs + queue entries via fetch_work_status.core.mjs over the console token API (retired direct-Postgres edge); no approval, no child_process
  "update_issue.ts", // gated (issue #1345): edits an EXISTING issue's title/body in the house format — same gate class as create_issue, via the SAME consoleGatedApproval seam; shells out to `agentrail issue update` (child_process, like create_issue)
].sort();
// The enumerated set of gated/mutating tools. Every tool named here must
// wire `approval: (ctx) => consoleGatedApproval(ctx)`; the test below also
// asserts no OTHER tool does — so this list is a ceiling as well as a floor.
// Adding a sixth entry is a deliberate human edit, not something a maker
// should do silently.
const EXPECTED_MUTATING_TOOLS = [
  "create_issue.ts",
  "create_workspace.ts",
  "create_repo.ts",
  "update_issue.ts",
  "create_goal.ts",
  // NOTE: post_pr_review.ts is deliberately ABSENT — it is the sanctioned
  // ungated advisory write. See UNGATED_ADVISORY_WRITES below.
  // issue #1291 — the backlog-grooming write path. Each mutates ONE EXISTING
  // open issue (label / close / dedupe) and applies over HTTP to the console
  // (getInstallationToken server-side), never child_process — same gate class
  // and shape as post_pr_review. Grooming NEVER files new issues (that stays
  // create_issue's job) and NEVER writes without an approved decision.
  "backlog_label.ts",
  "backlog_close.ts",
  "backlog_dedupe.ts",
].sort();
// The enumerated set of mutating tools that are deliberately UNGATED. This is
// a ceiling as much as a floor: the test below asserts each one wires NO
// approval, and the gated-set test above asserts nothing else slips out of the
// gate. See this file's header for the full argument behind the one entry.
const UNGATED_ADVISORY_WRITES = ["post_pr_review.ts", "save_brief.ts", "save_investigation.ts", "record_verdict.ts"];

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

test("agent/tools exposes exactly the enumerated GATED/mutating tools: create_issue, create_workspace, create_repo, update_issue, create_goal", () => {
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

test("the enumerated ungated advisory writes wire NO approval gate at all", () => {
  // The complement of the enumerated-gated-set test above: these tools must
  // stay ungated on purpose, so a well-meaning re-gate (which would silently
  // swallow the action again on every non-Telegram channel) fails here loudly.
  for (const file of UNGATED_ADVISORY_WRITES) {
    const src = stripComments(readFileSync(`${toolsDir}/${file}`, "utf8"));
    assert.doesNotMatch(
      src,
      CONSOLE_GATED_APPROVAL_RE,
      `${file} is deliberately ungated (see this file's header) — re-gating it ` +
        `re-introduces the prod failure where the approval prompt is never ` +
        `delivered on any channel but Telegram and the review silently never posts`,
    );
    assert.doesNotMatch(
      src,
      /\bapproval\s*:/,
      `${file} must not wire any approval field`,
    );
  }
});

test("post_pr_review's severity filter is enforced in code, not in a prompt", () => {
  // Property (c) from this file's header: the control that REPLACED the human
  // gate. It lives in the pure core so it cannot be talked out of.
  const core = readFileSync(
    fileURLToPath(new URL("../agent/lib/post_pr_review.core.mjs", import.meta.url)),
    "utf8",
  );
  assert.match(
    stripComments(core),
    /POSTABLE_SEVERITIES\s*=\s*\[\s*"blocker"\s*,\s*"major"\s*\]/,
    "post_pr_review.core.mjs must post exactly blocker + major — minor/nit are dropped",
  );
  assert.match(
    stripComments(core),
    /filterPostableComments\(/,
    "runPostPrReview must route comments through filterPostableComments before posting",
  );
});

test("post_pr_review stays advisory + server-scoped: the console hardcodes COMMENT and validates repo ownership", () => {
  // Properties (a) and (b) from this file's header. These live in the console
  // route, not in Jace, precisely so an ungated Jace-side tool cannot weaken
  // them — this asserts they are still there.
  const routePath = fileURLToPath(
    new URL(
      "../../console/app/api/v1/runner/pr-review/route.ts",
      import.meta.url,
    ),
  );
  if (!existsSync(routePath)) return; // console not present in this checkout
  const route = stripComments(readFileSync(routePath, "utf8"));
  assert.match(
    route,
    /event:\s*"COMMENT"/,
    "the console must hardcode the GitHub review event to COMMENT — an ungated tool must never be able to approve or request changes",
  );
  assert.match(
    route,
    /getRepositoryByName\(/,
    "the console must verify the repo is connected to the session's own workspace before posting",
  );
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
      `context CLI). standup must NOT appear here: it reaches the console ` +
      `over HTTP, never child_process. Found in: ${shellOutSites.join(", ") || "(none)"}`,
  );
});
