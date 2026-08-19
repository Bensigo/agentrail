import {
  acceptanceContextPackCustodyBaseIndexRevisionSha256,
  wikiPageBodySha256,
  type AcceptanceContextPackCustodyBaseIndexIdentity,
  type listWikiPages,
} from "@agentrail/db-postgres";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA1 = /^[a-f0-9]{40}$/iu;
const SHA256 = /^[a-f0-9]{64}$/iu;
const SAFE_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\u0000-\u001f\u007f]+$/u;
const MAX_WIKI_PAGES = 100;
const MAX_WIKI_PAGE_BYTES = 512 * 1024;
const MAX_WIKI_TOTAL_BYTES = 4 * 1024 * 1024;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeWikiPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && value === value.trim() && SAFE_PATH.test(value) && !value.endsWith("/");
}

/**
 * Canonical deterministic Wiki generation identity shared by every Context
 * Pack producer. Changing bounds, ordering, or gap copy changes custody.
 */
export function buildAcceptanceContextPackWikiBaseIndex(input: {
  workspaceId: string;
  repositoryId: string;
  pages: Awaited<ReturnType<typeof listWikiPages>>;
}): AcceptanceContextPackCustodyBaseIndexIdentity {
  const selected: AcceptanceContextPackCustodyBaseIndexIdentity["pages"] = [];
  const gaps = new Set<string>();
  let totalBytes = 0;
  const ordered = [...input.pages].sort((left, right) =>
    compareText(`${left.slug}\u0000${left.id}`, `${right.slug}\u0000${right.id}`));
  for (const page of ordered) {
    if (selected.length >= MAX_WIKI_PAGES) {
      gaps.add("Compiled Wiki page count exceeded the 100-page custody limit");
      break;
    }
    const bodyBytes = Buffer.byteLength(page.bodyMd, "utf8");
    if (page.workspaceId !== input.workspaceId || page.repositoryId !== input.repositoryId
      || !UUID.test(page.id) || !safeWikiPath(page.slug) || !SHA1.test(page.commitSha)
      || !SHA256.test(page.inputsHash) || bodyBytes < 1 || bodyBytes > MAX_WIKI_PAGE_BYTES) {
      gaps.add("Some compiled Wiki pages were excluded because their immutable identity or body bounds were invalid");
      continue;
    }
    if (totalBytes + bodyBytes > MAX_WIKI_TOTAL_BYTES) {
      gaps.add("Compiled Wiki bodies exceeded the 4 MiB custody limit");
      continue;
    }
    totalBytes += bodyBytes;
    selected.push({
      id: page.id,
      repositoryId: page.repositoryId,
      slug: page.slug,
      commitSha: page.commitSha.toLowerCase(),
      inputsHashSha256: page.inputsHash.toLowerCase(),
      pageBodySha256: wikiPageBodySha256(page.bodyMd),
      stale: page.stale,
    });
  }
  if (selected.length === 0 && gaps.size === 0) {
    gaps.add("No compiled Wiki pages exist for this repository");
  }
  const core = {
    schemaVersion: 2 as const,
    backgroundOnly: true as const,
    pages: selected,
    gaps: [...gaps].sort(compareText),
  };
  return {
    ...core,
    revisionSha256: acceptanceContextPackCustodyBaseIndexRevisionSha256(core),
  };
}
