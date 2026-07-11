import { disableTool } from "eve/tools";

// AC1 — one-shot task mode. Triage runs as an isolated, structured task
// (outputSchema: TRIAGE_SCHEMA) and returns a single diagnosis; it must not stall
// waiting for interactive input. `ask_question` is stripped so a thin-evidence run
// reports the gap honestly rather than blocking on a prompt.
export default disableTool();
