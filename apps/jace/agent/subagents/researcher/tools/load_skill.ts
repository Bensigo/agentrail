import { disableTool } from "eve/tools";

// The researcher runs its own fixed instructions (this subagent's
// instructions.md). It does not load Jace's drafting skills — those are root
// Jace's, and by Eve's subagent isolation the researcher cannot see them anyway.
// Disabling `load_skill` keeps its behaviour fixed and its surface minimal.
export default disableTool();
