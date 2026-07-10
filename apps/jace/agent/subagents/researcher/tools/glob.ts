import { disableTool } from "eve/tools";

// Least privilege — same rationale as read_file. The researcher never inspects
// the local filesystem; denying local-file discovery keeps its surface to the
// two read-only MCP connections. Disabled.
export default disableTool();
