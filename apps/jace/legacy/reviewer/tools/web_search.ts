import { disableTool } from "eve/tools";

// Least privilege. `web_search` reaches the open web. The reviewer judges a
// diff purely from what fetch_pr_diff returns and must not pull in
// unrelated external content (an injection/derailment surface), so it is
// stripped.
export default disableTool();
