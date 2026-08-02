import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * The boot plane's dedicated queue (B2b Task 1, plan
 * docs/superpowers/plans/2026-08-02-b2b-sandbox-boot.md; spec
 * docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md §B2b
 * §4-5). Gives a PR head with no preview URL something to browse: a
 * dedicated out-of-process worker (Task 7) clones the head, boots it as a
 * supervised child process, health-checks it, and reports a private URL
 * back through this table. This table has no consumers yet — the
 * claim/report query layer lands in Task 2.
 *
 * DELIBERATELY NOT `queue_entries` (the plan's "topology ruling"): the
 * generic queue hardcodes `ref='main'` (`queries/runner.ts`'s
 * `claimQueueEntry`), is terminal-only (`green|red|error|running`), and its
 * `green` path attempts a PR squash-merge — none of which fit a PR head
 * that only needs to boot, serve, and unconditionally tear down. This
 * table, and every route/query touching it, is a fully separate, isolated
 * plane — the same reasoning `review_jobs.ts` already used to justify not
 * reusing `queue_entries` for a differently-shaped job.
 *
 * `id` is CALLER-SUPPLIED: a deterministic uuid5 of `(workspaceId, repo,
 * prNumber, headSha)`, computed in the query layer (Task 2's
 * `previewBootId`) the same way `review_jobs.ts`'s `reviewJobId` derives
 * its id. Deliberately NO default here — neither `defaultRandom()` nor SQL
 * `gen_random_uuid()` — because a replayed/duplicate boot request must hit
 * `ON CONFLICT (id) DO NOTHING` and dedupe, never silently mint a second
 * row for the same logical (workspace, repo, pr, head): a caller that
 * forgot to compute the deterministic id should hit a NOT NULL violation,
 * never get a fresh random id that masks the bug and double-admits the row.
 *
 * `status` lifecycle: `pending` -> `claimed` -> `booting` -> `ready`, plus
 * terminal `failed` (no recipe / boot error / stale liveness) and
 * `torn_down` (TTL expiry, or superseded by a newer push on the same PR).
 * Plain `text` with a `.default`, NOT a pg enum — mirrors
 * `review_jobs.state`'s own idiom exactly.
 */
export const previewBoots = pgTable(
  "preview_boots",
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
    // The clone target handed to the boot lifecycle's `clone_pr_head` — the
    // head SHA, or `refs/pull/<n>/head`; the request route (Task 3) decides
    // which. Kept separate from head_sha because a fork PR's head cannot be
    // fetched with `--branch <sha>` and needs the ref form instead.
    ref: text("ref").notNull(),
    // pending|claimed|booting|ready|failed|torn_down — see lifecycle note
    // above.
    status: text("status").notNull().default("pending"),
    // Worker identity, set at claim time; null while pending.
    workerId: text("worker_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    // Set once the boot reports 'ready'; both null before that.
    url: text("url"),
    port: integer("port"),
    // Failure or teardown reason — set on 'failed'/'torn_down', never
    // silent (mirrors review_jobs.skipReason's "never silent" rule).
    reason: text("reason"),
    // Bumped on a stale re-claim; mirrors review_jobs.attempts.
    attempts: integer("attempts").notNull().default(0),
    // Set at claim time to now() + the worker's TTL. The sweep
    // (Task 2's expireStalePreviewBoots) uses this alongside
    // last_liveness_at to fail an abandoned boot.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Bumped by the worker's periodic 'ready' re-report while supervising —
    // proves the boot (and its worker) are still alive between the initial
    // ready and the eventual TTL teardown.
    lastLivenessAt: timestamp("last_liveness_at", { withTimezone: true }),
    // Requeue backoff, mirrors review_jobs.nextEligibleAt. NULL = eligible
    // now.
    nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // The claim query's hot path: oldest-first among still-pending rows.
    // Partial so a table dominated by terminal rows (ready/failed/
    // torn_down) never bloats the index the claim SQL actually scans —
    // mirrors review_jobs_queued_idx's own partial-index rationale.
    pendingIdx: index("preview_boots_pending_idx")
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    // Per-PR lookup — the supersede-on-insert path (a newer push tears
    // down this PR's older, still-in-flight boot) and any per-PR history
    // query.
    prIdx: index("preview_boots_pr_idx").on(
      t.workspaceId,
      t.repo,
      t.prNumber
    ),
  })
);

export type PreviewBootRow = typeof previewBoots.$inferSelect;
