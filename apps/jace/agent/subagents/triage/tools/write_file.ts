import { disableTool } from "eve/tools";

// AC1 — zero write capability. `write_file` is injected into every agent's
// default harness and is a genuine write to the host filesystem. Triage only
// reads a failure bundle and returns a structured diagnosis; it must not be able
// to write anything, so this sentinel strips it from the runtime registry.
export default disableTool();
