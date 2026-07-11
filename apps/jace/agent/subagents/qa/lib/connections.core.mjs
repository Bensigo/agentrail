// Pure connection config for the qa subagent — URL resolvers + tool
// allowlists. Kept framework-free (mirrors researcher's connections.core.mjs)
// so the security-relevant lists are unit-testable.
//
// TWO sidecars, TWO roles (spec §4):
//  - agent-browser: the primary driver — deterministic step-wise UI testing
//    (navigate/snapshot/interact) plus debugging surfaces (console, page
//    errors, network requests).
//  - browser-use: LLM-powered extraction + fallback engine when agent-browser
//    is down or a flow needs content extraction.
//
// EXCLUDED from both allowlists, deliberately: JS evaluate (arbitrary code in
// the page context), file upload, cookie/storage manipulation, pdf/install
// utilities. QA drives the app like a user; it does not script the page.
// QA_FORBIDDEN_TOOL_PATTERNS is enforced by test — an allowlist edit that
// smuggles one of these in fails the suite.

export const DEFAULT_AGENT_BROWSER_MCP_URL = "http://localhost:8932/mcp";
export const DEFAULT_BROWSER_USE_MCP_URL = "http://localhost:8933/mcp";

export function resolveAgentBrowserUrl(env = {}) {
  const raw =
    typeof env.JACE_AGENT_BROWSER_MCP_URL === "string"
      ? env.JACE_AGENT_BROWSER_MCP_URL.trim()
      : "";
  return raw.length > 0 ? raw : DEFAULT_AGENT_BROWSER_MCP_URL;
}

export function resolveBrowserUseUrl(env = {}) {
  const raw =
    typeof env.JACE_BROWSER_USE_MCP_URL === "string"
      ? env.JACE_BROWSER_USE_MCP_URL.trim()
      : "";
  return raw.length > 0 ? raw : DEFAULT_BROWSER_USE_MCP_URL;
}

// The agent-browser MCP tools QA may discover — one curated allowlist covering
// exactly the capabilities the spec permits: navigate, snapshot/accessibility-
// read, click, fill/type, key press, wait, screenshot, console messages, page
// errors, network requests.
//
// Names VERIFIED 2026-07-12, two independent ways:
//   1. Context7 (/vercel-labs/agent-browser) documents the MCP naming scheme
//      `agent_browser_<command>` (e.g. agent_browser_open, agent_browser_
//      screenshot).
//   2. Live stdio JSON-RPC `tools/list` probe of
//      `npx agent-browser@0.31.1 mcp --tools core,network,debug` (0.31.1 is the
//      npm `latest`, published 2026-06-26) returned every name below verbatim.
//      (Note: `npx agent-browser` alone can serve a stale cached 0.27.0, which
//      predates the `mcp` command — pin the version when re-verifying.)
//
// Present in the sidecar but deliberately OMITTED here: agent_browser_eval
// (page-context code execution), agent_browser_upload, agent_browser_pdf,
// agent_browser_download, and agent_browser_wait_for_function (runs a page-
// context predicate). QA_FORBIDDEN_TOOL_PATTERNS catches evaluate/upload/
// cookie/storage/install/pdf by name as a backstop.
export const AGENT_BROWSER_QA_TOOLS = [
  "agent_browser_open",
  "agent_browser_snapshot",
  "agent_browser_read",
  "agent_browser_click",
  "agent_browser_fill",
  "agent_browser_type",
  "agent_browser_press",
  "agent_browser_wait_ms",
  "agent_browser_wait_for_selector",
  "agent_browser_wait_for_text",
  "agent_browser_wait_for_load",
  "agent_browser_screenshot",
  "agent_browser_console",
  "agent_browser_errors",
  "agent_browser_network_requests",
  "agent_browser_network_request",
];

// Verified against browser-use's MCP server docs 2026-07-12.
// extract_content calls an LLM on the SIDECAR (its own key); if that key is
// absent the single tool fails and QA falls back to browser_get_state.
export const BROWSER_USE_QA_TOOLS = [
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_get_state",
  "browser_extract_content",
  "browser_screenshot",
  "browser_scroll",
  "browser_go_back",
  "browser_list_tabs",
  "browser_switch_tab",
  "browser_close_tab",
];

export const QA_FORBIDDEN_TOOL_PATTERNS = [
  /eval/i,
  /upload/i,
  /cookie/i,
  /storage/i,
  /install/i,
  /pdf/i,
];
