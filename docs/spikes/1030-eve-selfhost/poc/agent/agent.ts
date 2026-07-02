import { defineAgent } from "eve";

/**
 * Spike #1030 — the coordinator agent, reduced to what the spike must prove.
 *
 * In the real PRD3 coordinator this is the ideation/triage agent whose ONLY
 * write path into the AgentRail factory is a single gated create-issue tool
 * (see CONTEXT.md: "the coordinator's only write path into the factory will be
 * a single gated create-issue tool"). The gate is `needsApproval` — this POC
 * exists to prove that mechanic end to end.
 *
 * Model id uses Eve's provider-prefixed form. Swap to whatever the workspace
 * routes; kept portable so a thin-shell fallback can reuse the same instructions.
 */
export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
});
