// AC5 — the standup's DB access path is READ-ONLY: no write-capable connection
// is even constructed, and the module exposes no write helper.
//
// Two complementary proofs:
//   1. STATIC: the standup DB module imports no write-capable client eagerly and
//      exposes only SELECT-shaped helpers (fetchRuns/fetchQueueEntries/close).
//      No insert/update/delete helper exists to call.
//   2. DYNAMIC (faithful fake): a fake `sqlFactory` records the options the
//      client is constructed with and every SQL statement run through it. The
//      test asserts the connection pins `default_transaction_read_only: "on"`
//      AND that every query runs inside a `SET TRANSACTION READ ONLY` block —
//      the same read-only guard a real Postgres server would enforce. A stray
//      INSERT/UPDATE/DELETE has nowhere to originate because no such helper is
//      returned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  openReadOnlyDb,
  runsSelectSql,
  queueEntriesSelectSql,
  RUNS_SELECT_COLUMNS,
  QUEUE_SELECT_COLUMNS,
} from "../agent/lib/standup.db.mjs";

const dbModulePath = fileURLToPath(new URL("../agent/lib/standup.db.mjs", import.meta.url));

// ── (1) STATIC proofs ────────────────────────────────────────────────────────

test("AC5: standup.db.mjs constructs no write-capable connection eagerly", () => {
  const src = readFileSync(dbModulePath, "utf8");
  // The `postgres` driver is imported lazily INSIDE openReadOnlyDb, never at
  // module top-level — importing the module for its pure helpers touches no DB.
  assert.ok(
    !/^\s*import\s+.*from\s+["']postgres["']/m.test(src),
    "postgres must not be imported at module top-level (lazy import only)",
  );
  assert.match(src, /await import\(["']postgres["']\)/, "expected a lazy dynamic import of postgres");
});

test("AC5: the DB module builds no write SQL (no INSERT/UPDATE/DELETE text)", () => {
  const src = readFileSync(dbModulePath, "utf8");
  assert.ok(
    !/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(src),
    "the read-only DB edge must contain no write SQL",
  );
});

test("AC5: SELECT SQL selects no error/reason column and interpolates no user input", () => {
  // The selected columns are exactly the schema-backed set — no error/reason.
  for (const cols of [RUNS_SELECT_COLUMNS, QUEUE_SELECT_COLUMNS]) {
    for (const c of cols) {
      assert.ok(!/error|reason|log|failure/i.test(c), `unexpected column ${c}`);
    }
  }
  const runsSql = runsSelectSql(10);
  const queueSql = queueEntriesSelectSql(10);
  assert.match(runsSql, /^SELECT .* FROM runs /);
  assert.match(queueSql, /^SELECT .* FROM queue_entries /);
  // Only the numeric limit is templated; the limit is coerced to a Number.
  assert.match(runsSql, /LIMIT 10$/);
  assert.match(runsSelectSql("7; DROP TABLE runs"), /LIMIT 500$/); // non-numeric → default
});

// ── (2) DYNAMIC proof with a faithful fake sqlFactory ────────────────────────

// A fake that mimics the `postgres` client surface the module actually uses:
// it is called as sql(url, options), exposes `begin(cb)` (running cb with a tx),
// the tx exposes `unsafe(text)` (returning fake rows), and `end()`.
function makeFakeSql({ rowsByTable = {} } = {}) {
  const record = { constructedWith: null, statements: [], ended: false };
  const tx = {
    async unsafe(text) {
      record.statements.push(text);
      if (/FROM runs\b/i.test(text)) return rowsByTable.runs ?? [];
      if (/FROM queue_entries\b/i.test(text)) return rowsByTable.queue_entries ?? [];
      return [];
    },
  };
  const sql = {
    async begin(cb) {
      return cb(tx);
    },
    async end() {
      record.ended = true;
    },
  };
  const factory = (url, options) => {
    record.constructedWith = { url, options };
    return sql;
  };
  return { factory, record };
}

test("AC5: openReadOnlyDb pins the session read-only and wraps queries in READ ONLY txns", async () => {
  const { factory, record } = makeFakeSql({
    rowsByTable: {
      runs: [{ id: "r1", status: "failed", cost_usd: 2, pr_url: "", title: "t", branch: "b", agent: "opus", created_at: "c" }],
      queue_entries: [{ id: "q1", state: "escalated-to-human", title: "Q", external_id: "#1", tier: 1 }],
    },
  });

  const db = await openReadOnlyDb({ databaseUrl: "postgres://x", sqlFactory: factory });

  // The connection is constructed with the read-only session default.
  assert.equal(record.constructedWith.options.connection.default_transaction_read_only, "on");

  const runs = await db.fetchRuns(50);
  const queue = await db.fetchQueueEntries(50);

  // Rows were mapped snake_case → camelCase (proves the SELECT path ran).
  assert.equal(runs[0].costUsd, 2);
  assert.equal(queue[0].state, "escalated-to-human");
  assert.equal(queue[0].externalId, "#1");

  // Every fetch opened a READ ONLY transaction before selecting.
  const setReadOnly = record.statements.filter((s) => /SET TRANSACTION READ ONLY/i.test(s));
  const selects = record.statements.filter((s) => /^SELECT /i.test(s.trim()));
  assert.equal(setReadOnly.length, selects.length, "each SELECT must run inside a READ ONLY txn");
  assert.ok(selects.length >= 2, "expected at least the runs + queue selects");
  // No write statement ever reached the fake.
  assert.ok(
    !record.statements.some((s) => /\b(INSERT|UPDATE|DELETE)\b/i.test(s)),
    `a write statement was issued: ${record.statements.join(" | ")}`,
  );

  await db.close();
  assert.equal(record.ended, true);
});

test("AC5: openReadOnlyDb exposes ONLY read helpers (no write method reachable)", async () => {
  const { factory } = makeFakeSql();
  const db = await openReadOnlyDb({ databaseUrl: "postgres://x", sqlFactory: factory });
  assert.deepEqual(Object.keys(db).sort(), ["close", "fetchQueueEntries", "fetchRuns"]);
  // There is no insert/update/delete/write/query-raw escape hatch.
  for (const forbidden of ["insert", "update", "delete", "write", "unsafe", "raw", "query", "sql"]) {
    assert.equal(typeof db[forbidden], "undefined", `db must not expose a ${forbidden}() method`);
  }
});
