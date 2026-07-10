// Context7 hosted MCP connection for the researcher subagent.
//
// Read-only source of current, version-accurate documentation for external
// libraries, SDKs, and APIs. The researcher may discover only the two Context7
// read tools (resolve-library-id, query-docs) — nothing here can write.
//
// The hosted server works keyless (public tier); a CONTEXT7_API_KEY only raises
// rate limits, so the header is attached ONLY when that env var is set (see
// resolveContext7Headers). No approval gate: there is nothing to gate on a
// read-only docs lookup.
import { defineMcpClientConnection } from "eve/connections";
import {
  CONTEXT7_MCP_URL,
  CONTEXT7_TOOLS,
  resolveContext7Headers,
} from "../lib/connections.core.mjs";

export default defineMcpClientConnection({
  url: CONTEXT7_MCP_URL,
  description:
    "Context7: current, version-accurate documentation for external libraries, " +
    "SDKs, and APIs. Resolve a library id, then query its docs to verify any " +
    "external-tech claim before it is drafted into an issue, PRD, or brief.",
  headers: resolveContext7Headers(process.env),
  tools: { allow: CONTEXT7_TOOLS },
});
