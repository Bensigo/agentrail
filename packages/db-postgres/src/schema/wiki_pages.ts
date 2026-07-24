import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  boolean,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { repositories } from "./repositories.js";

/**
 * Repo Wiki — the server system of record for compiled repository knowledge
 * (docs/superpowers/specs/2026-07-23-repo-wiki-compiled-repo-knowledge-design.md,
 * §4.4 "Consumption — Jace and the server"; delivery plan §7 row 4).
 *
 * One row per compiled page: a repo overview page (slug "wiki/overview") plus
 * one page per Codebase Unit (slug "wiki/unit/<unit-id>") — explicitly NOT
 * per-file or per-symbol in v1 (§5 "Not building"). The server is the
 * durable home: clones are ephemeral (`tempfile.mkdtemp` + `rmtree` on every
 * path in this codebase — onboard.py, sandbox/native_runner.py,
 * sandbox/docker_runner.py), so a checkout can never be where wiki knowledge
 * lives. Pages are pushed here by the compiler (PR 2/7, still flag-OFF) via
 * `POST /api/v1/ingest/wiki-pages`, and HYDRATED into a fresh clone's local
 * `.agentrail/context/wiki/` cache by `agentrail/context/wiki_fetch.py` —
 * the same pull-a-durable-snapshot-into-an-ephemeral-clone shape
 * `agentrail/context/memory_fetch.py` already established for `memory_items`.
 *
 * `body_md` is the canonical compiled artifact — exactly what agents AND the
 * console (PR 6) both read ("what you see is what the LLM sees", §4.5).
 * `skeleton` holds the deterministic compile inputs (file roster, exported
 * symbols, unit-dependency edges, test counts) so the compiler can hash-diff
 * without parsing markdown; this PR treats its shape as opaque JSON (system
 * of record, not the compiler — PR 2 owns the renderer). `links` holds the
 * `[[slug]]` page graph + the `unit_depends_on` rollup (PR 1).
 */
export const wikiPageKindEnum = pgEnum("wiki_page_kind", ["overview", "unit"]);
export type WikiPageKind = (typeof wikiPageKindEnum.enumValues)[number];

/** The `[[slug]]` page graph (§4.1) + the `unit_depends_on` rollup (PR 1). */
export interface WikiPageLinks {
  related: string[];
  dependsOn: string[];
  dependedOnBy: string[];
}

export const WIKI_PAGE_LINKS_DEFAULT: WikiPageLinks = {
  related: [],
  dependsOn: [],
  dependedOnBy: [],
};

/**
 * Deterministic compile inputs (file roster, exported symbols, unit deps,
 * test counts) the compiler (PR 2) renders and hash-diffs against. This PR
 * is the system of record, not the compiler, so the shape is deliberately
 * left opaque here rather than guessed at.
 */
export type WikiPageSkeleton = Record<string, unknown>;

export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    // Stable identity: "wiki/overview" | "wiki/unit/<unit-id>" (§3 "Page grain").
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    kind: wikiPageKindEnum("kind").notNull(),
    // The canonical compiled artifact agents (and, PR 6, the console) read.
    bodyMd: text("body_md").notNull(),
    skeleton: jsonb("skeleton").$type<WikiPageSkeleton>().notNull().default({}),
    links: jsonb("links")
      .$type<WikiPageLinks>()
      .notNull()
      .default(WIKI_PAGE_LINKS_DEFAULT),
    // Repo-relative paths grounding every prose claim (§4.7 safety invariant:
    // every page carries citations and a provenance header).
    citations: jsonb("citations").$type<string[]>().notNull().default([]),
    commitSha: text("commit_sha").notNull(),
    // "sha256:…" over sorted (path, contentHash) pairs of the unit's files —
    // the freshness diff key (§3 "Freshness").
    inputsHash: text("inputs_hash").notNull(),
    // Null on a fail-open skeleton-only page (§4.2: an LLM error never blocks
    // a page from shipping — it ships without prose, hence without a model).
    model: text("model"),
    writtenBy: text("written_by").notNull().default("wiki-compiler"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    // Server-side freshness marker (§3 "Page record shape"). The ingest route
    // (contract 1, PR 4) sets this false, unconditionally, on every upsert —
    // a pushed page is by definition fresh as of that push. NOTHING in this
    // PR's scope ever sets it true: the mechanism for that (detecting a
    // hash-mismatched page the compiler chose not to regenerate this cycle,
    // e.g. hitting the per-compile cost ceiling) belongs to the compiler
    // (PR 2) and is not yet wired. Defaults false so a freshly inserted row
    // is never mistakenly shown stale before anything has had a chance to
    // mark it so.
    stale: boolean("stale").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One page per slug per repository — the target of the ingest route's
    // upsert-by-(repository_id, slug) replace semantics (mirrors
    // `connectors_workspace_provider_unique`'s composite-unique shape).
    repositoryIdSlugUnique: unique("wiki_pages_repository_id_slug_unique").on(
      t.repositoryId,
      t.slug
    ),
  })
);

export type WikiPage = typeof wikiPages.$inferSelect;
export type NewWikiPage = typeof wikiPages.$inferInsert;
