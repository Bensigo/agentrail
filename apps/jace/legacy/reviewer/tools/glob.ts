import { disableTool } from "eve/tools";

// Least privilege. `glob` enumerates the host filesystem. The reviewer
// judges a fetched diff only and needs no view of local files (it never
// clones or checks out the reviewed repo), so this framework tool is
// stripped.
export default disableTool();
