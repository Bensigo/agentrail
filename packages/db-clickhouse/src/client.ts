import { createClient } from "@clickhouse/client";

const url =
  process.env.CLICKHOUSE_URL ??
  "http://agentrail:agentrail@localhost:8123/agentrail";

export const clickhouse = createClient({ url });
