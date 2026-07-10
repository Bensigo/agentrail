import { disableTool } from "eve/tools";

// Least privilege. The researcher verifies EXTERNAL tech via its two MCP
// connections; it has no business reading the local repo. Because it ingests
// untrusted web content (a prompt-injection surface), denying local-file reads
// also removes an exfiltration path — a page cannot steer it into reading a
// local secret and surfacing it in the brief. Disabled.
export default disableTool();
