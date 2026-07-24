import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import { wikiPages, WIKI_PAGE_LINKS_DEFAULT } from "../schema/wiki_pages.js";
import type {
  WikiPage,
  WikiPageKind,
  WikiPageLinks,
  WikiPageSkeleton,
} from "../schema/wiki_pages.js";

/**
 * Repo Wiki queries (Repo Wiki spec §4.4, delivery plan §7 row 4 — server
 * system of record). `wiki_pages` follows the shape `memory_items` already
 * established for server-durable compiled context: upsert-by-identity writes
 * (here `(repository_id, slug)`, mirroring `replaceMemoryItemsByWriter`'s
 * "a re-run replaces its own prior writes" idempotency) and an FTS search
 * mirroring `retrieveMemory`'s step-1 prefilter — `websearch_to_tsquery` over
 * a GIN index, falling back to recency on zero hits. Raw
 * `db.execute(sql\`…\`)` backs the reads because the FTS predicate needs a
 * literal `to_tsvector('english', …)` expression the query builder can't
 * express portably (same reasoning `fetchFtsCandidates` documents).
 */

/**
 * Map a raw (snake_case) `db.execute` row back to the typed `WikiPage` shape.
 *
 * `generated_at`/`created_at`/`updated_at` go through `new Date(...)`, not an
 * `as Date` cast: raw `db.execute(sql\`…\`)` bypasses drizzle's column-type
 * mapper (that only runs for the query builder, e.g. `db.select()`), so
 * `postgres-js` hands back a plain "YYYY-MM-DD HH:MM:SS.ssssss+00" STRING for
 * a `timestamp with time zone` column here — confirmed against a live
 * Postgres (`.toISOString()` on the un-cast value throws `TypeError: ...
 * .toISOString is not a function`, since a string has no such method; the
 * `as Date` cast made TypeScript trust a shape the runtime value never had).
 * `new Date(x)` is the fix either way: it parses a string, and passes a real
 * `Date` through unchanged, so this stays correct however a future caller's
 * driver/mock happens to shape the row.
 */
function mapWikiPageExecRow(r: Record<string, unknown>): WikiPage {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    repositoryId: String(r.repository_id),
    slug: String(r.slug),
    title: String(r.title),
    kind: r.kind as WikiPageKind,
    bodyMd: String(r.body_md),
    skeleton: (r.skeleton as WikiPageSkeleton | null) ?? {},
    links: (r.links as WikiPageLinks | null) ?? { ...WIKI_PAGE_LINKS_DEFAULT },
    citations: (r.citations as string[] | null) ?? [],
    commitSha: String(r.commit_sha),
    inputsHash: String(r.inputs_hash),
    model: (r.model as string | null) ?? null,
    writtenBy: String(r.written_by),
    generatedAt: new Date(r.generated_at as string | number | Date),
    stale: Boolean(r.stale),
    createdAt: new Date(r.created_at as string | number | Date),
    updatedAt: new Date(r.updated_at as string | number | Date),
  };
}

export interface UpsertWikiPageInput {
  slug: string;
  title: string;
  kind: WikiPageKind;
  bodyMd: string;
  skeleton?: WikiPageSkeleton;
  links?: WikiPageLinks;
  citations?: string[];
  commitSha: string;
  inputsHash: string;
  /** Null/omitted on a fail-open skeleton-only page (no LLM prose, no model). */
  model?: string | null;
  writtenBy?: string;
  generatedAt: string | Date;
}

export interface UpsertWikiPagesResult {
  inserted: number;
  replaced: number;
}

/**
 * Upsert-by-`(repository_id, slug)` — the ingest route's (contract 1) write
 * path. Unlike `replaceMemoryItemsByWriter`'s whole-batch delete+insert, this
 * is per-slug: the compiler only ever sends pages whose `inputsHash` changed,
 * so an UNCHANGED slug for the same repo must be left untouched, never
 * deleted. Every upserted row gets `stale = false` unconditionally — a
 * pushed page is fresh as of this push, by contract.
 *
 * `inserted`/`replaced` are computed from a pre-upsert existence check
 * (rather than the Postgres `xmax = 0` trick) so the whole batch runs as
 * plain, easily-mocked `insert().values().onConflictDoUpdate()` calls inside
 * one transaction — simplicity over one fewer round trip; batches are small
 * (≤ 24 unit pages + 1 overview per repo, §4.1's page budget).
 */
export async function upsertWikiPages(data: {
  workspaceId: string;
  repositoryId: string;
  pages: UpsertWikiPageInput[];
}): Promise<UpsertWikiPagesResult> {
  if (data.pages.length === 0) return { inserted: 0, replaced: 0 };

  return db.transaction(async (tx) => {
    const slugs = data.pages.map((p) => p.slug);
    const existing = await tx
      .select({ slug: wikiPages.slug })
      .from(wikiPages)
      .where(and(eq(wikiPages.repositoryId, data.repositoryId), inArray(wikiPages.slug, slugs)));
    const existingSlugs = new Set(existing.map((r) => r.slug));

    for (const page of data.pages) {
      const generatedAt =
        page.generatedAt instanceof Date ? page.generatedAt : new Date(page.generatedAt);
      const links = page.links ?? { ...WIKI_PAGE_LINKS_DEFAULT };
      const citations = page.citations ?? [];
      const skeleton = page.skeleton ?? {};
      const model = page.model ?? null;
      const writtenBy = page.writtenBy ?? "wiki-compiler";

      await tx
        .insert(wikiPages)
        .values({
          workspaceId: data.workspaceId,
          repositoryId: data.repositoryId,
          slug: page.slug,
          title: page.title,
          kind: page.kind,
          bodyMd: page.bodyMd,
          skeleton,
          links,
          citations,
          commitSha: page.commitSha,
          inputsHash: page.inputsHash,
          model,
          writtenBy,
          generatedAt,
          stale: false,
        })
        .onConflictDoUpdate({
          target: [wikiPages.repositoryId, wikiPages.slug],
          set: {
            title: page.title,
            kind: page.kind,
            bodyMd: page.bodyMd,
            skeleton,
            links,
            citations,
            commitSha: page.commitSha,
            inputsHash: page.inputsHash,
            model,
            writtenBy,
            generatedAt,
            stale: false,
            updatedAt: new Date(),
          },
        });
    }

    const replaced = data.pages.filter((p) => existingSlugs.has(p.slug)).length;
    return { inserted: data.pages.length - replaced, replaced };
  });
}

/**
 * Every page for a repo, ordered "wiki/overview" first then units
 * alphabetically — for free, via `ORDER BY slug ASC`: every unit slug is
 * "wiki/unit/…" and 'o' < 'u', so "wiki/overview" always sorts before any
 * unit slug, and unit slugs alphabetize among themselves with no
 * special-casing. Backs the hydration GET (full pages) and the runner
 * list/search modes (the route projects out the fields each mode omits).
 */
export async function listWikiPages(
  workspaceId: string,
  repositoryId: string
): Promise<WikiPage[]> {
  const result = await db.execute(sql`
    SELECT id, workspace_id, repository_id, slug, title, kind, body_md, skeleton, links,
           citations, commit_sha, inputs_hash, model, written_by, generated_at, stale,
           created_at, updated_at
    FROM wiki_pages
    WHERE workspace_id = ${workspaceId} AND repository_id = ${repositoryId}
    ORDER BY slug ASC
  `);
  return (Array.from(result) as Record<string, unknown>[]).map(mapWikiPageExecRow);
}

/** Single page by slug — backs the runner `get` mode. Null when not found. */
export async function getWikiPage(
  workspaceId: string,
  repositoryId: string,
  slug: string
): Promise<WikiPage | null> {
  const result = await db.execute(sql`
    SELECT id, workspace_id, repository_id, slug, title, kind, body_md, skeleton, links,
           citations, commit_sha, inputs_hash, model, written_by, generated_at, stale,
           created_at, updated_at
    FROM wiki_pages
    WHERE workspace_id = ${workspaceId} AND repository_id = ${repositoryId} AND slug = ${slug}
    LIMIT 1
  `);
  const rows = Array.from(result) as Record<string, unknown>[];
  return rows[0] ? mapWikiPageExecRow(rows[0]) : null;
}

export const WIKI_SEARCH_DEFAULT_LIMIT = 5;
export const WIKI_SEARCH_MAX_LIMIT = 10;

/**
 * FTS search over `body_md`, mirroring `retrieveMemory`'s step-1 prefilter:
 * `websearch_to_tsquery` ranked by `ts_rank_cd`, scoped to (workspace,
 * repository). An empty/whitespace query skips the FTS round trip (nothing
 * lexical to rank on) and a zero-hit FTS query both fall back to the most
 * recently generated pages — a search is a navigation aid, never a dead end.
 */
export async function searchWikiPages(
  workspaceId: string,
  repositoryId: string,
  query: string,
  limit: number = WIKI_SEARCH_DEFAULT_LIMIT
): Promise<WikiPage[]> {
  const trimmedQuery = query.trim();
  const cappedLimit = Math.min(WIKI_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(limit) || 1));

  if (trimmedQuery.length > 0) {
    const result = await db.execute(sql`
      SELECT id, workspace_id, repository_id, slug, title, kind, body_md, skeleton, links,
             citations, commit_sha, inputs_hash, model, written_by, generated_at, stale,
             created_at, updated_at
      FROM wiki_pages
      WHERE workspace_id = ${workspaceId} AND repository_id = ${repositoryId}
        AND to_tsvector('english', body_md) @@ websearch_to_tsquery('english', ${trimmedQuery})
      ORDER BY ts_rank_cd(to_tsvector('english', body_md), websearch_to_tsquery('english', ${trimmedQuery})) DESC
      LIMIT ${cappedLimit}
    `);
    const rows = (Array.from(result) as Record<string, unknown>[]).map(mapWikiPageExecRow);
    if (rows.length > 0) return rows;
  }

  const recent = await db.execute(sql`
    SELECT id, workspace_id, repository_id, slug, title, kind, body_md, skeleton, links,
           citations, commit_sha, inputs_hash, model, written_by, generated_at, stale,
           created_at, updated_at
    FROM wiki_pages
    WHERE workspace_id = ${workspaceId} AND repository_id = ${repositoryId}
    ORDER BY generated_at DESC
    LIMIT ${cappedLimit}
  `);
  return (Array.from(recent) as Record<string, unknown>[]).map(mapWikiPageExecRow);
}
