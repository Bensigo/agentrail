/**
 * Shared state vocabulary for the console's Work surface (#1231). This is the
 * ONE pure, unit-tested mapping function the redesign spec calls for
 * (`docs/superpowers/specs/2026-07-09-console-fractional-engineer-redesign.md`
 * §3): every render path that shows queue state — the Work page, the state
 * chip, and (later) digest copy on Home — imports from here instead of
 * inventing its own label/color.
 *
 * This module also carries the durable-queue projection (`mapQueueEntryRows`)
 * that used to live in a page component (`queue/components/queue-helpers.ts`)
 * and was imported by the API route across a page-directory boundary
 * (`api/v1/workspaces/[workspaceId]/queue/route.ts`). It now lives in a
 * shared lib so the route no longer reaches into `app/(dashboard)/...`.
 *
 * Two vocabularies live side by side on purpose:
 *  - {@link queueStateLabel} — the technical label (CONTEXT.md wording:
 *    "Escalated to human", "Parked", …), used on engine-room evidence pages
 *    that keep operator depth.
 *  - {@link workStateLabel} — the user-facing, employer-of-an-engineer label
 *    from spec §3 ("Needs you", "Blocked", …), used on the Work page and the
 *    Home digest. User-facing copy never says `queue_entry`, `tier`, or
 *    `remaining_budget` (house rule + spec §3).
 */

// ---------------------------------------------------------------------------
// Queue state (technical vocabulary + durable-queue projection)
// ---------------------------------------------------------------------------

/** Default per-issue budget, matching `queue_state.QueueEntry.remaining_budget`. */
export const DEFAULT_BUDGET = 2;

/** Non-terminal lifecycle states + the three Run Outcome terminals. */
export type QueueState =
  | "queued"
  | "parked"
  | "running"
  | "green"
  | "escalated-to-human"
  | "blocked";

/**
 * The states an issue occupies while it is *still in the queue*. Terminals
 * (green / escalated-to-human / blocked) have, by definition, left the queue —
 * they live in Runs/history. The queue surface reads only these, so it
 * self-flushes: an entry drops out the instant it reaches a terminal, with no
 * cleanup job to run. `parked` is in-queue (waiting on a dependency), not done.
 */
export const ACTIVE_QUEUE_STATES = [
  "queued",
  "parked",
  "running",
] as const satisfies readonly QueueState[];

/** The two model tiers from `queue_state.Tier` (cheap → strong). */
export type QueueTier = "cheap" | "strong";

/** A run row as the queue projection needs it (subset of the runs read model). */
export interface QueueRunInput {
  id: string;
  branch: string;
  title: string | null;
  agent: string;
  status: string;
  createdAt: string;
}

/** One projected Issue Queue entry for display. */
export interface QueueEntryView {
  /** Durable `queue_entries.id`, which the runner also uses as the `runs.id`
   * (see `claimQueueEntry` in `packages/db-postgres/src/queries/runner.ts`) —
   * so a Work item links straight to `/runs/{id}` with no extra lookup. */
  id: string;
  issueKey: string;
  title: string | null;
  agent: string;
  tier: QueueTier;
  remainingBudget: number;
  state: QueueState;
  attempts: number;
  failedAttempts: number;
  updatedAt: string;
  /** Issue numbers this entry is blocked by (parked only); empty otherwise. */
  blockedBy: number[];
}

/** Run statuses that count as a failed attempt (consume one budget unit). */
const FAILED_STATUSES = new Set(["failed", "error"]);

/**
 * Resolve an issue's queue state from its runs' statuses (in any order).
 * Pure and total: an unknown status is treated as not-yet-resolved (`queued`).
 */
export function resolveQueueState(statuses: string[]): QueueState {
  if (statuses.some((s) => s === "success")) return "green";
  if (statuses.some((s) => s === "running")) return "running";
  const failed = statuses.filter((s) => FAILED_STATUSES.has(s)).length;
  // Budget exhausted with no success and nothing in flight → hard stop.
  if (failed > 0 && failed >= DEFAULT_BUDGET) return "escalated-to-human";
  return "queued";
}

/** Tier follows escalation: first attempt cheap; any retry means strong. */
function resolveTier(attempts: number): QueueTier {
  return attempts > 1 ? "strong" : "cheap";
}

/** Group runs by branch (= one issue) and project each into a queue entry. */
export function projectQueueEntries(runs: QueueRunInput[]): QueueEntryView[] {
  const byBranch = new Map<string, QueueRunInput[]>();
  for (const run of runs) {
    const key = run.branch || run.id;
    const group = byBranch.get(key) ?? [];
    group.push(run);
    byBranch.set(key, group);
  }

  const entries: QueueEntryView[] = [];
  for (const [issueKey, group] of byBranch) {
    const statuses = group.map((r) => r.status);
    const failedAttempts = statuses.filter((s) => FAILED_STATUSES.has(s)).length;
    const attempts = group.length;
    const latest = group.reduce((a, b) =>
      a.createdAt >= b.createdAt ? a : b
    );
    entries.push({
      id: latest.id,
      issueKey,
      title: latest.title,
      agent: latest.agent,
      tier: resolveTier(attempts),
      remainingBudget: Math.max(DEFAULT_BUDGET - failedAttempts, 0),
      state: resolveQueueState(statuses),
      attempts,
      failedAttempts,
      updatedAt: latest.createdAt,
      blockedBy: [],
    });
  }
  // Most-recently-active issue first (time is the primary axis, TASTE.md).
  entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return entries;
}

/** Technical, CONTEXT.md-wording label for a queue state — used on engine-room
 * evidence pages that keep operator depth. For user-facing copy (Work page,
 * Home digest) use {@link workStateLabel} instead. */
export function queueStateLabel(state: QueueState): string {
  switch (state) {
    case "green":
      return "Green";
    case "escalated-to-human":
      return "Escalated to human";
    case "blocked":
      return "Blocked";
    case "running":
      return "Running";
    case "parked":
      return "Parked";
    case "queued":
    default:
      return "Queued";
  }
}

// ---------------------------------------------------------------------------
// Durable-queue projection (preferred): map authoritative `queue_entries` rows
// straight to view entries. Unlike the runs-history projection above, this
// cannot accumulate phantom-queued entries — the state column IS the truth, and
// the read query excludes terminals, so the queue reflects only pending work.
// ---------------------------------------------------------------------------

/** A `queue_entries` row as the view needs it (subset of the durable schema). */
export interface QueueEntryRow {
  id: string;
  externalId: string;
  title: string;
  /** queue_state.Tier: 0 = cheap, 1 = strong. */
  tier: number;
  remainingBudget: number;
  /** queue_state vocabulary: queued|parked|running + terminals. */
  state: string;
  /** Issue numbers this entry is blocked by (parked while any is unmet). The
   * only DURABLE park reason: guardrail park reasons (duplicate content /
   * rate limit / injection) ride on the enqueue response only and are never
   * persisted — the schema has no reason column (see
   * `packages/db-postgres/src/queries/github_intake.ts`) — so they cannot be
   * reconstructed on a later read. */
  blockedBy?: number[];
  updatedAt: string;
}

/** queue_entries `tier` integer → the view's tier label. */
function tierLabel(tier: number): QueueTier {
  return tier >= 1 ? "strong" : "cheap";
}

/** Coerce a raw state string to a known QueueState (unknown → `queued`). */
function asQueueState(state: string): QueueState {
  switch (state) {
    case "queued":
    case "parked":
    case "running":
    case "green":
    case "escalated-to-human":
    case "blocked":
      return state;
    default:
      return "queued";
  }
}

/**
 * Project authoritative `queue_entries` rows into view entries. Pure: tier and
 * state come straight from the row (the state machine already decided them);
 * failed attempts are inferred from the consumed budget. Most-recently-updated
 * first, matching the runs projection's ordering.
 */
export function mapQueueEntryRows(rows: QueueEntryRow[]): QueueEntryView[] {
  const entries = rows.map((row) => {
    const failedAttempts = Math.max(DEFAULT_BUDGET - row.remainingBudget, 0);
    return {
      id: row.id,
      issueKey: row.externalId,
      title: row.title || null,
      agent: "claude",
      tier: tierLabel(row.tier),
      remainingBudget: row.remainingBudget,
      state: asQueueState(row.state),
      attempts: failedAttempts,
      failedAttempts,
      updatedAt: row.updatedAt,
      blockedBy: row.blockedBy ?? [],
    } satisfies QueueEntryView;
  });
  entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return entries;
}

// ---------------------------------------------------------------------------
// User-facing Work vocabulary (spec §3) — employer-of-an-engineer language.
// ---------------------------------------------------------------------------

/** The five board groups the Work page toggles into (spec §4 "Work"). */
export type WorkGroup =
  | "Assigned"
  | "In progress"
  | "Blocked"
  | "Needs you"
  | "Shipped";

/** Board column order, left to right. */
export const WORK_GROUPS: readonly WorkGroup[] = [
  "Assigned",
  "In progress",
  "Blocked",
  "Needs you",
  "Shipped",
];

/** The spec §3 vocabulary table, verbatim. */
const WORK_STATE_LABEL: Record<QueueState, string> = {
  queued: "Assigned",
  running: "In progress",
  parked: "Blocked",
  green: "Shipped",
  "escalated-to-human": "Needs you",
  blocked: "Blocked",
};

/**
 * User-facing state label per spec §3 — never `queue_entry`, `tier`, or
 * `remaining_budget`. `parked` and `blocked` both read "Blocked"; pair with
 * {@link formatParkReason} to surface the human reason for a parked entry
 * (spec: "Blocked — with the human reason").
 */
export function workStateLabel(state: QueueState): string {
  return WORK_STATE_LABEL[state];
}

/** Maps a queue state to its Work board column. Mirrors {@link workStateLabel}
 * one-for-one except both `parked` and `blocked` land in the "Blocked" column. */
const WORK_GROUP_BY_STATE: Record<QueueState, WorkGroup> = {
  queued: "Assigned",
  running: "In progress",
  parked: "Blocked",
  blocked: "Blocked",
  "escalated-to-human": "Needs you",
  green: "Shipped",
};

export function workGroupFor(state: QueueState): WorkGroup {
  return WORK_GROUP_BY_STATE[state];
}

/**
 * Group work entries into their board columns, preserving each column's
 * existing (most-recently-updated-first) order. Pure — the Work board just
 * renders the result.
 */
export function groupWorkEntries(
  entries: readonly QueueEntryView[]
): Record<WorkGroup, QueueEntryView[]> {
  const groups: Record<WorkGroup, QueueEntryView[]> = {
    Assigned: [],
    "In progress": [],
    Blocked: [],
    "Needs you": [],
    Shipped: [],
  };
  for (const entry of entries) {
    groups[workGroupFor(entry.state)].push(entry);
  }
  return groups;
}

/**
 * Human-readable park reason from a parked entry's unmet blockers
 * (`queue_entries.blockedBy`). This is the only reason that survives a later
 * read: guardrail park reasons (duplicate content / rate limit / injection
 * screen) are returned once on the enqueue response and never persisted (no
 * `reason` column on `queue_entries` — see `github_intake.ts`), so a page
 * rendered from a durable read can never recover them. Returns `undefined`
 * when there is nothing to report (not parked on a dependency, or an
 * ephemeral guardrail park with no recorded blocker).
 */
export function formatParkReason(blockedBy: number[] | undefined): string | undefined {
  if (!blockedBy || blockedBy.length === 0) return undefined;
  const refs = blockedBy.map((n) => `#${n}`);
  if (refs.length === 1) return `Blocked by ${refs[0]}`;
  if (refs.length === 2) return `Blocked by ${refs[0]} and ${refs[1]}`;
  const head = refs.slice(0, -1).join(", ");
  const tail = refs[refs.length - 1];
  return `Blocked by ${head}, and ${tail}`;
}

/**
 * Chip color classes per state — carried over byte-for-byte from the original
 * queue badge (`queue/components/queue-state-badge.tsx`) so the visual system
 * doesn't drift. TASTE.md severity mapping: green=passed, orange=running,
 * red=escalated, yellow=blocked (terminal), blue=parked (still queued,
 * waiting on a dependency), gray=queued/inactive.
 */
export const WORK_STATE_CHIP_CLASSNAME: Record<QueueState, string> = {
  green: "bg-[#29a383]/20 text-[#1fd8a4] border border-[#29a383]/30",
  running: "bg-[#f76b15]/20 text-[#ffa057] border border-[#f76b15]/30",
  "escalated-to-human": "bg-[#e5484d]/20 text-[#ff9592] border border-[#e5484d]/30",
  blocked: "bg-[#ffe629]/15 text-[#f5e147] border border-[#ffe629]/30",
  parked: "bg-[#3b82f6]/15 text-[#7cc0ff] border border-[#3b82f6]/30",
  queued: "bg-[var(--gray-04)] text-[var(--gray-10)] border border-[var(--gray-06)]",
};
