import { disableTool } from "eve/tools";

// AC3 — zero write capability. `write_file` is a default-harness tool present on
// every agent. The researcher only reads external docs/web and returns a brief;
// it must never write to disk. Disabled.
export default disableTool();
