import { disableTool } from "eve/tools";

// Single, allow-listed web channel. #1124 routes all live-web reads through the
// `playwright` MCP connection, which is restricted to a navigate/observe
// allow-list. The default-harness `web_fetch` is an UN-allow-listed second web
// channel that would bypass that restriction, so we disable it: every web read
// funnels through the declared, allow-listed, untrusted-by-default connection.
export default disableTool();
