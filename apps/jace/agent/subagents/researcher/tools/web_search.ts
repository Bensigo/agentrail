import { disableTool } from "eve/tools";

// Single, allow-listed web channel — same rationale as web_fetch. The
// researcher's external reach is exactly two declared connections (Context7 for
// docs, Playwright for live pages); the generic provider `web_search` would be a
// third, un-allow-listed channel. Disabled.
export default disableTool();
