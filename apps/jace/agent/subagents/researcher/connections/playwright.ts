// Playwright MCP connection for the researcher subagent — a headless-chromium
// sidecar for reading live web pages (release notes, changelogs, GitHub issues)
// that Context7 may not yet index.
//
// READ-ONLY BY CONSTRUCTION. `tools.allow` lists only navigation + observation
// tools; every click/type/fill/upload/evaluate/key/cookie/tab tool the
// Playwright server exposes is unreachable because it is not on the allowlist
// (see PLAYWRIGHT_READONLY_TOOLS). There is deliberately NO approval gate:
// browsing is a read, and (per AC3) this connection has no write capability to
// gate — and a blanket `always()` here would trip the no-second-write-path
// guard, which is exactly the invariant we want to keep true.
//
// URL comes from JACE_PLAYWRIGHT_MCP_URL (the compose sidecar in prod), falling
// back to the local-dev default (`npx @playwright/mcp --headless --port 8931`).
// Eve discovers connection tools lazily at runtime, so if the sidecar is
// unreachable these tools simply never resolve and the researcher degrades to
// Context7-only (AC5) rather than failing to boot.
//
// Web content fetched here is UNTRUSTED DATA — a prompt-injection surface. The
// researcher's instructions treat page text as evidence to cite, never as
// instructions to follow.
import { defineMcpClientConnection } from "eve/connections";
import {
  resolvePlaywrightUrl,
  PLAYWRIGHT_READONLY_TOOLS,
} from "../lib/connections.core.mjs";

export default defineMcpClientConnection({
  url: resolvePlaywrightUrl(process.env),
  description:
    "Headless browser (Playwright MCP): navigate to and read live web pages — " +
    "release notes, changelogs, GitHub issues — for external-tech facts " +
    "Context7 may not index. Read-only: navigation and page observation only.",
  tools: { allow: PLAYWRIGHT_READONLY_TOOLS },
});
