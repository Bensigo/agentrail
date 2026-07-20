import { defineAgent } from "eve";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { chooseModel, HAIKU_GATEWAY_MODEL_ID } from "../../lib/model.core.mjs";

// The `smalltalk` declared subagent (#1339 PR① — "chit-chat never burns a
// frontier model"). Root Jace delegates here for pure greetings, acks,
// thanks, and sign-offs — see `agent/lib/intent-classifier.core.mjs` for the
// canonical "chit-chat" boundary this subagent's own description below
// mirrors, and root's instructions.md's "Routing chit-chat" section for the
// delegation policy root's model actually enforces (Eve gives no per-turn
// model override and no code-level hook to force tool-choice — see that
// section for why the description below IS the routing mechanism, same as
// every other subagent in this repo).
//
// Deliberately narrower than even `triage` (this repo's previous minimum):
// ZERO authored tools, and every disableable default-harness tool is
// disabled, INCLUDING web_search (triage left that one enabled since it had
// no reason to touch it either way; smalltalk has no legitimate use for it
// at all, so it's stripped too — see this directory's tools/ sentinels).
// Combined with Eve's isolation boundary (a declared subagent inherits
// NOTHING from root — no create_issue, no create_workspace, no skills), a
// chit-chat turn delegated here cannot reach a gated write tool even if a
// hostile or malformed prompt tried to steer it there.
//
// MODEL: haiku-class gateway tier via the same `gatewayModelId` override
// `triage` uses, so chit-chat runs cheap in production while root stays on
// the stronger default. Only affects the gateway path — a self-hosted
// operator's `JACE_MODEL_ID` still governs every agent, root and subagents
// alike (see agent/lib/model.core.mjs).
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
  "Reply to PURE small talk only: greetings (hi/hey/good morning), " +
  "acknowledgements (ok/got it/sounds good), thanks, and sign-offs " +
  "(bye/goodnight). Give it the human's exact message; it returns a short, " +
  "warm reply in Jace's voice for the parent to relay verbatim. NEVER use " +
  "this for anything that asks a real question, mentions the codebase, " +
  "issues, runs, or workspace, or needs any capability beyond replying in " +
  "words — when in doubt, do NOT delegate here, handle it yourself instead.";

export default defineAgent(
  choice.kind === "gateway"
    ? { description, model }
    : { description, model, modelContextWindowTokens: choice.contextWindowTokens },
);
