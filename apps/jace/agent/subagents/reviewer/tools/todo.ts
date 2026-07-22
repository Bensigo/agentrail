import { disableTool } from "eve/tools";

// One-shot task mode. The reviewer is a single fetch -> judge -> return pass
// with no multi-step plan to track, so the `todo` scratchpad is noise.
// Stripped to keep the agent's surface minimal.
export default disableTool();
