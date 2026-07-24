/**
 * The command a user runs locally to re-index a repo and refresh its health
 * — relocated from the (now-redirected) repos feature when Repos & Health
 * folded into the Wiki view (owner ruling). This IS the "Recompile" command:
 * the wiki compile step lives inside `build_index` (spec §4.2), so the same
 * `agentrail context index` run refreshes both index health and the wiki.
 */
export function reindexCommand(): string {
  return "agentrail context index";
}
