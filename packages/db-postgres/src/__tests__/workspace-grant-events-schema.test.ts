import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { workspaceGrantEvents } from "../schema/workspace_grant_events.js";

/**
 * #1343 minor (a) / AC2 — `workspace_grant_events.granted_by_user_id` must
 * RESTRICT (not cascade) a user delete, so the merge-permission grant/revoke
 * audit trail survives the granting user being deleted. Mirrors
 * `runs-schema.test.ts`'s idiom (assert against the schema OBJECT directly,
 * no live-DB harness — see `workspace_grants.test.ts`'s own note that this
 * package has none) using `getTableConfig` to read the FK's actual `onDelete`
 * action, since that isn't exposed on the column object itself.
 *
 * The real Postgres-level behavior (a DELETE against `users` genuinely
 * failing with a foreign-key-violation once a grant event references it,
 * migration 0040_grant_events_restrict_user_delete) was verified manually
 * against the local dev Postgres — see the #1343 implementation report; CI's
 * `node` job runs this package's vitest WITHOUT a live Postgres service, so
 * an actual DELETE-and-assert integration test cannot live here.
 */
describe("workspace_grant_events schema — granted_by_user_id FK (#1343 AC2)", () => {
  it("RESTRICTs (not cascades) on a referenced user's delete — audit rows survive", () => {
    const config = getTableConfig(workspaceGrantEvents);
    const fk = config.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === "granted_by_user_id")
    );
    expect(fk).toBeDefined();
    expect(fk!.onDelete).toBe("restrict");
  });

  it("workspace_id still cascades — only the audit ACTOR reference changed, not the workspace scoping", () => {
    const config = getTableConfig(workspaceGrantEvents);
    const fk = config.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === "workspace_id")
    );
    expect(fk).toBeDefined();
    expect(fk!.onDelete).toBe("cascade");
  });

  it("granted_by_user_id stays NOT NULL — RESTRICT (not SET NULL) preserves full attribution", () => {
    expect(workspaceGrantEvents.grantedByUserId.notNull).toBe(true);
  });
});
