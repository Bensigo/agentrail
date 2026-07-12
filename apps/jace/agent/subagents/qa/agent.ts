import { defineAgent } from "eve";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { chooseModel } from "../../lib/model.core.mjs";
import { QA_SCHEMA } from "./lib/qa.core.mjs";

// The `qa` declared subagent. Root Jace delegates here when a shipped change
// needs checking the way a user would meet it — in a real browser and over
// the app's public API. Symmetric with triage: triage explains why a run
// FAILED; qa reviews what a run SHIPPED.
//
// PURELY ADVISORY (spec §1): it never files issues, never changes run
// status, never writes anything anywhere. It returns a structured advisory
// (QA_SCHEMA); root renders it and routes suggests_issue findings through
// its own gated create_issue — the single write path, unchanged.
//
//  - Its prompt lives in this directory's instructions.md.
//  - It authors NO tools. Its capabilities are two allowlisted MCP browser
//    connections (connections/agent_browser.ts, connections/browser_use.ts)
//    plus the framework's web_fetch for API-level checks.
//  - ZERO write capability into Jace's systems (AC3) comes from TWO things,
//    because either alone is insufficient:
//      1. Eve's isolation boundary — a declared subagent inherits nothing
//         from root, so it cannot see or call root's create_issue.
//      2. A tools/ directory of disableTool() sentinels — Eve injects a
//         default harness (bash, write_file, read_file, …) into EVERY agent
//         at runtime regardless of the authored tools list. The sentinels
//         strip that harness, keeping ONLY web_fetch (API-level QA) and the
//         connection_search Eve injects for declared connections.
//  - `outputSchema: QA_SCHEMA` runs the child in task mode, so its answer is
//    forced into the structured advisory shape (AC1/AC2).
//
// VPS-NEVER-RUNS-CUSTOMER-CODE (spec §6): qa only browses URLs and fetches
// endpoints. It never clones, builds, boots, or executes repo code; page JS
// executes inside the browser sidecar containers, never in Jace's process.
//
// PROMPT-INJECTION POSTURE: everything the browsers and web_fetch return is
// UNTRUSTED page content, delivered to root as a model-read tool result with
// no code seam to sanitize at. Defense is two-layered: (1) instructions.md
// mandates treating page content as data and keeping quoted evidence INERT
// (no control/zero-width chars, no @everyone/@here, no
// javascript:/data:/file: URLs), and (2) the ENFORCED backstop lives at
// root's single write seam — create_issue runs every field through
// hardenUntrusted() (agent/lib/sanitize-untrusted.core.mjs) before anything
// reaches GitHub.
//
// MODEL: qa is multi-step and judgmental — plan flows, drive a browser,
// weigh severity — heavier than triage's mechanical fetch-and-shape (which
// overrides down to the haiku tier). The gateway DEFAULT is already the
// sonnet-class tier (GATEWAY_MODEL_ID), so no override is passed. Operators
// on a self-hosted OpenAI-compatible endpoint keep exactly the model they
// configured (see agent/lib/model.core.mjs).
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
  "QA a shipped change like a user would. Give it what shipped (PR URL " +
  "and/or issue context), the app base URL to test against, and optional " +
  "focus routes; it drives real browsers over the UI, fetches API " +
  "endpoints, and returns a purely advisory verdict: what was tested, " +
  "findings with repro steps and severity, and house-format issue drafts " +
  "for anything worth filing. It never files issues or writes anything " +
  "itself, and reports not_verifiable honestly when the app cannot be " +
  "reached or the change is not visible.";

export default defineAgent(
  choice.kind === "gateway"
    ? {
        description,
        model,
        outputSchema: QA_SCHEMA,
      }
    : {
        description,
        model,
        modelContextWindowTokens: choice.contextWindowTokens,
        outputSchema: QA_SCHEMA,
      },
);
