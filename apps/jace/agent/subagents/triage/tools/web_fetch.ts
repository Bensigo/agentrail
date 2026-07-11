import { disableTool } from "eve/tools";

// AC1 — least privilege + exfiltration guard. `web_fetch` can reach an ARBITRARY
// URL, which an untrusted failure excerpt could try to steer it toward (data
// exfiltration / SSRF). Triage's only network reach is the one configured console
// endpoint inside fetch_run_evidence, whose URL is built from env, not model
// input, so open web fetch is disabled.
export default disableTool();
