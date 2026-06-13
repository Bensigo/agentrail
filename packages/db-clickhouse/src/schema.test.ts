import { describe, it, expect } from "vitest";
import {
  ALTER_FAILURE_EVENTS_ADD_FINGERPRINT,
  ALTER_FAILURE_EVENTS_ADD_NORMALIZED_ERROR,
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
