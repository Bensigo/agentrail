import { describe, it, expect } from "vitest";
import {
  ALTER_COST_EVENTS_ADD_CACHE_CREATION_TOKENS,
  ALTER_COST_EVENTS_ADD_PRICE_SOURCE,
  ALTER_FAILURE_EVENTS_ADD_FINGERPRINT,
  ALTER_FAILURE_EVENTS_ADD_NORMALIZED_ERROR,
  CREATE_AFK_RUN_EVENTS_TABLE,
  CREATE_FAILURE_EVENTS_TABLE,
} from "./schema";

describe("failure_events schema", () => {
  it("creates normalized_error and fingerprint columns for fresh tables", () => {
    expect(CREATE_FAILURE_EVENTS_TABLE).toContain("normalized_error String DEFAULT ''");
    expect(CREATE_FAILURE_EVENTS_TABLE).toContain("fingerprint String DEFAULT ''");
  });

  it("exports idempotent ALTER statements for existing tables", () => {
    expect(ALTER_FAILURE_EVENTS_ADD_NORMALIZED_ERROR).toContain(
      "ALTER TABLE failure_events ADD COLUMN IF NOT EXISTS normalized_error String DEFAULT ''"
    );
    expect(ALTER_FAILURE_EVENTS_ADD_FINGERPRINT).toContain(
      "ALTER TABLE failure_events ADD COLUMN IF NOT EXISTS fingerprint String DEFAULT ''"
    );
  });
});

describe("cost_events cache_creation_tokens migration", () => {
  it("exports an additive idempotent ALTER for cache_creation_tokens", () => {
    expect(ALTER_COST_EVENTS_ADD_CACHE_CREATION_TOKENS).toContain(
      "ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS cache_creation_tokens UInt64 DEFAULT 0"
    );
  });
});

describe("cost_events price_source migration (#1337 PR②)", () => {
  it("exports an additive idempotent ALTER for price_source (String DEFAULT '')", () => {
    expect(ALTER_COST_EVENTS_ADD_PRICE_SOURCE).toContain(
      "ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS price_source String DEFAULT ''"
    );
  });
});

describe("afk_run_events schema", () => {
  it("partitions by workspace and month, and deduplicates by run timestamp slot", () => {
    expect(CREATE_AFK_RUN_EVENTS_TABLE).toContain("ENGINE = ReplacingMergeTree()");
    expect(CREATE_AFK_RUN_EVENTS_TABLE).toContain("PARTITION BY (workspace_id, toYYYYMM(ts))");
    expect(CREATE_AFK_RUN_EVENTS_TABLE).toContain("ORDER BY (run_id, ts, slot)");
  });
});
