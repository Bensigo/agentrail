import { disableTool } from "eve/tools";

// AC3 — zero write capability. Eve injects `bash` into EVERY agent's default
// harness (it is NOT in the authored tools list), and it can write files, run
// arbitrary code, and reach the network. The researcher is a read-only research
// specialist, so we disable it. A `tools/<name>.ts` that default-exports
// disableTool() drops that framework tool from this agent's runtime registry.
export default disableTool();
