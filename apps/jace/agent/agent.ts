import { defineAgent } from "eve";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { chooseModel } from "./lib/model.core.mjs";

// Jace's persona/system prompt is loaded from `instructions.md` by Eve's
// filesystem convention (defineAgent has no inline instructions field).
//
// The model is resolved from the environment (see agent/lib/model.core.mjs):
//  - By default Jace uses the string model id `anthropic/claude-sonnet-4.6`,
//    which routes through the Vercel AI Gateway (needs VERCEL_OIDC_TOKEN or
//    AI_GATEWAY_API_KEY; a bare ANTHROPIC_API_KEY is ignored on that path).
//  - Set JACE_MODEL_BASE_URL to point Jace at any OpenAI-compatible endpoint
//    (self-hosted Ollama, vLLM, LM Studio, LiteLLM, ...). JACE_MODEL_ID selects
//    the model (default `gemma4:latest`); JACE_MODEL_API_KEY is an optional
//    bearer token; JACE_MODEL_CONTEXT_WINDOW_TOKENS is the model's context
//    window. See README / docs/HOSTING.md.
const choice = chooseModel(process.env);

const model =
  choice.kind === "gateway"
    ? choice.modelId
    : createOpenAICompatible({
        name: choice.name,
        baseURL: choice.baseURL,
        ...(choice.apiKey ? { apiKey: choice.apiKey } : {}),
      })(choice.modelId);

// For a custom OpenAI-compatible model Eve cannot look the context window up in
// the AI Gateway catalog, and it refuses to boot without one (it needs the
// window to compile the compaction trigger). Supply it verbatim via the public
// `modelContextWindowTokens` escape hatch. The gateway path resolves its own
// window from the catalog, so it is left unset there.
export default defineAgent(
  choice.kind === "gateway"
    ? { model }
    : { model, modelContextWindowTokens: choice.contextWindowTokens },
);
