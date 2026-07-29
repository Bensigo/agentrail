import { disableTool } from "eve/tools";

// AC1 — one-shot task mode. The debugger runs as an isolated, structured task
// (outputSchema: DEBUGGER_SCHEMA) and returns a single diagnosis (run mode) or
// round report (deep mode); it must not stall waiting for interactive input.
// `ask_question` is stripped so a thin-evidence run or round reports the gap
// honestly rather than blocking on a prompt.
export default disableTool();
