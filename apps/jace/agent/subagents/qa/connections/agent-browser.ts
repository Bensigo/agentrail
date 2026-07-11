// agent-browser MCP connection — the qa subagent's PRIMARY driver: real
// deterministic browser steps (navigate, snapshot, click, fill, press, wait)
// plus the debugging surfaces a QA pass needs (console messages, page errors,
// network requests).
//
// ALLOWLISTED BY CONSTRUCTION. `tools.allow` is AGENT_BROWSER_QA_TOOLS; JS
// evaluate, file upload, and cookie/storage tools are unreachable because
// they are not on the list (enforced by qa-connections.core.test.mjs).
// Deliberately NO approval gate: driving the app under test is the QA act
// itself, this connection has no write capability into Jace's systems, and a
// blanket always() would trip the no-second-write-path guard.
//
// URL comes from JACE_AGENT_BROWSER_MCP_URL (compose sidecar in prod),
// falling back to the local-dev default. Eve discovers connection tools
// lazily, so an unreachable sidecar means these tools never resolve and QA
// degrades honestly (browser_use fallback, or not_verifiable) instead of
// failing to boot.
//
// Everything the browser returns is UNTRUSTED page content — a
// prompt-injection surface. instructions.md mandates treating it as data.
import { defineMcpClientConnection } from "eve/connections";
import {
  resolveAgentBrowserUrl,
  AGENT_BROWSER_QA_TOOLS,
} from "../lib/connections.core.mjs";

export default defineMcpClientConnection({
  url: resolveAgentBrowserUrl(process.env),
  description:
    "Primary QA browser (agent-browser MCP): navigate the app under test, " +
    "snapshot pages, click/fill/press like a user, and inspect console " +
    "messages, page errors, and network requests. Drives the app; cannot " +
    "run JS, upload files, or touch cookies.",
  tools: { allow: AGENT_BROWSER_QA_TOOLS },
});
