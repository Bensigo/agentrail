import { disableTool } from "eve/tools";

// Least privilege. `grep` searches the host filesystem (secrets included).
// The reviewer judges the fetched diff only and never searches local
// files, so this framework tool is stripped.
export default disableTool();
