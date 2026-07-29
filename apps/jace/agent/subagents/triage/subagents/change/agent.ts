import { defineAgent } from "eve";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { chooseModel } from "../../../../lib/model.core.mjs";
import { CHANGE_SCHEMA } from "./lib/change.core.mjs";

// The `change` declared subagent — one of the debugger's two nested MISSION
// INVESTIGATORS (Task 10, debugging design spec:
// docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md; spec PR
// #1501). Lives at `agent/subagents/triage/subagents/change/` — Eve's
// nested-declared-subagent convention: a full agent root (its own
// agent.ts/instructions.md/lib/tools) that inherits NOTHING from its parent
// (triage, the debugger) or from root. The DIRECTORY NAME is the tool name
// the debugger sees when it dispatches this investigator by name (its own
// instructions.md's Deep mode section: "dispatch your nested investigators
// by name — `change` and `anomaly`").
//
// It is a deliberately narrow specialist, answering exactly ONE question
// per call — "what changed in this window that could plausibly affect the
// failing surface" — never a general-purpose agent:
//  - Its prompt lives in this directory's instructions.md.
//  - Its tools are the two authored, read-only evidence-verb tools
//    (fetch_changes, search_events — both thin wrappers over this
//    directory's OWN copy of lib/evidence_verbs.core.mjs; Eve subagents
//    share nothing, so the core is duplicated here rather than imported
//    across the triage/change boundary — see lib/evidence_verbs.core.mjs's
//    own header and test/investigator-schemas.test.mjs's sync test, which
//    keeps this copy byte-identical to triage's and to anomaly's). It
//    declares NO connections, so Eve injects no connection_search either.
//  - ZERO write capability comes from TWO things, same as every other
//    subagent in this codebase: (1) Eve's isolation boundary — a declared
//    subagent inherits nothing, so it cannot see or call triage's or root's
//    tools; and (2) a tools/ directory of disableTool() sentinels for all
//    ten of Eve's default-harness tools (bash, write_file, read_file, glob,
//    grep, web_fetch, web_search, todo, ask_question, load_skill) —
//    isolation alone does not remove that harness, the sentinels do.
//  - `outputSchema: CHANGE_SCHEMA` runs this child in task mode, so its
//    answer is forced into the pinned shape (candidates + degraded); see
//    lib/change.core.mjs for the schema itself and
//    test/investigator-schemas.test.mjs for the regression pins.
//
// MODEL: the DEFAULT gateway model — no haiku-class override. Unlike
// triage/agent.ts (which overrides to HAIKU_GATEWAY_MODEL_ID because run
// mode is small, bounded, and mechanical), this investigator's job is a
// ranked, evidence-correlated sweep across however many providers answer —
// closer to genuine reasoning than a fixed-shape fetch-and-render. Nothing
// here has been measured yet, so nothing here is pre-optimized: `chooseModel`
// is called with NO `gatewayModelId` override, same as root's own agent.ts.
// A haiku-class override is a flagged future follow-up once real deep-mode
// usage exists to judge cost/quality against — not a guess made now.
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
  "Answers ONE question: what changed in this window that could plausibly affect the failing surface — " +
  "deploys, merged PRs, config edits, migrations — ranked by plausibility against the repo's system model, " +
  "not by recency alone. Dispatched by the debugger for a full 'what changed' sweep (a single narrow " +
  "discriminating question is cheaper as the debugger's own direct fetch_changes/search_events call). Hand " +
  "it the mission's question, time window, and evidence capability map in the message — it never sees " +
  "conversation history or any other investigator's result. It queries its own fetch_changes/search_events " +
  "tools and returns ranked candidates, each with evidence_refs to an envelope it actually saw; any gap " +
  "(no_provider, a degraded provider, a question it couldn't touch) is reported honestly, never papered " +
  "over with a guess.";

export default defineAgent(
  choice.kind === "gateway"
    ? {
        description,
        model,
        outputSchema: CHANGE_SCHEMA,
      }
    : {
        description,
        model,
        modelContextWindowTokens: choice.contextWindowTokens,
        outputSchema: CHANGE_SCHEMA,
      },
);
