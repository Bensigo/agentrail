/**
 * Parse `owner/repo` out of a stored repository URL. Handles the two shapes the
 * repositories table holds: `https://github.com/owner/repo(.git)` and
 * `git@github.com:owner/repo(.git)`. Returns null for anything else.
 */
export function parseGithubSlug(
  url: string
): { owner: string; repo: string } | null {
  if (!url) return null;
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}
