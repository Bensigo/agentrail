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
// review (REVIEW_SCHEMA); root renders it, and on the owner's explicit go,
// posts it via its own gated post_pr_review tool and offers each escalated
// finding's draft through its own gated issue-filing tool — the single
// write path per resource, unchanged.
//
//  - Its prompt lives in this directory's instructions.md.
//  - Its ONLY tool is the authored, read-only fetch_pr_diff (one GET to the
//    configured console endpoint). It declares NO connections, so eve
//    injects no connection_search either.
//  - ZERO write capability comes from TWO things, because either alone is
//    insufficient:
//      1. eve's isolation boundary — a declared subagent inherits nothing
//         from root, so it cannot see or call root's gated write tools.
//      2. A tools/ directory of disableTool() sentinels — eve injects a
//         default harness (bash, write_file, read_file, …) into EVERY agent
//         at runtime regardless of the authored tools list. The sentinels
//         strip that harness, keeping ONLY fetch_pr_diff.
//  - `outputSchema: REVIEW_SCHEMA` runs the child in task mode, so its
//    answer is forced into the structured review shape.
//
// PROMPT-INJECTION POSTURE: the diff, PR title/body, and file contents this
// subagent reads are UNTRUSTED DATA fetched from a repo the owner does not
// fully control (any contributor can open a PR). Defense is two-layered:
// (1) instructions.md mandates treating that content as data — never as
// instructions — and flagging any embedded directive as a finding instead
// of obeying it; (2) the ENFORCED backstop lives at root's write seams —
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
