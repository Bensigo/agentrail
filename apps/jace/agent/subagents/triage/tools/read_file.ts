import { disableTool } from "eve/tools";

// AC1 — least privilege. `read_file` reads the host filesystem of the Jace
// deployment, which is where secrets live (e.g. .agentrail/server.json's live API
// key). Triage's only legitimate input is the failure bundle it fetches over HTTP
// via fetch_run_evidence; it never needs local files, so the host FS is closed to
// it entirely.
export default disableTool();
