import { sql } from "drizzle-orm";
import type { Db } from "../db.js";

/**
 * Billing-account-wide task-capacity count (spec
 * docs/superpowers/specs/2026-07-29-subscription-platform-design.md §6
 * "Enforcement seams" point 2, the capacity gate; §9's exact v1 rule: "one
 * capacity unit per admitted run"). `db` is an explicit parameter and this
 * is raw `db.execute(sql\`...\`)` — the same `seats.ts`/`billing_accounts.ts`
 * convention (see either module's own top doc-comment for the full "why an
 * explicit param, why raw SQL" rationale): this package has no live-DB test
 * harness, so an explicit parameter lets a test pass a captured-SQL mock
 * straight to the call site with no `vi.mock("../db.js")`.
 *
 * A new file rather than an addition to `workspace_costs.ts`: that module's
 * reads are all WORKSPACE-scoped (issue #1272's per-workspace costs page);
 * this one is ACCOUNT-scoped (an account can span more than one workspace,
 * spec §3), joining OUT to `workspaces` rather than filtering by one
 * `workspace_id` directly — a different shape, not just a different scope.
 */

/**
 * Count of `runs` CLAIMED (not completed) for `billingAccountId`, across
 * EVERY workspace on the account, within `[fromIso, toIso)` — a half-open
 * window so the caller controls both edges explicitly, matching
 * `sumWorkspaceSpendSince`/`listWorkspaceRunCosts`'s own half-open
 * convention (`workspace_costs.ts`).
 *
 * `runs.created_at` IS claim time, not completion time: every writer
 * (`claimQueueEntry`, `runner.ts:723-746`; the heartbeat's `register_run`;
 * the CLI-direct `upsertRun`) inserts its row at the moment a task is
 * admitted to run, and `created_at`'s own `.defaultNow()` (`schema/runs.ts`)
 * stamps it right then — so this counts TASKS STARTED in the window, spec
 * §9's exact v1 capacity rule, not tasks that finished in it. A `running`
 * task that hasn't reported yet is still counted (its row already exists,
 * spend or no spend); a task that was queued but never claimed is not (no
 * `runs` row exists for it yet).
 *
 * Two idioms, both required for this to return real numbers and not throw —
 * see `workspaceMonthlyCostRollup`'s own doc-comment
 * (`workspace_costs.ts:165-192`) for the full story behind both, verified
 * against the real dev DB there, not just mocked unit tests:
 *   1. `::int` cast on `COUNT(*)` — postgres.js (this package's driver)
 *      returns an uncast bigint aggregate as a STRING over the wire; the
 *      explicit `int4` cast is what makes the driver hand back a genuine JS
 *      number instead (same reasoning `countActiveSeats`,
 *      `countActiveIdentitySeats`, and `workspaceMonthlyCostRollup` each
 *      document for their own `COUNT(*)`s).
 *   2. `fromIso`/`toIso` are interpolated as plain ISO strings, NEVER `new
 *      Date(...)` — a raw `Date` object passed into a `db.execute(sql\`...\`)`
 *      template reaches postgres.js's low-level parameter binder
 *      un-serialized and throws `ERR_INVALID_ARG_TYPE`. Postgres implicitly
 *      casts a well-formed ISO string to `timestamptz` when compared against
 *      one, so the plain string is both correct and required here.
 *
 * `runs` carries no `billing_account_id` column of its own — the JOIN
 * through `workspaces.billing_account_id` is what scopes by ACCOUNT rather
 * than by a single workspace.
 */
export async function countAccountRunsStartedInWindow(
  db: Db,
  args: { billingAccountId: string; fromIso: string; toIso: string }
): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM runs r
    JOIN workspaces w ON w.id = r.workspace_id
    WHERE w.billing_account_id = ${args.billingAccountId}
      AND r.created_at >= ${args.fromIso}
      AND r.created_at < ${args.toIso}
  `)) as unknown as Array<{ count: number }>;

  const row = Array.from(rows)[0];
  return Number(row?.count ?? 0);
}
