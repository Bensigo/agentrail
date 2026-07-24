import type { WikiPageDTO } from "./wiki-format";

/**
 * A generic nested-path tree node. Pure, reused for two different LLM-first
 * rendering surfaces (owner ruling: "render the llm wiki in file structure
 * format"):
 *   1. the left nav, grouping unit PAGES by their unit's structural repo
 *      path ("agentrail/" -> "context", "apps/" -> "console", "jace" …);
 *   2. a per-page file-roster block, grouping a unit's individual FILES.
 * Both are "insert a list of slash-separated paths into a tree" — the same
 * pure operation over different leaf values, so one builder backs both.
 */
export interface TreeNode<T> {
  name: string;
  /** Full path from the tree root down to this node, slash-joined. */
  path: string;
  children: TreeNode<T>[];
  /** Present only when this EXACT path was inserted as a leaf — an
   * intermediate directory created just to hold children never carries one. */
  value?: T;
}

/**
 * Build a nested tree from a flat list of (slash-separated path, value)
 * pairs. Deterministic (insertion order preserved at each level); intermediate
 * directories are created on demand. An item whose path has no segments
 * (empty/whitespace-only) is skipped — callers that need a "no structural
 * data" fallback should filter those out and handle them separately (see
 * `buildWikiNavTree`/`buildFileRosterTree` below), never guess a path for it.
 */
export function buildTree<T>(items: Array<{ path: string; value: T }>): TreeNode<T>[] {
  const root: TreeNode<T>[] = [];

  for (const { path, value } of items) {
    const segments = path
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length === 0) continue;

    let level = root;
    let pathSoFar = "";
    segments.forEach((seg, i) => {
      pathSoFar = pathSoFar ? `${pathSoFar}/${seg}` : seg;
      let node = level.find((n) => n.name === seg);
      if (!node) {
        node = { name: seg, path: pathSoFar, children: [] };
        level.push(node);
      }
      if (i === segments.length - 1) {
        node.value = value;
      }
      level = node.children;
    });
  }

  return root;
}

/**
 * A unit page's structural repo path (e.g. "agentrail/context"), read from
 * `skeleton.path` — STRUCTURED compiler output, never inferred by parsing
 * the slug or the markdown body (owner ruling: "derive from structural
 * data ... NEVER by parsing body markdown"). Returns null when the compiler
 * hasn't populated path data (the compiler, spec PR 2, hasn't shipped yet —
 * every real page reads null today; this is the forward-compat seam it will
 * fill), so callers fall back to a flat list for that page individually.
 */
export function deriveUnitPath(page: WikiPageDTO): string | null {
  const raw = page.skeleton?.["path"];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, "");
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Group unit pages into a nested tree by `deriveUnitPath`. Pages without
 * structural path data go into `flat`, untouched (spec: "flat fallback if a
 * page lacks path data") — grouping never re-sorts or renames, and a page
 * with no path is never dropped.
 */
export function buildWikiNavTree(units: WikiPageDTO[]): {
  tree: TreeNode<WikiPageDTO>[];
  flat: WikiPageDTO[];
} {
  const grouped: Array<{ path: string; value: WikiPageDTO }> = [];
  const flat: WikiPageDTO[] = [];

  for (const unit of units) {
    const path = deriveUnitPath(unit);
    if (path) {
      grouped.push({ path, value: unit });
    } else {
      flat.push(unit);
    }
  }

  return { tree: buildTree(grouped), flat };
}

/**
 * A unit's file roster, read from `skeleton.files` — the same deterministic
 * "Structure" data the compiler renders into `bodyMd`'s prose (spec §4.1),
 * offered here as actual structured paths instead. Accepts either plain
 * path strings or `{path: string}` objects (skeleton is compiler-owned and
 * opaque; both are reasonable shapes for a file-roster array). Returns null
 * when the field is absent, not an array, or empty — the caller omits the
 * file-roster block entirely rather than rendering nothing useful.
 */
export function deriveFileRoster(page: WikiPageDTO): string[] | null {
  const raw = page.skeleton?.["files"];
  if (!Array.isArray(raw)) return null;

  const paths = raw
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      if (entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string") {
        return (entry as { path: string }).path.trim();
      }
      return "";
    })
    .filter(Boolean);

  return paths.length > 0 ? paths : null;
}

/** Build a unit's file-roster tree straight from its `skeleton.files` — null
 * when there's no roster to show (caller omits the block gracefully). */
export function buildFileRosterTree(page: WikiPageDTO): TreeNode<string>[] | null {
  const roster = deriveFileRoster(page);
  if (!roster) return null;
  return buildTree(roster.map((path) => ({ path, value: path })));
}
