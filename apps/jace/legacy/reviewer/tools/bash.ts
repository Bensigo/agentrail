import { disableTool } from "eve/tools";

// Zero write capability. Eve injects `bash` into EVERY agent's default
// harness (it is NOT in the authored tools list), and it can write files,
// run arbitrary code, and reach the network. The reviewer is a purely
// advisory read-only judge of a diff whose only tool is the authored,
// read-only fetch_pr_diff, so bash is disabled. A `tools/<name>.ts` that
// default-exports disableTool() drops that framework tool from this agent's
// runtime registry.
export default disableTool();
