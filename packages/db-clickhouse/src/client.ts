import { createClient } from "@clickhouse/client";

const url = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";
const username = process.env.CLICKHOUSE_USER ?? "agentrail";
const password = process.env.CLICKHOUSE_PASSWORD ?? "agentrail";
const database = process.env.CLICKHOUSE_DB ?? "agentrail";

export const client = createClient({
  url,
  username,
  password,
  database,
});
