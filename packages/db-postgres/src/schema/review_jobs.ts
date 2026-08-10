import { pgTable, uuid, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * Reviewer of Record queue (Arc B §2, spec
 * docs/superpowers/specs/2026-07-31-reviewer-of-record-design.md). Every PR
 * event on a connected repo becomes one row here; a headless Jace worker
 * claims rows (SKIP LOCKED) and posts the one review of record through the
 * existing reviewer choreography. This table has no consumers yet — the
 * claim/supersede/complete query layer lands in a later task.
 *
 * `id` is CALLER-SUPPLIED. Legacy queue admission derives a deterministic
 * uuid5 from `(workspaceId, repo, prNumber, headSha)`. Acceptance Record
 * admission instead uses its deterministic current-head cycle UUID so an
 * A→B→A revisit creates a fresh job rather than colliding with the terminal
 * first A row. Deliberately NO default here — neither `defaultRandom()` nor
 * SQL `gen_random_uuid()` — because both paths require deterministic replay
 * to hit `ON CONFLICT (id) DO NOTHING`; a missing caller id must fail rather
 * than silently double-admit work.
 *
 * Naming note (exploration finding): the existing `review_gates`
 * table/dashboard is a DIFFERENT, unrelated concept (per-run CI+advisory
 * telemetry) — this table, and all code touching it, says "review job",
 * never "review gate".
 *
 * `state` lifecycle (spec §2): `queued` → `running` → `posted` | `failed`,
 * plus `superseded` (a newer push on the same PR replaced this queued or
 * already-running exact-head job) and `skipped` (the per-workspace daily
 * budget was already spent). Superseded/failed/posted/skipped are terminal;
 * guarded completion/release cannot revive an invalidated running job.
 */
export const reviewJobs = pgTable(
  "review_jobs",
  {
    // Deterministic legacy-head or Acceptance-cycle uuid5 supplied by the
    // caller — see doc-comment above.
    // NOT defaultRandom(): a random fallback would defeat the
    // ON CONFLICT (id) DO NOTHING idempotency the design relies on.
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    // The GitHub webhook event that admitted this job (e.g. "opened",
    // "synchronize", "reopened") — carried through for the worker prompt and
    // notify/debugging; the intake route is what branches on it (e.g. draft
    // skip), not the queue SQL.
    event: text("event").notNull(),
    // queued|running|posted|superseded|skipped|failed — see the lifecycle
    // note above.
    state: text("state").notNull().default("queued"),
    // Bumped on a stale-running re-queue; > 2 escalates the job to 'failed'
    // (spec §2 "Staleness").
    attempts: integer("attempts").notNull().default(0),
    // Worker identity, set at claim time; null while queued.
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    // Debounce (a 'synchronize' job is inserted with now()+60s so a push
    // storm's newer heads supersede still-ineligible older ones first) and
    // post-staleness backoff. NULL = eligible now.
    nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true }),
    // Outcome fields, set by the complete route once the job leaves
    // 'running'. All null while queued/running.
    postedReviewUrl: text("posted_review_url"),
    verdict: text("verdict"),
    // Set only for state='skipped' (e.g. "daily budget exhausted") — never
    // silent (spec §2 "Budget").
    skipReason: text("skip_reason"),
    // B2a §1 Task 3 (spec docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md):
    // the object-store keys (Task 2's `review-evidence` upload route,
    // `lib/artifacts/store.ts`'s `artifactKey` scheme) a completed review
    // actually cited — Arc D's later attachment point to a Change Record.
    // Written by `completeReviewJob` on the `posted` outcome ONLY, when the
    // worker's structured result carries an `evidenceKeys` array; every
    // other path (no evidence attempted, or the calling worker/route simply
    // omits the field) leaves this column NULL, never `[]` — see migration
    // 0067's own doc-comment for why NULL and empty-array must stay
    // distinguishable. Nullable, no default, mirroring `runs.ts`'s
    // `selectedSources` precedent (bare optional jsonb array bolted onto an
    // already-populated table).
    evidenceKeys: jsonb("evidence_keys").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // The claim query's hot path filters `state='queued'` with no other
    // predicate narrowing it down first. Partial so a table dominated by
    // terminal rows (posted/superseded/skipped/failed) never bloats the
    // index the claim SQL actually scans.
    queuedIdx: index("review_jobs_queued_idx")
      .on(t.state)
      .where(sql`${t.state} = 'queued'`),
    // Supersede-on-insert's lookup key (spec §2: "mark that (workspace,
    // repo, pr)'s other jobs superseded") and any per-PR job history lookup.
    // Legacy enqueue supersedes queued siblings; the Acceptance Record
    // current-head transaction also supersedes running different-head jobs.
    prIdx: index("review_jobs_pr_idx").on(
      t.workspaceId,
      t.repo,
      t.prNumber
    ),
  })
);

export type ReviewJobRow = typeof reviewJobs.$inferSelect;
