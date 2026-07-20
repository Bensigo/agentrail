import { disableTool } from "eve/tools";

// One-shot reply, no multi-step plan to track (#1339). The `todo` scratchpad
// is noise here. Stripped to keep the agent's surface minimal.
export default disableTool();
