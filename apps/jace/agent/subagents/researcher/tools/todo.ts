import { disableTool } from "eve/tools";

// Minimal surface. `todo` is a harmless per-session scratchpad, but the
// researcher is a single-shot task-mode specialist that returns one structured
// brief — it has no multi-step plan to track. Disabling it keeps the runtime
// tool surface to exactly `connection_search`, which is trivial to audit.
export default disableTool();
