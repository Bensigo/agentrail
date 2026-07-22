import { disableTool } from "eve/tools";

// Least privilege. `load_skill` pulls additional instruction files into the
// context, widening the agent's behaviour beyond its single review job and
// adding another surface for untrusted diff content to exploit. The
// reviewer's whole contract lives in its instructions.md, so this is
// stripped.
export default disableTool();
