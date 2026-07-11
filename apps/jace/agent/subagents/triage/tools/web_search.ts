import { disableTool } from "eve/tools";

// AC1 — least privilege. `web_search` reaches the open web. Triage diagnoses a
// run purely from its fetched evidence and must not pull in unrelated external
// content (an injection/derailment surface), so it is stripped.
export default disableTool();
