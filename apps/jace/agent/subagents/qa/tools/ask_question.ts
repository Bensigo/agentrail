import { disableTool } from "eve/tools";

// AC3 — zero write capability into Jace's systems. Eve injects a default
// harness (bash, write_file, read_file, …) into EVERY agent at runtime
// regardless of the authored tools list. A `tools/<name>.ts` that
// default-exports disableTool() drops that framework tool from this agent's
// runtime registry. QA keeps exactly one harness tool — web_fetch, for
// API-level checks — so there is deliberately NO web_fetch.ts here, and NO
// connection_search.ts either (this agent declares MCP connections, and
// stripping connection_search would blind it to them).
export default disableTool();
