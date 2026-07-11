import { disableTool } from "eve/tools";

// AC1 — least privilege. `load_skill` pulls additional instruction files into the
// context, widening the agent's behaviour beyond its single diagnostic job and
// adding another surface for untrusted evidence to exploit. Triage's whole
// contract lives in its instructions.md, so this is stripped.
export default disableTool();
