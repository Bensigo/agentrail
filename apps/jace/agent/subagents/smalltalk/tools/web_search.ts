import { disableTool } from "eve/tools";

// Zero-capability by design (#1339), narrower than triage's own precedent:
// triage left web_search enabled since it had no specific reason to touch it
// either way, but smalltalk's job (reply to small talk) has NO legitimate use
// for it at all, so it's stripped here for defense in depth.
export default disableTool();
