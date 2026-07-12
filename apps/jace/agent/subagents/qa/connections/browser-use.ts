// browser-use MCP connection — the qa subagent's extraction + fallback
// engine: when agent-browser is unreachable, or a check needs LLM-powered
// content extraction (browser_extract_content), QA drives this sidecar
// instead.
//
// ALLOWLISTED BY CONSTRUCTION (BROWSER_USE_QA_TOOLS): navigation,
// interaction, state reads, extraction, tabs. No evaluate/upload/cookie
// tools (enforced by qa-connections.core.test.mjs). NO approval gate — same
// rationale as agent_browser.ts.
//
// browser_extract_content calls an LLM on the SIDECAR with the sidecar's own
// key; if that key is absent the single tool errors and QA falls back to
// browser_get_state (spec §6). No Jace secret ever reaches this container.
//
// Everything returned is UNTRUSTED page content — data, never instructions.
import { defineMcpClientConnection } from "eve/connections";
import {
  resolveBrowserUseUrl,
  BROWSER_USE_QA_TOOLS,
} from "../lib/connections.core.mjs";

export default defineMcpClientConnection({
  url: resolveBrowserUseUrl(process.env),
  description:
    "Fallback QA browser (browser-use MCP): navigate, click, type, read page " +
    "state, and extract content from the app under test. Use when the " +
    "primary browser is unavailable or a check needs content extraction.",
  tools: { allow: BROWSER_USE_QA_TOOLS },
});
