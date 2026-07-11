import { disableTool } from "eve/tools";

// AC1 — zero write capability. Eve injects `bash` into EVERY agent's default
// harness (it is NOT in the authored tools list), and it can write files, run
// arbitrary code, and reach the network. Triage is a read-only diagnostician
// whose only tool is the authored, read-only fetch_run_evidence, so bash is
// disabled. A `tools/<name>.ts` that default-exports disableTool() drops that
// framework tool from this agent's runtime registry.
export default disableTool();
