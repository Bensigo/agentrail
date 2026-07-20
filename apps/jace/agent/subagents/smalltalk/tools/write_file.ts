import { disableTool } from "eve/tools";

// Zero write capability (#1339). `write_file` is injected into every agent's
// default harness and is a genuine write to the host filesystem. Smalltalk
// only replies in words and must not be able to write anything.
export default disableTool();
