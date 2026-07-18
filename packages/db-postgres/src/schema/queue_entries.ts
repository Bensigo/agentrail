import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  pgEnum,
  numeric,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * Where a queue entry was sourced from. Mirrors the Python store's `source`
 * field ('cli' | 'github' | 'linear').
 */
export const queueSourceEnum = pgEnum("queue_source", [
  "cli",
  "github",
  "linear",
]);

/**
 * Issue #1240: the starting `remaining_budget` a GitHub-issue queue entry is
 * seeded with (`github_intake.ts::enqueueGithubIssue` passes this explicitly on
 * insert, overriding the column default below). This is the ONE place that
 * number is declared; both the column default and the console read model
 * (`apps/console/lib/work-vocabulary.ts::mapQueueEntryRows`, which infers
 * `failedAttempts` as `QUEUE_ENTRY_DEFAULT_BUDGET - remainingBudget`) import it
 * from here so they cannot drift apart again.
 *
 * Note: `enqueueOnboard` seeds a DIFFERENT starting budget (3) for onboard-kind
 * entries — this constant does not apply to those rows; see the `attempts`
 * accuracy caveat on `mapQueueEntryRows`.
 */
export const QUEUE_ENTRY_DEFAULT_BUDGET = 5;

/**
 * Durable Issue Queue.
 *
 * Today the console "queue" is just `runs` grouped by branch; there is no
 * durable queue, so close-laptop-and-resume cannot work. This table is the real
 * backbone: every admitted issue (one that passed the input-contract gate) is
 * persisted here carrying the pure state-machine's tier / remaining_budget /
 * state, so it survives a process restart. The Python persistence edge is
 * `agentrail/afk/queue_store.py`; the pure decisions live in
 * `agentrail/afk/queue_state.py`.
 */
export const queueEntries = pgTable("queue_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  source: queueSourceEnum("source").notNull(),
  // What kind of work this entry represents: 'issue' (default — run the SDLC
  // spine against a GitHub/CLI issue) or 'onboard' (index a freshly connected
  // repo and seed workspace memory). Additive + backward-compatible: existing
  // rows and any claim payload that omits it default to 'issue', so old runners
  // and old servers keep working unchanged.
  kind: text("kind").notNull().default("issue"),
  // GH issue number/url, Linear id, or a cli-local id.
  externalId: text("external_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  // queue_state.Tier (0 = CHEAP, 1 = STRONG).
  tier: integer("tier").notNull().default(0),
  // Seeds the bounded retry budget: one unit is spent per red/error attempt
  // (see recordRunnerResult / nextQueueTransition), so this is the max number of
  // attempts before an entry escalates to a human. 5 ⇒ "retry on error max 5
  // times" (#890).
  remainingBudget: integer("remaining_budget")
    .notNull()
    .default(QUEUE_ENTRY_DEFAULT_BUDGET),
  // QueueState ('queued'|'parked'|'running') or Terminal
  // ('green'|'escalated-to-human'|'blocked').
  state: text("state").notNull().default("queued"),
  // Issue numbers this entry is blocked by (parked while any is unmet).
  blockedBy: jsonb("blocked_by").$type<number[]>().notNull().default([]),
  // Human-readable reason the entry is CURRENTLY parked (issue #1239): a
  // guardrail park (duplicate content / rate limit / injection screen) or an
  // unmet blocked-by dependency ("Waiting on #12, #14"). Nullable — null for a
  // non-parked entry, and for a legacy row written before this column existed.
  // Every code path that transitions an entry INTO 'parked' sets it; every
  // transition OUT clears it back to null (see `github_intake.ts` and the
  // Python persistence edge `agentrail/afk/queue_store.py`).
  parkReason: text("park_reason"),
  // #1275 (estimate→enforcement threading): the alignment brief's confirmed
  // per-issue cost estimate. Owner rule (2026-07-18): "confirming the brief =
  // sanctioning the ceiling" — when present, this dollar figure IS the run's
  // enforced budget and WINS over every other tier the runner would otherwise
  // apply (--budget-usd flag / .agentrail/config.json / the product default —
  // see agentrail.cli.commands.run.effective_budget and
  // agentrail/run/budget_leash.py). NULL = no brief has priced this entry yet
  // (true for every row today — #1274's brief-generation lane is what starts
  // writing a value here; this column is dormant until then, and stays NULL
  // forever for kind='onboard' rows by design). Numeric mode "number" mirrors
  // workspaces.monthlyBudgetUsd's own dollar-figure convention.
  estimatedBudgetUsd: numeric("estimated_budget_usd", {
    precision: 10,
    scale: 2,
    mode: "number",
  }),
  // #1275: the coding-phase model the user chose when confirming the
  // alignment brief (task-type-suggested by default; this records an
  // explicit override only). Consulted ONLY for the execute/test-author
  // phase — per-phase planner/reviewer seats are untouched, protecting
  // #1270's independent-review guarantee. NULL = no brief/no override (true
  // for every row today). See agentrail/cli/commands/runner.py::_make_execute
  // for the precedence this loses to: a tier >= 1 escalation (a re-queued
  // attempt retrying a PREVIOUS gate-red/error result, #890) always wins over
  // this value — the override already failed once at tier 0, so re-running
  // the same user pick would burn the bounded retry budget instead of ever
  // reaching the stronger escalation model.
  modelOverride: text("model_override"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
