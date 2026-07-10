import { disableTool } from "eve/tools";

// Least privilege — same rationale as read_file/glob. No local-content search;
// the researcher's only inputs are its two read-only MCP connections. Disabled.
export default disableTool();
