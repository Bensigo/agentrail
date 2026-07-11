import { disableTool } from "eve/tools";

// AC1 — least privilege. `grep` searches the host filesystem (secrets included).
// Triage diagnoses from the fetched bundle only and never searches local files,
// so this framework tool is stripped.
export default disableTool();
