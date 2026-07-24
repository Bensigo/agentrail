/**
 * Deep-links a wiki page citation (a repo-relative path, `wiki_pages.citations`)
 * to the exact file at the commit the page was compiled from — Repo Wiki spec
 * §4.5: "citations deep-link to the repo host at the pinned commit_sha ...
 * names over IDs everywhere". Every prose claim is one click from the source
 * that grounds it.
 *
 * Handles the two shapes `repositories.url` can hold —
 * `https://github.com/owner/repo(.git)` and `git@github.com:owner/repo(.git)`
 * — the same regex `failures/[failureId]/github-slug.ts`'s `parseGithubSlug`
 * uses (kept as a local copy here rather than a cross-feature import: it's a
 * three-line parse and the two features share no other module boundary).
 *
 * Returns null when `repoUrl` doesn't resolve to a github.com owner/repo, or
 * any input is empty — the caller renders the citation as plain text rather
 * than a dead link.
 */
export function buildCitationUrl(
  repoUrl: string,
  commitSha: string,
  path: string
): string | null {
  if (!repoUrl || !commitSha || !path) return null;

  const slug = repoUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!slug) return null;
  const [, owner, repo] = slug;

  const cleanPath = path.replace(/^\/+/, "");
  if (!cleanPath) return null;

  return `https://github.com/${owner}/${repo}/blob/${commitSha}/${cleanPath}`;
}
