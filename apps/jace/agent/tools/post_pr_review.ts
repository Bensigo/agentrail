// The old reviewer-of-record lane posted advisory GitHub PR comments outside
// the Acceptance Record. It is deliberately absent from Jace's runtime tool
// registry while its core and historical data are retired in a later cleanup.
// Canonical blocking corrections are created only by the exact-head Acceptance
// Review completion boundary, then delivered to the recorded builder task or
// durable fallback.
import { disableTool } from "eve/tools";

export default disableTool();
