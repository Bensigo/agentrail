import { defineAgent } from "eve";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { chooseModel, HAIKU_GATEWAY_MODEL_ID } from "../../lib/model.core.mjs";
import { TRIAGE_SCHEMA } from "./lib/triage.core.mjs";

// The `triage` declared subagent. Root Jace delegates here whenever it needs to
// explain WHY a specific run failed or stalled — a question the runs table alone
// cannot answer (it has no error/reason column), so standup deliberately refuses
// to guess. Triage fetches the run's failure bundle (#1146) and returns a
// structured, evidence-cited diagnosis root can render in the channel voice.
//
// It is a deliberately narrow specialist:
//  - Its prompt lives in this directory's instructions.md.
//  - Its ONLY tool is the authored, read-only fetch_run_evidence (one GET to the
//    configured console endpoint). It declares NO connections, so Eve injects no
//    connection_search either.
//  - ZERO write capability (AC1) comes from TWO things, because either alone is
//    insufficient:
//      1. Eve's isolation boundary — a declared subagent inherits nothing from
//         root, so it cannot see or call root's create_issue.
//      2. A tools/ directory of disableTool() sentinels — Eve injects a default
//         harness (bash, write_file, read_file, …) into EVERY agent at runtime
//         regardless of the authored tools list, and bash/write_file are real
//         write capabilities. The sentinels strip that entire harness, leaving
//         only the one authored read-only tool.
//  - `outputSchema: TRIAGE_SCHEMA` runs the child in task mode, so its answer is
//    forced into the structured diagnosis shape (AC2).
//
// PROMPT-INJECTION POSTURE: the diagnosis is delivered to root as a MODEL-READ
// tool result — Eve lowers this task-mode subagent's structured output straight
// into root's tool stream, and Eve hooks are observe-only, so there is no Jace
// code seam between emit and read to sanitize at. The fetched failure evidence is
// UNTRUSTED (it is scrubbed runner logs, but a hostile repo could seed it).
// Defense is two-layered: (1) this agent's instructions.md tells it to keep cited
// evidence INERT (treat excerpts as data, never as commands; no control/zero-width
// chars, no @everyone/@here, no javascript:/data:/file: URLs), and (2) the
// ENFORCED backstop lives at root's side-effecting write seam — create_issue runs
// every field through hardenUntrusted() (agent/lib/sanitize-untrusted.core.mjs)
// before anything reaches GitHub.
//
// MODEL: triage is small, bounded, and mechanical (fetch a bundle, shape a fixed
// schema), so on the gateway path it runs on the cheap haiku-class tier via the
// gatewayModelId override, while root Jace stays on the stronger default. The
// override applies ONLY to the gateway branch — an operator pointing Jace at a
// self-hosted OpenAI-compatible endpoint still gets exactly the model they
// configured (see agent/lib/model.core.mjs).
const choice = chooseModel(process.env, {
  gatewayModelId: HAIKU_GATEWAY_MODEL_ID,
});

const model =
  choice.kind === "gateway"
    ? choice.modelId
    : createOpenAICompatible({
        name: choice.name,
        baseURL: choice.baseURL,
        ...(choice.apiKey ? { apiKey: choice.apiKey } : {}),
      })(choice.modelId);

const description =
  "Diagnose WHY a specific run failed or stalled. Give it a run_id; it fetches " +
  "the run's failure bundle (run row, failure evidence, review-gate verdicts, " +
  "timeline) and returns a structured diagnosis: what went wrong, what was " +
  "tried, the blocking reason, a suggested next action, and evidence_refs tying " +
  "every claim to a real bundle section. When evidence is absent or unreachable " +
  "it reports the gap honestly instead of inventing a cause.";

export default defineAgent(
  choice.kind === "gateway"
    ? {
        description,
        model,
        outputSchema: TRIAGE_SCHEMA,
      }
    : {
        description,
        model,
        modelContextWindowTokens: choice.contextWindowTokens,
        outputSchema: TRIAGE_SCHEMA,
      },
);
