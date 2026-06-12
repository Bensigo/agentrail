import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema/index.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://agentrail:agentrail@localhost:5432/agentrail";

// Next.js dev hot-reload re-evaluates this module, and each evaluation used to
// open a fresh pool (10 connections each) without closing the old one — after
// enough reloads Postgres hits max_connections and everything (auth included)
// fails. Cache the client on globalThis outside production so reloads reuse it.
const globalForDb = globalThis as unknown as {
  __agentrailPgClient?: ReturnType<typeof postgres>;
};

const client =
  globalForDb.__agentrailPgClient ?? postgres(DATABASE_URL, { max: 10 });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__agentrailPgClient = client;
}

export const db = drizzle(client, { schema });

export type Db = typeof db;
