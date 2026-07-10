// Pure, dependency-free wiring for the researcher subagent's MCP connections.
//
// These constants and resolvers are imported by the sibling `.ts` connection
// files (which cannot be unit-tested without booting Eve) AND by node --test
// specs. Keeping the logic here means the URL / header / allowlist / degraded
// decisions are covered without a build step, a model, or a live network — the
// same core-pure split used by agent/lib/model.core.mjs.

/** Context7 hosted MCP — current, version-accurate library documentation. */
export const CONTEXT7_MCP_URL = "https://mcp.context7.com/mcp";

/** Context7's two read-only tools: resolve a library id, then fetch its docs. */
export const CONTEXT7_TOOLS = ["resolve-library-id", "query-docs"];

/**
 * Default Playwright MCP endpoint for local dev
 * (`npx @playwright/mcp --headless --port 8931`). Production overrides it with
 * the sidecar service URL via JACE_PLAYWRIGHT_MCP_URL.
 */
export const DEFAULT_PLAYWRIGHT_MCP_URL = "http://localhost:8931/mcp";

/**
 * The ONLY Playwright tools the researcher may discover — a curated, read-only
 * browsing surface: navigation plus observation. Every tool that clicks, types,
 * fills, uploads, evaluates/executes code, presses keys, sets cookies/storage,
 * or otherwise mutates page/browser state is deliberately excluded. The safety
 * property this list enforces (asserted in tests): no write / interaction /
 * code-execution tool ever appears here.
 */
export const PLAYWRIGHT_READONLY_TOOLS = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_wait_for",
  "browser_console_messages",
  "browser_network_requests",
];

/**
 * Playwright browser tools that are FORBIDDEN because they mutate page/browser
 * state or execute arbitrary code. Not passed to Eve (the allowlist above is
 * the enforced surface) — this list exists so a test can prove none of them
 * leaked into PLAYWRIGHT_READONLY_TOOLS if the allowlist is ever edited.
 */
export const PLAYWRIGHT_FORBIDDEN_TOOLS = [
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_select_option",
  "browser_hover",
  "browser_drag",
  "browser_file_upload",
  "browser_evaluate",
  "browser_run_code_unsafe",
  "browser_handle_dialog",
  "browser_tabs",
  "browser_resize",
  "browser_close",
];

/**
 * Resolve the Playwright MCP URL from the environment, falling back to the
 * local-dev default. A blank/whitespace value is treated as unset.
 */
export function resolvePlaywrightUrl(env = {}) {
  const raw =
    typeof env.JACE_PLAYWRIGHT_MCP_URL === "string"
      ? env.JACE_PLAYWRIGHT_MCP_URL.trim()
      : "";
  return raw || DEFAULT_PLAYWRIGHT_MCP_URL;
}

/**
 * Build the Context7 request headers. The hosted server works keyless (public
 * tier); a CONTEXT7_API_KEY only raises rate limits. So the header is added
 * ONLY when the env var is set — an empty object (no auth) otherwise. A blank/
 * whitespace value is treated as unset.
 */
export function resolveContext7Headers(env = {}) {
  const key =
    typeof env.CONTEXT7_API_KEY === "string" ? env.CONTEXT7_API_KEY.trim() : "";
  return key ? { CONTEXT7_API_KEY: key } : {};
}

/**
 * The pure kernel of AC5's graceful degradation. Map Playwright-sidecar
 * reachability onto the research sources actually in play: when the browser
 * sidecar is unreachable the researcher still runs — it just narrows to
 * Context7 docs and flags the brief degraded. The returned shape mirrors the
 * brief's `sourcesUsed` / `degraded` fields exactly, so instructions can tell
 * the model to populate the brief from this same policy.
 */
export function resolveResearchSources({ webReachable } = {}) {
  return {
    sourcesUsed: webReachable ? ["context7", "web"] : ["context7"],
    degraded: !webReachable,
  };
}
