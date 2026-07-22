import { disableTool } from "eve/tools";

// Least privilege. `read_file` reads the host filesystem of the Jace
// deployment, which is where secrets live (e.g. .agentrail/server.json's
// live API key). The reviewer's only legitimate input is the PR diff it
// fetches over HTTP via fetch_pr_diff; it never needs local files, so the
// host FS is closed to it entirely.
export default disableTool();
