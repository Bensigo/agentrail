import { disableTool } from "eve/tools";

// Least privilege (#1339). `load_skill` would widen smalltalk's behavior
// beyond its single "reply to small talk" job. Its whole contract lives in
// instructions.md, so this is stripped.
export default disableTool();
