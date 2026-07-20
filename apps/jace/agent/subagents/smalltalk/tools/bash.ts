import { disableTool } from "eve/tools";

// Zero-capability by design (#1339). `bash` is injected into every agent's
// default harness and can write files, run arbitrary code, and reach the
// network. Smalltalk replies to small talk in words only, so this is
// stripped — the same reasoning as triage's own bash sentinel, just for an
// even narrower job.
export default disableTool();
