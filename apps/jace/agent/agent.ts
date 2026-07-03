import { defineAgent } from "eve";

// Jace's persona/system prompt is loaded from `instructions.md` by Eve's
// filesystem convention (defineAgent has no inline instructions field).
//
// The string model id below routes through the Vercel AI Gateway, which needs
// VERCEL_OIDC_TOKEN or AI_GATEWAY_API_KEY in the environment; a bare
// ANTHROPIC_API_KEY is ignored on that path. See README / docs/HOSTING.md.
export default defineAgent({ model: "anthropic/claude-sonnet-4.6" });
