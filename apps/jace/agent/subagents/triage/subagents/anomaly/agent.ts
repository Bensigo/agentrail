import { defineAgent } from "eve";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { chooseModel } from "../../../../lib/model.core.mjs";
import { ANOMALY_SCHEMA } from "./lib/anomaly.core.mjs";

// The `anomaly` declared subagent — one of the debugger's two nested MISSION
// INVESTIGATORS (Task 10, debugging design spec:
// docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md; spec PR
// #1501). Lives at `agent/subagents/triage/subagents/anomaly/` — Eve's
// nested-declared-subagent convention: a full agent root (its own
// agent.ts/instructions.md/lib/tools) that inherits NOTHING from its parent
// (triage, the debugger) or from root. The DIRECTORY NAME is the tool name
// the debugger sees when it dispatches this investigator by name (its own
// instructions.md's Deep mode section: "dispatch your nested investigators
// by name — `change` and `anomaly`").
//
// It is a deliberately narrow specialist, answering exactly ONE question
// per call — "where and when does the system deviate from baseline" —
// never a general-purpose agent:
//  - Its prompt lives in this directory's instructions.md.
//  - Its tools are the two authored, read-only evidence-verb tools
//    (search_events, fetch_changes — both thin wrappers over this
//    directory's OWN copy of lib/evidence_verbs.core.mjs; Eve subagents
//    share nothing, so the core is duplicated here rather than imported
//    across the triage/anomaly boundary — see lib/evidence_verbs.core.mjs's
//    own header and test/investigator-schemas.test.mjs's sync test, which
//    keeps this copy byte-identical to triage's and to change's). It
//    declares NO connections, so Eve injects no connection_search either.
//  - ZERO write capability comes from TWO things, same as every other
//    subagent in this codebase: (1) Eve's isolation boundary — a declared
//    subagent inherits nothing, so it cannot see or call triage's or root's
//    tools; and (2) a tools/ directory of disableTool() sentinels for all
//    ten of Eve's default-harness tools (bash, write_file, read_file, glob,
//    grep, web_fetch, web_search, todo, ask_question, load_skill) —
//    isolation alone does not remove that harness, the sentinels do.
//  - `outputSchema: ANOMALY_SCHEMA` runs this child in task mode, so its
//    answer is forced into the pinned shape (deviations + signatures +
//    normal_surfaces + first_deviation + degraded); see lib/anomaly.core.mjs
//    for the schema itself and test/investigator-schemas.test.mjs for the
//    regression pins.
//
// MODEL: the DEFAULT gateway model — no haiku-class override. Unlike
// triage/agent.ts (which overrides to HAIKU_GATEWAY_MODEL_ID because run
// mode is small, bounded, and mechanical), this investigator's job is a
// baseline-deviation sweep with first-deviation ordering across however
// many providers answer — closer to genuine reasoning than a fixed-shape
// fetch-and-render. Nothing here has been measured yet, so nothing here is
// pre-optimized: `chooseModel` is called with NO `gatewayModelId` override,
// same as root's own agent.ts. A haiku-class override is a flagged future
// follow-up once real deep-mode usage exists to judge cost/quality against
// — not a guess made now.
//
// PROMPT-INJECTION POSTURE: identical to triage's own agent.ts note — the
// evidence this investigator reads (provider-sourced excerpts) is UNTRUSTED.
// Defense is two-layered: (1) instructions.md tells it to keep cited
// evidence INERT (data, never instructions — see its own Untrusted content
// section, copied from triage's), and (2) the ENFORCED backstop lives at
// root's own write seam (create_issue, save_investigation), which runs
// every field through hardenUntrusted() regardless of what any subagent,
// nested or not, ever proposed.
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
  "Answers ONE question: where and when does the system deviate from baseline — a RED/USE-shaped sweep for " +
  "error bursts, latency/saturation signatures, and new log patterns across every credentialed search_events " +
  "provider, correlated against what changed. Dispatched by the debugger for a full baseline-deviation sweep " +
  "(a single narrow discriminating question is cheaper as the debugger's own direct " +
  "fetch_changes/search_events call). Hand it the mission's question, time window, and evidence capability " +
  "map in the message — it never sees conversation history or any other investigator's result. It queries " +
  "its own search_events/fetch_changes tools and returns every deviation found (each with evidence_refs to " +
  "an envelope it actually saw), the surfaces that stayed at baseline (who is NOT affected is evidence too), " +
  "which signal moved first, and any gap it hit, reported honestly rather than papered over with a guess.";

export default defineAgent(
  choice.kind === "gateway"
    ? {
        description,
        model,
        outputSchema: ANOMALY_SCHEMA,
      }
    : {
        description,
        model,
        modelContextWindowTokens: choice.contextWindowTokens,
        outputSchema: ANOMALY_SCHEMA,
      },
);
