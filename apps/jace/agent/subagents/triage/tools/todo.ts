import { disableTool } from "eve/tools";

// AC1 — one-shot task mode. Triage is a single fetch→diagnose→return pass with no
// multi-step plan to track, so the `todo` scratchpad is noise. Stripped to keep
// the agent's surface minimal.
export default disableTool();
