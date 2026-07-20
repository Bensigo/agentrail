import { disableTool } from "eve/tools";

// Zero-capability by design (#1339), matching triage's own precedent:
// triage/tools/web_search.ts already disables this too (open-web reach is an
// injection/derailment surface). Smalltalk's job (reply to small talk) has no
// legitimate use for it either, so it's stripped here the same way.
export default disableTool();
