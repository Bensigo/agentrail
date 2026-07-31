import { defineAgent } from "eve";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { chooseModel } from "../../lib/model.core.mjs";
import { REVIEW_SCHEMA } from "./lib/reviewer.core.mjs";

// The `reviewer` declared subagent. Root Jace delegates here when the owner
// asks for a code review of a pull request. Symmetric with qa (which
// verifies what shipped in a browser) and triage (which diagnoses why a run
// failed): reviewer judges a PR's diff before it merges.
//
// PURELY ADVISORY: it never posts anything to GitHub, never files issues
// itself, and never approves or requests changes — it returns a structured
// review (REVIEW_SCHEMA); root renders it and posts the blocker/major
// findings via its own post_pr_review tool, and offers each escalated
// finding's draft through its own GATED issue-filing tool — the single
// write path per resource, unchanged. (post_pr_review itself is ungated as
// of 2026-07-28; its severity filter and the console's COMMENT-only,
// workspace-scoped enforcement are what bound it. Issue filing stays gated.)
//
//  - Its prompt lives in this directory's instructions.md.
//  - It authors a READ-ONLY TOOLKIT of five tools, all thin wrappers over a
//    pure, dependency-free core (design:
//    docs/superpowers/specs/2026-07-31-reviewer-judgment-engine-design.md
//    §2, "the posture rework" — widened from the original ONE-tool
//    fetch_pr_diff by this arc): fetch_pr_diff (the PR's metadata + diff),
//    read_repo_file (one file/dir at a ref), search_code (capped textual
//    usage search), file_history (recent commits touching a path), and
//    fetch_wiki (the repo's compiled wiki — list/get/search). Every one of
//    the five is GET-only against exactly one configured console endpoint —
//    reviewer-read-only.test.mjs proves this structurally (no POST/PUT/
//    DELETE method string, no approval field, in any of the five). It
//    declares NO connections, so eve injects no connection_search either.
//  - ZERO write capability comes from TWO things, because either alone is
//    insufficient:
//      1. eve's isolation boundary — a declared subagent inherits nothing
//         from root, so it cannot see or call root's gated write tools.
//      2. A tools/ directory of disableTool() sentinels — eve injects a
//         default harness (bash, write_file, read_file, …) into EVERY agent
//         at runtime regardless of the authored tools list. The sentinels
//         strip that harness, keeping ONLY the five authored tools above.
//  - `outputSchema: REVIEW_SCHEMA` runs the child in task mode, so its
//    answer is forced into the structured review shape.
//
// PROMPT-INJECTION POSTURE: everything any of the five tools fetches — the
// diff, PR title/body, a file's content, search fragments, commit messages,
// wiki prose — is the SAME UNTRUSTED DATA surface, sourced from a repo the
// owner does not fully control (any contributor can open a PR). Widening
// from one read tool to five does not widen this surface in kind, only in
// volume: every fetched field is equally untrusted regardless of which tool
// returned it. Defense is two-layered, unchanged in shape from the original
// one-tool posture: (1) instructions.md mandates treating ALL of it as data
// — never as instructions — flagging any embedded directive as a finding
// instead of obeying it, and bounds the investigation with a declared
// budget (the untrusted-fetched-content rule and the budget both live
// there, not here); (2) the ENFORCED backstop lives at root's write seams —
// post_pr_review hardens every field through hardenUntrusted() before
// anything reaches GitHub, same as the factory's issue-filing path already
// does for every other model-read tool result.
//
// MODEL: reviewing code for correctness, security, and convention-fit is
// judgment-heavy — closer to qa's weight than triage's mechanical
// fetch-and-shape (which overrides down to the haiku tier). No override is
// passed here, matching qa: the gateway DEFAULT (GATEWAY_MODEL_ID) already
// is the stronger sonnet-class tier, and an operator on a self-hosted
// OpenAI-compatible endpoint keeps exactly the model they configured (see
// agent/lib/model.core.mjs).
const choice = chooseModel(process.env);

const model =
  choice.kind === "gateway"
    ? choice.modelId
    : createOpenAICompatible({
        name: choice.name,
        baseURL: choice.baseURL,
        ...(choice.apiKey ? { apiKey: choice.apiKey } : {}),
      })(choice.modelId);

const description =
  "Review a pull request's diff like a courteous senior engineer. Give it " +
  "a repo (owner/name) and a PR number; it fetches the diff, judges the " +
  "correctness, security, and convention-fit of the CHANGED code only, and " +
  "returns a structured, purely advisory review: a verdict, up to 10 " +
  "severity-ranked findings each with a ready-to-post suggested comment, " +
  "and house-format issue drafts for anything too big for a PR comment. " +
  "It never posts anything, never files issues, and never approves or " +
  "requests changes — it only reviews. Reports verdict: degraded honestly " +
  "when the diff cannot be fetched, rather than guessing at the PR's " +
  "contents.";

export default defineAgent(
  choice.kind === "gateway"
    ? {
        description,
        model,
        outputSchema: REVIEW_SCHEMA,
      }
    : {
        description,
        model,
        modelContextWindowTokens: choice.contextWindowTokens,
        outputSchema: REVIEW_SCHEMA,
      },
);
