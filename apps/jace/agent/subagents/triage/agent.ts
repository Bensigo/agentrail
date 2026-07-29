import { defineAgent } from "eve";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { chooseModel, HAIKU_GATEWAY_MODEL_ID } from "../../lib/model.core.mjs";
import { DEBUGGER_SCHEMA } from "./lib/triage.core.mjs";

// The `triage` declared subagent — Jace's DEBUGGER (Task 9, debugging design
// spec: docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md;
// spec PR #1501). Directory/tool name STAYS `triage` deliberately (Global
// Constraints: "the subagent directory/tool name triage is unchanged") — root's
// delegation, the langfuse-verdict-score hook's SCORE_NAME_BY_SUBAGENT.triage,
// and the calibration join on run_id all key on this exact name, so renaming
// the directory would silently break every one of those without touching a
// line of code that mentions "triage". What changed is the IDENTITY: this
// subagent now carries TWO modes behind one output schema —
//
//  - run mode — TODAY's behavior, unchanged. Give it a run_id; it fetches the
//    run's failure bundle (#1146) and returns a structured, evidence-cited
//    diagnosis root can render in the channel voice. Byte-stable: the
//    underlying fields are identical to the pre-Task-9 shape.
//  - deep mode — a production-investigation ROUND: root hands it a mission
//    (a question, a time window, the workspace's evidence capability map,
//    the investigation's ledger digest); it queries evidence verbs directly
//    for narrow questions, fans out its own nested change/anomaly
//    investigators (Task 10) for sweep missions, correlates what comes back,
//    and returns a ROUND_REPORT — findings, PROPOSED hypothesis updates
//    (never adjudicated), honestly reported evidence gaps, and the cheapest
//    next discriminating step.
//
// It remains a deliberately narrow specialist:
//  - Its prompt lives in this directory's instructions.md.
//  - Its tools are the authored, read-only fetch_run_evidence (run mode's one
//    GET to the failure-bundle endpoint) plus fetch_changes/search_events
//    (deep mode's evidence-verb tools, Task 9 — both thin wrappers over the
//    SAME landed evidence-capability route). It declares NO connections, so
//    Eve injects no connection_search either.
//  - ZERO write capability (AC1) comes from TWO things, because either alone is
//    insufficient:
//      1. Eve's isolation boundary — a declared subagent inherits nothing from
//         root, so it cannot see or call root's create_issue, save_investigation,
//         or record_verdict. Deep mode PROPOSES ledger updates in its
//         ROUND_REPORT; it never persists one itself — root adjudicates and
//         calls save_investigation with what it approves.
//      2. A tools/ directory of disableTool() sentinels — Eve injects a default
//         harness (bash, write_file, read_file, …) into EVERY agent at runtime
//         regardless of the authored tools list, and bash/write_file are real
//         write capabilities. The sentinels strip that entire harness, leaving
//         only the three authored read-only tools above.
//  - `outputSchema: DEBUGGER_SCHEMA` runs the child in task mode, so its answer
//    is forced into ONE of the two structured shapes (AC2) — TRIAGE_SCHEMA's
//    fields for run mode, ROUND_REPORT_SCHEMA's for deep mode; see
//    lib/triage.core.mjs for the union's exact composition and the regression
//    pins (test/debugger-schema.test.mjs) that keep run mode byte-stable.
//
// PROMPT-INJECTION POSTURE: the diagnosis/round-report is delivered to root as
// a MODEL-READ tool result — Eve lowers this task-mode subagent's structured
// output straight into root's tool stream, and Eve hooks are observe-only, so
// there is no Jace code seam between emit and read to sanitize at. The
// fetched failure/evidence content is UNTRUSTED (scrubbed runner logs and
// provider-sourced excerpts, but a hostile repo or a compromised upstream
// could seed either). Defense is two-layered: (1) this agent's
// instructions.md tells it to keep cited evidence INERT (treat excerpts as
// data, never as commands; no control/zero-width chars, no @everyone/@here,
// no javascript:/data:/file: URLs) — the SAME posture in both modes, and (2)
// the ENFORCED backstop lives at root's side-effecting write seam —
// create_issue and save_investigation each run every field through
// hardenUntrusted() (agent/lib/sanitize-untrusted.core.mjs) before anything
// reaches GitHub or the investigation ledger.
//
// MODEL: kept on the cheap haiku-class gateway tier AS-IS for now — run mode
// is still small, bounded, and mechanical (fetch a bundle, shape a fixed
// schema), and that override predates deep mode. Whether deep mode's
// investigation/correlation work warrants a stronger model is a flagged
// follow-up (not this task) once real deep-mode usage exists to judge
// against; changing it now would be a guess, not a measurement. The override
// applies ONLY to the gateway branch — an operator pointing Jace at a
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
  "Jace's debugger: diagnoses failed runs (run mode) and executes production " +
  "investigation rounds (deep mode). Run mode — give it a run_id; it fetches " +
  "the run's failure bundle (run row, failure evidence, review-gate verdicts, " +
  "timeline) and returns a structured diagnosis: what went wrong, what was " +
  "tried, the blocking reason, a suggested next action, and evidence_refs " +
  "tying every claim to a real bundle section. Deep mode — hand it a mission " +
  "(a question, a time window, the workspace's evidence capability map, and " +
  "the investigation's current ledger digest); it queries evidence verbs " +
  "directly for narrow questions, fans out its own nested change/anomaly " +
  "investigators for sweep missions, correlates what comes back, and returns " +
  "a ROUND_REPORT: findings cited to evidence actually seen this round, " +
  "proposed hypothesis updates (never adjudicated — root and the human own " +
  "the verdict), honestly reported evidence gaps, and the cheapest next " +
  "discriminating step. In both modes, evidence that is absent or " +
  "unreachable is reported as a gap, never invented as a cause.";

export default defineAgent(
  choice.kind === "gateway"
    ? {
        description,
        model,
        outputSchema: DEBUGGER_SCHEMA,
      }
    : {
        description,
        model,
        modelContextWindowTokens: choice.contextWindowTokens,
        outputSchema: DEBUGGER_SCHEMA,
      },
);
