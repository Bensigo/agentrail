import { disableTool } from "eve/tools";

// Zero-capability, one-shot reply. Smalltalk answers a single message and
// returns; it must not stall a chit-chat exchange waiting on a clarifying
// prompt, so this is stripped.
export default disableTool();
