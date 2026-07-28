import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { repositories } from "./repositories.js";

/**
 * Briefs — Jace's durable, server-side understanding of ONE product idea
 * (docs/superpowers/specs/2026-07-28-jace-briefs-durable-idea-understanding-design.md,
 * spec PR #1487).
 *
 * `grill-me/SKILL.md` used to tell Jace to persist the requirements interview
 * by writing `CONTEXT.md` (and an ADR under `docs/adr/`) into the repo. That
 * instruction is impossible in the hosted deployment: `apps/jace/Dockerfile`
 * installs no git and clones nothing, so those writes landed in an ephemeral
 * `/workspace` sandbox and died with the container the moment the run ended.
 * A phantom write is worse than no write — it reads as captured when nothing
 * was kept. The `i want to add a blog our app` session (2026-07-27,
 * 9 turns, zero of grill-me's six areas closed) is the concrete cost: no
 * server-durable home meant no resumable understanding, so the next turn
 * re-asked what the human had already answered. `wiki_pages.ts` states the
 * same principle for compiled knowledge — "clones are ephemeral … so a
 * checkout can never be where wiki knowledge lives" — and briefs are that
 * same durable home for ELICITED knowledge.
 *
 * A brief is long-lived and keyed `(workspace_id, slug)`, upsert-by-identity
 * mirroring `wiki_pages`' `(repository_id, slug)` shape. Adding auth to a
 * blog six months after the blog shipped reopens the SAME brief rather than
 * forking a second one — it is the same product understanding growing, not
 * a new idea. `repository_id` is nullable because a brief can be started
 * before any repo is connected (grilling can precede `to-issues` by a long
 * margin). `jace_session_ids` accumulates every conversation that has ever
 * touched this brief — many sessions, one brief.
 */
export const briefStatusEnum = pgEnum("brief_status", ["draft", "ready"]);
export type BriefStatus = (typeof briefStatusEnum.enumValues)[number];

/**
 * `status` is a HUMAN label toggled in the console — never set by the agent.
 * Implementation-readiness is a computed property (`computeBriefReadiness`),
 * kept deliberately separate: if "ready" were the same field the model could
 * set to unblock itself, `to-issues` gating on it would gate on nothing.
 */
export const BRIEF_STATUS_DEFAULT: BriefStatus = "draft";

export const briefAreaEnum = pgEnum("brief_area", [
  "problem",
  "users",
  "constraints",
  "scope",
  "success-signal",
]);
export type BriefArea = (typeof briefAreaEnum.enumValues)[number];

export const briefItemKindEnum = pgEnum("brief_item_kind", [
  "required",
  "optional",
  "unknown",
  "out-of-scope",
]);
export type BriefItemKind = (typeof briefItemKindEnum.enumValues)[number];

export const briefItemStateEnum = pgEnum("brief_item_state", ["open", "resolved"]);
export type BriefItemState = (typeof briefItemStateEnum.enumValues)[number];

/**
 * Set only when `state = 'resolved'`; null while `state = 'open'`.
 *
 * `state` and `resolution` are deliberately two fields, not one, because they
 * answer different questions over a brief's lifetime. `state` drives the
 * readiness gate, and that gate must evaluate only the CURRENT phase of a
 * long-lived brief — phase one's settled items must not block phase two's
 * gate, and phase two's fresh `open` items must not be masked by phase one's
 * completeness. `resolution` exists because not every requirement ends in
 * shipped code: some are deferred to a later phase, some are rejected
 * outright, some are satisfied by something other than code (docs, an
 * existing feature). Collapsing the two into one field would make "which
 * requirements were actually implemented?" unanswerable from the row alone.
 *
 * `deferred` is the reopen mechanism: a deferred item stays on the brief as
 * known future work, and reopening flips chosen deferred items back to
 * `open` rather than starting phase two from a blank page.
 *
 * `unknown` may never resolve to `deferred` — only to an answer (which
 * re-kinds it `required`/`optional`) or to `out-of-scope`. "We'll figure it
 * out later" on something still marked `unknown` is exactly the gap a
 * builder fills by inventing an acceptance criterion; `out-of-scope` removes
 * the work from the idea, `deferred` schedules it — the two must not
 * collapse into each other. This particular invariant is enforced at the
 * console API route (`POST /api/v1/runner/briefs`, out of this package's
 * scope), not here — see the design spec's "Two invariants live in the
 * ROUTE, not in any prompt" note.
 */
export const briefItemResolutionEnum = pgEnum("brief_item_resolution", [
  "implemented",
  "deferred",
  "rejected",
  "satisfied-elsewhere",
]);
export type BriefItemResolution = (typeof briefItemResolutionEnum.enumValues)[number];

export const briefAuthorityEnum = pgEnum("brief_authority", ["human", "jace"]);
export type BriefAuthority = (typeof briefAuthorityEnum.enumValues)[number];

/**
 * The wiki page slugs and memory item ids read at the brief's last write,
 * plus the wiki's own commit stamp at that time — not new machinery, just a
 * comparison against provenance `wiki_pages` already stamps every page with.
 * On resume, Jace compares stamps: same commit, continue; any cited page
 * moved since, re-ground before proposing anything and say so. A stale
 * grounding read on a repo that has since moved is exactly how a confident,
 * wrong proposal gets made.
 */
export interface BriefGrounding {
  wikiPageSlugs: string[];
  memoryItemIds: string[];
  commitSha: string | null;
}

export const BRIEF_GROUNDING_DEFAULT: BriefGrounding = {
  wikiPageSlugs: [],
  memoryItemIds: [],
  commitSha: null,
};

export const briefs = pgTable(
  "briefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Nullable: a brief can exist before a repo is connected — grilling can
    // precede repo hookup, and to-issues (which needs a repo) is a later step.
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    // Stable identity: Jace proposes it, the human renames it in the
    // console. Not something the model re-invents per conversation — that
    // is what causes a second brief to fork for the same idea.
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    status: briefStatusEnum("status").notNull().default(BRIEF_STATUS_DEFAULT),
    // The question in flight when a grill session ends, so the next session
    // resumes with "here's what's settled and here's what I was about to ask"
    // instead of "so, tell me about the blog" (the original bug).
    openQuestion: text("open_question").notNull().default(""),
    grounding: jsonb("grounding").$type<BriefGrounding>().notNull().default(BRIEF_GROUNDING_DEFAULT),
    // Many sessions attach to one brief over its lifetime; this is the
    // many-to-one edge, read-mostly (append a session id, never rewritten).
    jaceSessionIds: jsonb("jace_session_ids").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One brief per slug per workspace — the target of upsertBrief's
    // upsert-by-(workspace_id, slug) semantics, mirroring wiki_pages'
    // repository-scoped unique.
    workspaceIdSlugUnique: unique("briefs_workspace_id_slug_unique").on(
      t.workspaceId,
      t.slug
    ),
  })
);

export type Brief = typeof briefs.$inferSelect;
export type NewBrief = typeof briefs.$inferInsert;

/**
 * A brief is a set of typed items, not a document — grill-me's six coverage
 * areas plus a firmness/status/authority triple per item, so everything the
 * model needs to reason about (what's settled, what's missing, what
 * shipped) falls out of one row shape rather than a second reporting layer
 * over free text.
 */
export const briefItems = pgTable("brief_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  briefId: uuid("brief_id")
    .notNull()
    .references(() => briefs.id, { onDelete: "cascade" }),
  area: briefAreaEnum("area").notNull(),
  statement: text("statement").notNull(),
  // The human's own words that settled this item, verbatim — not the
  // normalized `statement`. After a context compaction Jace has the brief
  // and nothing else; a paraphrase loses the *why* and the next turn
  // re-asks a settled question. "for now since am the only one approve to
  // publish it" carries more on resume than "single approver model."
  evidence: text("evidence").notNull().default(""),
  kind: briefItemKindEnum("kind").notNull(),
  state: briefItemStateEnum("state").notNull().default("open"),
  // NULLABLE, set only alongside state = 'resolved'. See the comment on
  // briefItemResolutionEnum above for why this is a separate field from
  // `state` rather than folded into it.
  resolution: briefItemResolutionEnum("resolution"),
  // Who asserted this item. Defaults to 'jace' because most items originate
  // from the grill conversation; a human console edit flips this to
  // 'human', which is what locks the item against `patchBriefItems` (see
  // that function's doc-comment for the enforcement, not just the label).
  authority: briefAuthorityEnum("authority").notNull().default("jace"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BriefItem = typeof briefItems.$inferSelect;
export type NewBriefItem = typeof briefItems.$inferInsert;

export const briefWorkLinkRoleEnum = pgEnum("brief_work_link_role", [
  "epic-parent",
  "slice",
]);
export type BriefWorkLinkRole = (typeof briefWorkLinkRoleEnum.enumValues)[number];

/**
 * The RESULT of turning a brief into work — a brief produces no work yet,
 * one issue, several issues, or an epic that expands into issues, and the
 * shape decision is derived at planning time rather than stored on the
 * brief. Without this link table, nothing can flip a brief item to
 * `resolved / implemented`, and "what shipped for this idea" has no answer.
 * `brief_item_id` is nullable because not every linked issue traces to one
 * specific item (an epic-parent issue represents the whole brief, not a
 * single requirement). `role` distinguishes the epic-parent issue from its
 * slices because `to-issues` already publishes the epic first and points
 * slices at it as Parent — this table only needs to record that shape, not
 * invent a new one.
 */
export const briefWorkLinks = pgTable("brief_work_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  briefId: uuid("brief_id")
    .notNull()
    .references(() => briefs.id, { onDelete: "cascade" }),
  briefItemId: uuid("brief_item_id").references(() => briefItems.id, {
    onDelete: "set null",
  }),
  // Not an FK to `repositories` — the linked issue may live in a repo this
  // workspace hasn't connected as a `repositories` row (e.g. the epic-parent
  // repo differs from a slice's target repo). Free-form "owner/name", same
  // shape GitHub issue references use elsewhere in this codebase.
  repo: text("repo").notNull(),
  issueNumber: integer("issue_number").notNull(),
  role: briefWorkLinkRoleEnum("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BriefWorkLink = typeof briefWorkLinks.$inferSelect;
export type NewBriefWorkLink = typeof briefWorkLinks.$inferInsert;
