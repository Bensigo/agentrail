import { disableTool } from "eve/tools";

// Least privilege + exfiltration guard. `web_fetch` can reach an ARBITRARY
// URL, which an untrusted diff, PR title/body, or file content could try to
// steer it toward (data exfiltration / SSRF) — exactly the prompt-injection
// surface this subagent's instructions.md warns about. The reviewer's only
// network reach is the one configured console endpoint inside
// fetch_pr_diff, whose URL is built from env, not model input, so open web
// fetch is disabled.
export default disableTool();
