import { disableTool } from "eve/tools";

// Zero write capability. `write_file` is injected into every agent's
// default harness and is a genuine write to the host filesystem. The
// reviewer only reads a PR diff and returns a structured review; it must
// never write anywhere, so this sentinel strips it from the runtime
// registry.
export default disableTool();
