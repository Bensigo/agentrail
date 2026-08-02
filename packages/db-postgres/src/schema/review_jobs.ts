import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
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
 * `id` is CALLER-SUPPLIED: a deterministic uuid5 of `(workspaceId, repo,
 * prNumber, headSha)`, computed in the query layer the same way
 * `github_intake.ts`'s `entryId` derives `queue_entries.id` (the `entryId`
 * precedent). Deliberately NO default here — neither `defaultRandom()` nor
 * SQL `gen_random_uuid()` — because the whole idempotency story
 * (`ON CONFLICT (id) DO NOTHING` making a replayed webhook a no-op) only
 * holds if the SAME logical (workspace, repo, pr, head) always hashes to the
 * SAME row. A random fallback would silently defeat that: a caller that
 * forgot to compute the deterministic id should hit a NOT NULL violation,
 * never get a fresh random id that masks the bug and double-admits the row.
 *
 * Naming note (exploration finding): the existing `review_gates`
 * table/dashboard is a DIFFERENT, unrelated concept (per-run CI+advisory
 * telemetry) — this table, and all code touching it, says "review job",
 * never "review gate".
 *
 * `state` lifecycle (spec §2): `queued` → `running` → `posted` | `failed`,
 * plus `superseded` (a newer push on the same PR replaced this still-queued
 * job before it ran) and `skipped` (the per-workspace daily budget was
 * already spent). Superseded/failed/posted/skipped are all terminal.
 */
export const reviewJobs = pgTable(
  "review_jobs",
  {
    // Deterministic uuid5 supplied by the caller — see doc-comment above.
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
    // repo, pr)'s other queued jobs superseded") and any per-PR job history
    // lookup.
    prIdx: index("review_jobs_pr_idx").on(
      t.workspaceId,
      t.repo,
      t.prNumber
    ),
  })
);

export type ReviewJobRow = typeof reviewJobs.$inferSelect;
