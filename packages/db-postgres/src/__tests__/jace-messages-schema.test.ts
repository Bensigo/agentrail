import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { jaceMessages } from "../schema/jace_messages.js";

/**
 * #1288 PR① — console chat's single conversational seam. Mirrors
 * `workspace-grant-events-schema.test.ts`'s idiom (assert against the schema
 * OBJECT directly via `getTableConfig`, no live-DB harness — see
 * `run_outcomes.test.ts`'s own note that this package has none).
 */
describe("jace_messages schema (#1288)", () => {
  it("workspace_id is NOT NULL and CASCADEs on workspace delete", () => {
    expect(jaceMessages.workspaceId.notNull).toBe(true);
    const config = getTableConfig(jaceMessages);
    const fk = config.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === "workspace_id")
    );
    expect(fk).toBeDefined();
    expect(fk!.onDelete).toBe("cascade");
  });

  it("conversation_key, role, text are all NOT NULL", () => {
    expect(jaceMessages.conversationKey.notNull).toBe(true);
    expect(jaceMessages.role.notNull).toBe(true);
    expect(jaceMessages.text.notNull).toBe(true);
  });

  it("created_at defaults to now() and is NOT NULL", () => {
    expect(jaceMessages.createdAt.notNull).toBe(true);
    expect(jaceMessages.createdAt.hasDefault).toBe(true);
  });

  it("seq is a NOT NULL auto-incrementing polling cursor", () => {
    expect(jaceMessages.seq.notNull).toBe(true);
    expect(jaceMessages.seq.hasDefault).toBe(true);
  });

  it("carries a workspace+conversation+seq index — the one access pattern this table serves", () => {
    const config = getTableConfig(jaceMessages);
    const idx = config.indexes.find(
      (i) => i.config.name === "jace_messages_workspace_conversation_seq_idx"
    );
    expect(idx).toBeDefined();
    const columnNames = idx!.config.columns.map(
      (c) => (c as { name?: string }).name
    );
    expect(columnNames).toEqual(["workspace_id", "conversation_key", "seq"]);
  });

  it("carries a CHECK constraining role to 'user' | 'jace'", () => {
    const config = getTableConfig(jaceMessages);
    const check = config.checks.find(
      (c) => c.name === "jace_messages_role_check"
    );
    expect(check).toBeDefined();
  });
});
