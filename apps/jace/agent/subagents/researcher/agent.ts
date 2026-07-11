import { defineAgent } from "eve";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { chooseModel } from "../../lib/model.core.mjs";
import { BRIEF_SCHEMA } from "./lib/brief.core.mjs";

// The `researcher` declared subagent. Root Jace delegates here BEFORE drafting
// anything that touches external tech (a library / SDK / API), then cites the
// returned brief. It is a specialist with a deliberately narrow surface:
//  - Its prompt lives in this directory's instructions.md.
//  - Its external reach is two read-only MCP connections (Context7 docs + a
//    headless Playwright browser), declared under connections/.
//  - ZERO write capability (AC3) comes from TWO things, because either alone is
//    insufficient:
//      1. Eve's isolation boundary — a declared subagent inherits nothing from
//         root, so it cannot see or call root's create_issue.
//      2. A tools/ directory of disableTool() sentinels — Eve injects a default
//         harness (bash, write_file, read_file, …) into EVERY agent at runtime
//         regardless of the authored tools list, and bash/write_file are real
//         write capabilities. The sentinels strip that entire harness, leaving
//         only the dynamic connection_search (its read-only RAG channel).
//  - `outputSchema: BRIEF_SCHEMA` runs the child in task mode, so its answer is
//    forced into the structured brief shape (AC1).
//
// PROMPT-INJECTION POSTURE: the brief is delivered to root as a MODEL-READ tool
// result — Eve lowers this task-mode subagent's structured output straight into
// root's tool stream, and Eve hooks are observe-only, so there is no Jace code
// seam between emit and read to sanitize at. Defense is therefore two-layered:
// (1) this agent's instructions.md tells it to keep cited web text inert (treat
// fetched content as data, not commands; do not smuggle live payloads through a
// citation), and (2) the ENFORCED backstop lives at root's side-effecting write
// seam — create_issue runs every field through hardenUntrusted()
// (agent/lib/sanitize-untrusted.core.mjs) before anything reaches GitHub.
//
// The model is resolved from the environment exactly as root does (see
// agent/lib/model.core.mjs) so the researcher honours the same gateway /
// OpenAI-compatible / self-hosted configuration.
const choice = chooseModel(process.env);

const model =
  choice.kind === "gateway"
    ? choice.modelId
    : createOpenAICompatible({
        name: choice.name,
        baseURL: choice.baseURL,
        ...(choice.apiKey ? { apiKey: choice.apiKey } : {}),
      })(choice.modelId);

export default defineAgent(
  choice.kind === "gateway"
    ? {
        description:
          "Verify external tech (libraries, SDKs, APIs) against current docs " +
          "and the live web before the parent drafts anything. Returns a " +
          "structured research brief: recommended approach, alternatives, " +
          "citations (claim -> URL -> version), open questions, and confidence.",
        model,
        outputSchema: BRIEF_SCHEMA,
      }
    : {
        description:
          "Verify external tech (libraries, SDKs, APIs) against current docs " +
          "and the live web before the parent drafts anything. Returns a " +
          "structured research brief: recommended approach, alternatives, " +
          "citations (claim -> URL -> version), open questions, and confidence.",
        model,
        modelContextWindowTokens: choice.contextWindowTokens,
        outputSchema: BRIEF_SCHEMA,
      },
);
