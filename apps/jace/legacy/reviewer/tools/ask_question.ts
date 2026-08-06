import { disableTool } from "eve/tools";

// Least privilege + one-shot task mode. The reviewer runs as an isolated,
// structured task (outputSchema: REVIEW_SCHEMA) and returns a single review;
// it must not stall waiting for interactive input. `ask_question` is
// stripped so a thin or unreachable diff reports the gap honestly (verdict:
// "degraded") rather than blocking on a prompt.
export default disableTool();
