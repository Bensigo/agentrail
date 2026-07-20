import { disableTool } from "eve/tools";

// Zero-capability by design (#1339). Smalltalk has no need to see the
// filesystem at all — it replies to small talk in words only.
export default disableTool();
