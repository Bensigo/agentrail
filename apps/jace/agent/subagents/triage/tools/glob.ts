import { disableTool } from "eve/tools";

// AC1 — least privilege. `glob` enumerates the host filesystem. Triage reasons
// only over the fetched failure bundle and needs no view of local files, so this
// framework tool is stripped.
export default disableTool();
