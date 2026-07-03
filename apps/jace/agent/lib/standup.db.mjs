// READ-ONLY database edge for Jace's standup skill.
//
// AC5: all database access in the standup path is read-only — no write-capable
// connection is even constructed. This module is the ONLY place the standup
// touches Postgres, and it is deliberately narrow:
//
//   1. The connection is opened with a hard read-only guard: the Postgres
//      session is pinned to `default_transaction_read_only = on` via the
//      driver's per-connection `onnotice`/`connection` options, AND every query
//      this module runs is wrapped in a `BEGIN TRANSACTION READ ONLY … COMMIT`.
//      A stray INSERT/UPDATE/DELETE would be rejected by Postgres itself
//      ("cannot execute … in a read-only transaction"), not merely by
//      convention.
//   2. This module exposes ONLY SELECT helpers (fetchRuns, fetchQueueEntries).
//      There is no insert/update/delete helper and no way to obtain the raw
//      write-capable client from outside — the client is a module-private
//      closure. The standup core (standup.core.mjs) receives already-fetched
//      rows and never sees a connection at all.
//
// The `postgres` import is lazy (inside openReadOnlyDb) so importing this module
// for its pure argv/SQL helpers — or for the AC5 static assertions — does not
// require the driver to be installed or a DATABASE_URL to be set.

/** Column list the standup selects from `runs` (schema-backed; see runs.ts). */
export const RUNS_SELECT_COLUMNS = Object.freeze([
  "id",
  "status",
  "cost_usd",
  "pr_url",
  "title",
  "branch",
  "agent",
  "created_at",
]);

/** Column list the standup selects from `queue_entries` (schema-backed). */
export const QUEUE_SELECT_COLUMNS = Object.freeze([
  "id",
  "state",
  "title",
  "external_id",
  "tier",
]);

/**
 * Build the read-only SELECT text for the `runs` snapshot. Note there is NO
 * error/reason column selected — that column does not exist (AC1/AC2).
 * @param {number} [limit]
 * @returns {string}
 */
export function runsSelectSql(limit = 500) {
  const cols = RUNS_SELECT_COLUMNS.join(", ");
  return `SELECT ${cols} FROM runs ORDER BY created_at DESC LIMIT ${Number(limit) || 500}`;
}

/**
 * Build the read-only SELECT text for the `queue_entries` snapshot.
 * @param {number} [limit]
 * @returns {string}
 */
export function queueEntriesSelectSql(limit = 500) {
  const cols = QUEUE_SELECT_COLUMNS.join(", ");
  return `SELECT ${cols} FROM queue_entries ORDER BY updated_at DESC LIMIT ${Number(limit) || 500}`;
}

/**
 * Map a snake_case `runs` row (as returned by the driver) to the camelCase
 * shape standup.core.mjs expects. Pure.
 * @param {Record<string, unknown>} row
 */
export function mapRunRow(row = {}) {
  return {
    id: row.id,
    status: row.status,
    costUsd: row.cost_usd,
    prUrl: row.pr_url,
    title: row.title,
    branch: row.branch,
    agent: row.agent,
    createdAt: row.created_at,
  };
}

/**
 * Map a snake_case `queue_entries` row to the camelCase shape.
 * @param {Record<string, unknown>} row
 */
export function mapQueueRow(row = {}) {
  return {
    id: row.id,
    state: row.state,
    title: row.title,
    externalId: row.external_id,
    tier: row.tier,
  };
}

/**
 * Open a READ-ONLY Postgres handle and return only SELECT helpers plus a
 * `close()`. The raw client never escapes this closure, and every statement runs
 * inside a `READ ONLY` transaction, so no caller can write through it (AC5).
 *
 * `sqlFactory` is injected for testability: in production it defaults to the
 * `postgres` driver (lazy-imported); tests pass a fake that records the options
 * it was constructed with and the SQL it was asked to run, so AC5 can assert the
 * read-only guard without a real database.
 *
 * @param {object} [opts]
 * @param {string} [opts.databaseUrl] defaults to env DATABASE_URL
 * @param {(url: string, options: object) => any} [opts.sqlFactory] injected postgres()
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {Promise<{
 *   fetchRuns: (limit?: number) => Promise<Array<object>>,
 *   fetchQueueEntries: (limit?: number) => Promise<Array<object>>,
 *   close: () => Promise<void>,
 * }>}
 */
export async function openReadOnlyDb({
  databaseUrl,
  sqlFactory,
  env = process.env,
} = {}) {
  const url =
    databaseUrl ||
    env.DATABASE_URL ||
    "postgres://agentrail:agentrail@localhost:5432/agentrail";

  /** @type {((url: string, options: object) => any) | undefined} */
  let factory = sqlFactory;
  if (!factory) {
    // Lazy import so the pure helpers above are usable without the driver.
    // `postgres` is a transitive dependency (via @workflow/world-postgres) and
    // is not resolvable at typecheck time; the import is intentionally dynamic.
    // @ts-ignore -- optional lazy driver import, resolved at runtime only
    const mod = await import("postgres");
    factory = mod.default ?? mod;
  }
  if (typeof factory !== "function") {
    throw new Error("openReadOnlyDb: no usable postgres factory available.");
  }

  // Pin the SESSION to read-only at connect time. `postgres` runs the strings in
  // `connection.options`/`prepare` hooks; the belt-and-suspenders is that every
  // query below ALSO opens a `READ ONLY` transaction.
  const sql = factory(url, {
    max: 1,
    // Force the session default so even an accidental autocommit write is
    // rejected by the server.
    connection: { default_transaction_read_only: "on" },
    // We never need prepared writes; keep the surface minimal.
    prepare: false,
  });

  /**
   * Run one SELECT inside an explicit read-only transaction. `sql.unsafe` is
   * used ONLY for the fixed, parameterless SELECT strings built above (no user
   * input is ever interpolated), so there is no injection surface.
   * @param {string} selectText
   */
  async function readOnly(selectText) {
    // begin() runs the callback inside a transaction; we set it READ ONLY first.
    return sql.begin(async (/** @type {any} */ tx) => {
      await tx.unsafe("SET TRANSACTION READ ONLY");
      return tx.unsafe(selectText);
    });
  }

  return {
    async fetchRuns(limit = 500) {
      const rows = await readOnly(runsSelectSql(limit));
      return Array.from(rows, mapRunRow);
    },
    async fetchQueueEntries(limit = 500) {
      const rows = await readOnly(queueEntriesSelectSql(limit));
      return Array.from(rows, mapQueueRow);
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
