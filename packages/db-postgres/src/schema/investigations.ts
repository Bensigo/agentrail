import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  pgEnum,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { repositories } from "./repositories.js";

/**
 * Investigations — Jace's durable, server-side record of ONE production
 * incident (docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md,
 * spec PR #1501 — that spec doc lives on its own docs branch and is still
 * under review as of this migration; `.superpowers/sdd/spec.md` is the
 * working copy this implementation follows).
 *
 * Before this table, the only evidence Jace's `triage` subagent ever read
 * was `fetch_run_evidence`, scoped to one factory `run_id` — triage could
 * explain why a RUN failed because that was the only evidence it had.
 * Nothing explained why PRODUCTION was misbehaving: no deploy history, no
 * cross-run correlation, no way to say "this started after that change" and
 * have the claim survive past the conversation that produced it.
 * `investigations` is the durable home that makes debugging compound
 * instead of restarting from zero every incident — the same problem
 * `briefs.ts` solved for product ideas, applied to production symptoms. The
 * subagent directory/tool name stays `triage` (wire and calibration
 * continuity — verdict scores, run-outcome replies — depend on it); only its
 * identity widens to "Jace's debugger."
 *
 * ONE ROW PER INCIDENT, NOT PER REPORT. `fetch_investigations(mode:"anchor")`
 * runs first, always; on no hit, intake FTS-searches symptom signatures and
 * confirms once with the human ("this sounds like INV `checkout-500s` —
 * continue it, or new?"), then the conversation anchors via
 * `jace_sessions.anchored_investigation_id` (see that column's doc-comment
 * in `jace_sessions.ts`). Reopen-vs-new is pinned by prior OUTCOME, not by
 * symptom similarity alone: a prior `undetermined` investigation whose
 * symptom returns is REOPENED (its missing-evidence gap just got answered);
 * a prior `concluded` investigation whose symptom returns AFTER a fix
 * shipped is a NEW row with an `investigation_links` `recurrence_of` edge
 * back to the old one — the link is what structurally discredits the old
 * verdict, so nobody has to remember to distrust it by hand.
 *
 * `symptom_statement` is the human's own words, verbatim, never paraphrased
 * — same reasoning as `brief_items.evidence`: a paraphrase loses the *why*,
 * and a resumed conversation re-asks a settled question. `symptom_signature`
 * is the normalized, FTS-indexed form `searchInvestigations` (Task 2)
 * matches recurrence candidates against — two fields for the same reason
 * `brief_items.statement`/`.evidence` are two fields: one is for machines to
 * search, one is for humans (and Jace, on resume) to read verbatim.
 *
 * `depth_budget` defaults to 8 at the column level as a floor only; the real
 * per-incident value is DERIVED FROM SEVERITY by `upsertInvestigation`
 * (Task 2) at creation time and passed explicitly, so this default fires
 * only if a row is ever inserted outside that path. `jace_session_ids`
 * accumulates every conversation that has ever touched this investigation,
 * read-mostly, exactly like `briefs.jaceSessionIds` — many sessions, one
 * investigation.
 *
 * Mutability is deliberately uneven across the item kinds that live in
 * `investigation_items` — see that table's own doc-comment below for the
 * three route-enforced rules (evidence immutability, hypothesis
 * evidence-gating, verdict append-only). None of the three are enforced by
 * this schema file; they are ROUTE-level invariants (`patchInvestigationItems`,
 * Task 2; the runner save route, Task 3) — the same split `briefs.ts`
 * documents for its own `unknown`/`deferred` invariant.
 */
export const investigationStatusEnum = pgEnum("investigation_status", [
  "open",
  "investigating",
  "concluded",
  "handed_off",
]);
export type InvestigationStatus = (typeof investigationStatusEnum.enumValues)[number];

export const investigationSeverityEnum = pgEnum("investigation_severity", [
  "low",
  "medium",
  "high",
  "critical",
]);
export type InvestigationSeverity = (typeof investigationSeverityEnum.enumValues)[number];

export const investigationOpenedByEnum = pgEnum("investigation_opened_by", [
  "chat",
  "run-outcome",
  "alert",
]);
export type InvestigationOpenedBy = (typeof investigationOpenedByEnum.enumValues)[number];

export const investigationVerdictEnum = pgEnum("investigation_verdict", [
  "root_caused",
  "undetermined",
]);
export type InvestigationVerdict = (typeof investigationVerdictEnum.enumValues)[number];

/**
 * Set only once `computeVerdictEligibility` (Task 2) has passed and
 * `record_verdict` has actually written a `kind: 'verdict'` item — never a
 * self-assessed field, and never set independently of `verdict` above (both
 * are written together, only through the verdict route/query, per the
 * Global Constraints' "verdicts travel only through
 * `POST /api/v1/runner/investigations/verdict`, fail closed" rule).
 */
export const verdictConfidenceEnum = pgEnum("verdict_confidence", [
  "confirmed",
  "probable",
  "circumstantial",
]);
export type VerdictConfidence = (typeof verdictConfidenceEnum.enumValues)[number];

export const investigations = pgTable(
  "investigations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Nullable for the same reason briefs.repositoryId is: an investigation
    // can be opened from a chat symptom report before any repo is connected.
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    // Stable identity: Jace proposes it, the human can rename it in the
    // console. Reused across a reopen (see top comment) rather than
    // re-invented — re-inventing it is exactly what would fork a second row
    // for the same incident.
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    status: investigationStatusEnum("status").notNull().default("open"),
    severity: investigationSeverityEnum("severity").notNull().default("medium"),
    openedBy: investigationOpenedByEnum("opened_by").notNull().default("chat"),
    // Verbatim human words — never paraphrased. See top comment.
    symptomStatement: text("symptom_statement").notNull(),
    // Normalized form the FTS index below (searchInvestigations, Task 2)
    // matches recurrence candidates against. Empty string, not null, so the
    // FTS expression `title || ' ' || symptom_signature` never needs a
    // COALESCE.
    symptomSignature: text("symptom_signature").notNull().default(""),
    affectedSurface: text("affected_surface").notNull().default(""),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    // NULL until record_verdict (Task 8) writes a verdict item and the
    // verdict route denormalizes it here for cheap index-page rendering —
    // see top comment's mutability note. Never set directly by
    // save_investigation: the Global Constraints require the save route to
    // reject a `verdict` key in its body with 400.
    verdict: investigationVerdictEnum("verdict"),
    confidence: verdictConfidenceEnum("confidence"),
    // Floor default; see top comment for why the real value is computed
    // per-severity by upsertInvestigation rather than relying on this.
    depthBudget: integer("depth_budget").notNull().default(8),
    // Many-to-one edge, append-only, mirrors briefs.jaceSessionIds exactly.
    jaceSessionIds: jsonb("jace_session_ids").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One investigation per slug per workspace — upsertInvestigation
    // (Task 2) upserts against this identity, mirroring
    // briefs_workspace_id_slug_unique.
    workspaceIdSlugUnique: unique("investigations_workspace_id_slug_unique").on(
      t.workspaceId,
      t.slug
    ),
  })
);

export type Investigation = typeof investigations.$inferSelect;
export type NewInvestigation = typeof investigations.$inferInsert;

export const investigationItemKindEnum = pgEnum("investigation_item_kind", [
  "timeline_event",
  "evidence",
  "hypothesis",
  "finding",
  "verdict",
  "lesson_candidate",
]);
export type InvestigationItemKind = (typeof investigationItemKindEnum.enumValues)[number];

/**
 * NULL for every kind except `hypothesis`, where it drives the verdict gate
 * (`computeVerdictEligibility`, Task 2): entering `supported` needs a
 * non-empty `mechanism` and ≥ 1 `evidence_refs` entry, entering `refuted`
 * needs its own evidence ref, and a hypothesis may not enter either state
 * without one — enforced at the route, not here (see investigations' top
 * comment).
 */
export const hypothesisStateEnum = pgEnum("hypothesis_state", [
  "open",
  "supported",
  "refuted",
  "inconclusive",
]);
export type HypothesisState = (typeof hypothesisStateEnum.enumValues)[number];

export const investigationAuthorityEnum = pgEnum("investigation_authority", [
  "human",
  "jace",
]);
export type InvestigationAuthority = (typeof investigationAuthorityEnum.enumValues)[number];

/**
 * The ledger — every timeline note, evidence capture, hypothesis, finding,
 * verdict, and draft lesson an investigation accumulates lives here as one
 * typed row shape, exactly like `brief_items` does for a brief's six
 * coverage areas. `kind` determines how `state`/`data` are read:
 *   - `evidence`: `data` carries provider/verb/query/excerpt/digest/
 *     capturedAt (the `EvidenceEnvelope` shape, Task 4). IMMUTABLE — the
 *     evidence route (Task 4) is the ONLY writer of this kind;
 *     `save_investigation` must refuse to create, edit, or delete one.
 *   - `hypothesis`: `state` is meaningful (see hypothesisStateEnum above);
 *     `data` carries the discriminating test and what-would-settle-it. A
 *     STATE MACHINE gated on evidence — see hypothesisStateEnum.
 *   - `finding`: a claim with `evidence_refs`; `data.solePlausible: true` is
 *     the one-rival-refuted alternative the verdict gate accepts (see
 *     investigations' top comment / Task 2's `computeVerdictEligibility`).
 *   - `verdict`: APPEND-ONLY — recording a new verdict never edits a prior
 *     one, so reopening an investigation never erases history. `data`
 *     carries confidence + missing-evidence.
 *   - `lesson_candidate`: a Jace-drafted causal-pattern/test-recipe/
 *     system-gotcha note; promotion into workspace memory is console-only,
 *     human-gated (Task 13) — Jace never writes memory directly.
 *   - `timeline_event`: free-form witness-interview / round-report notes.
 * Separately, ANY item with `authority: 'human'` is never overwritten by the
 * model-facing save path regardless of kind — a human's "it's not the DB"
 * stays pinned, exactly like a human-authored `brief_items` row.
 */
export const investigationItems = pgTable(
  "investigation_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    investigationId: uuid("investigation_id")
      .notNull()
      .references(() => investigations.id, { onDelete: "cascade" }),
    kind: investigationItemKindEnum("kind").notNull(),
    // The claim/statement/note itself — meaning varies by kind (see table
    // doc-comment).
    body: text("body").notNull(),
    // Non-empty only for a `supported` hypothesis (verdict gate requirement,
    // see hypothesisStateEnum above) — default '' rather than null so
    // "mechanism.trim() !== ''" (computeVerdictEligibility, Task 2) never
    // needs a null check.
    mechanism: text("mechanism").notNull().default(""),
    // NULLABLE: meaningful only for kind = 'hypothesis'. See
    // hypothesisStateEnum's doc-comment.
    state: hypothesisStateEnum("state"),
    // Ids of other investigation_items (almost always kind='evidence' rows)
    // this item cites. jsonb array of ids rather than a join table, for the
    // same reason briefs keeps grounding as jsonb: the citation set is
    // small and read-mostly with the parent row, not independently queried.
    evidenceRefs: jsonb("evidence_refs").$type<string[]>().notNull().default([]),
    // Kind-specific payload — see table doc-comment above for the shape per
    // kind.
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    // Defaults 'jace' because most items originate from Jace's own
    // investigation work; a human console edit flips this to 'human', which
    // is what locks the item against save_investigation (table doc-comment
    // above) — exactly the brief_items.authority pattern.
    authority: investigationAuthorityEnum("authority").notNull().default("jace"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Postgres does not index a foreign key automatically. This column is
    // hit by every cascade delete off `investigations` AND by
    // getInvestigationBySlug/computeVerdictEligibility's
    // `WHERE investigation_id = …` — both on the hot path of a live
    // investigation (mirrors brief_items_brief_id_idx).
    investigationIdIdx: index("investigation_items_investigation_id_idx").on(
      t.investigationId
    ),
  })
);

export type InvestigationItem = typeof investigationItems.$inferSelect;
export type NewInvestigationItem = typeof investigationItems.$inferInsert;

export const investigationLinkRoleEnum = pgEnum("investigation_link_role", [
  "recurrence_of",
  "related",
]);
export type InvestigationLinkRole = (typeof investigationLinkRoleEnum.enumValues)[number];

/**
 * Investigation-to-investigation edges. `recurrence_of` is the reopen-vs-new
 * mechanism's other half (investigations' top comment): a new investigation
 * for a symptom that already had a `concluded` verdict links back to the old
 * one, which structurally discredits that old verdict without anyone having
 * to remember to distrust it by hand. `related` is the looser,
 * non-discrediting cross-reference. Both endpoints are FKs into
 * `investigations` itself — this table has no notion of undirected/
 * symmetric linking; `role` is read from the `investigation_id` row's point
 * of view (e.g. `investigation_id` is the NEW row, `target_investigation_id`
 * the OLD one it recurs from).
 */
export const investigationLinks = pgTable(
  "investigation_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    investigationId: uuid("investigation_id")
      .notNull()
      .references(() => investigations.id, { onDelete: "cascade" }),
    targetInvestigationId: uuid("target_investigation_id")
      .notNull()
      .references(() => investigations.id, { onDelete: "cascade" }),
    role: investigationLinkRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Same reasoning as investigation_items_investigation_id_idx: both
    // columns are FKs hit by cascade deletes off `investigations`, and
    // target_investigation_id is also the recurrence-lookup direction
    // ("what links point at this investigation as their recurrence target").
    investigationIdIdx: index("investigation_links_investigation_id_idx").on(
      t.investigationId
    ),
    targetInvestigationIdIdx: index(
      "investigation_links_target_investigation_id_idx"
    ).on(t.targetInvestigationId),
  })
);

export type InvestigationLink = typeof investigationLinks.$inferSelect;
export type NewInvestigationLink = typeof investigationLinks.$inferInsert;

export const investigationIssueRoleEnum = pgEnum("investigation_issue_role", [
  "mitigative",
  "preventative",
]);
export type InvestigationIssueRole = (typeof investigationIssueRoleEnum.enumValues)[number];

/**
 * The RESULT of an investigation's handoff — mirrors `brief_work_links`'
 * reasoning exactly (see that table's doc-comment in `briefs.ts`): without
 * this table nothing records which issues an investigation actually
 * produced. `role` distinguishes a `mitigative` issue (stop the bleeding —
 * e.g. a rollback or a targeted patch) from a `preventative` one (stop it
 * from happening again); both are written server-side at the approvals seam
 * (Task 12) from the issue draft's own stated intent, never model-asserted.
 * `repo` is free text, not an FK to `repositories`, for the same reason
 * `brief_work_links.repo` is: the linked issue may live in a repo this
 * workspace hasn't connected as a `repositories` row.
 *
 * `investigationRepoIssueUnique` (Task 12 fix round 1, migration 0063 —
 * originally assigned 0061, renumbered because `feat/sub-s1-billing-schema`
 * live-applied 0061/0062 first; see that migration file's own header): the
 * approval seam's own idempotency guard, same mechanism
 * `stampPublishedIssueUrl` already relies on for the sibling
 * `published_issue_url` column — `linkInvestigationIssue`
 * (`queries/investigations.ts`) targets this exact index with
 * `ON CONFLICT DO NOTHING`, so a `POST .../approvals/[id]/published` call
 * that runs twice for the same approval (idempotent stamp replay) collapses
 * to a single row at the DATABASE level — concurrent-safe, not a
 * read-then-write race a SELECT-then-INSERT guard would leave open. Short,
 * explicit index name (not the mechanical
 * `investigation_issue_links_investigation_id_repo_issue_number_unique`,
 * which is over Postgres's 63-byte NAMEDATALEN limit — see
 * `investigation_links_target_investigation_id_investigations_fk`'s own
 * shortening note in migration 0059 for the identical constraint).
 */
export const investigationIssueLinks = pgTable(
  "investigation_issue_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    investigationId: uuid("investigation_id")
      .notNull()
      .references(() => investigations.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    issueNumber: integer("issue_number").notNull(),
    role: investigationIssueRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    investigationIdIdx: index(
      "investigation_issue_links_investigation_id_idx"
    ).on(t.investigationId),
    investigationRepoIssueUnique: unique("investigation_issue_links_unique").on(
      t.investigationId,
      t.repo,
      t.issueNumber
    ),
  })
);

export type InvestigationIssueLink = typeof investigationIssueLinks.$inferSelect;
export type NewInvestigationIssueLink = typeof investigationIssueLinks.$inferInsert;
