import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #1268 fix round — the writer↔reader round-trip pin.
 *
 * `ONBOARD_EXTERNAL_ID_PREFIX` single-sources the `onboard:` prefix, but a
 * constant alone can't prove the composed pair keeps agreeing (a refactor
 * could stop one side using it). This test calls the REAL `enqueueOnboard`
 * (the writer, from `@agentrail/db-postgres` — deliberately NOT mocked) and
 * feeds the exact `external_id` it persists through the REAL
 * `onboardRepoFullName` (the console reader that routes completion notices).
 * Any drift — prefix change, shape change, one side abandoning the constant —
 * breaks loudly here instead of silently misrouting onboard completions onto
 * issue-shaped notices.
 *
 * Only the package-INTERNAL `db` module is mocked (same insert-chain capture
 * shape as the package's own onboard-intake.test.ts), so the writer's real
 * code path runs without a live Postgres. The relative specifier resolves to
 * the same dist/db.js module id the package's own relative imports resolve
 * to, so the capture intercepts `enqueueOnboard`'s single insert.
 */
const mockState = vi.hoisted(() => ({
  capturedValues: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../../../../../../../packages/db-postgres/dist/db.js", () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        mockState.capturedValues = v;
        return {
          onConflictDoNothing: () => ({
            returning: async () => [{ id: String(v["id"]) }],
          }),
        };
      },
    }),
  },
}));

import {
  enqueueOnboard,
  ONBOARD_EXTERNAL_ID_PREFIX,
} from "@agentrail/db-postgres";
import { onboardRepoFullName } from "./onboard-notify";

beforeEach(() => {
  mockState.capturedValues = undefined;
});

describe("onboard external-id round-trip (writer → reader, #1268)", () => {
  it("the external_id the REAL enqueueOnboard persists parses back through onboardRepoFullName", async () => {
    const result = await enqueueOnboard({
      workspaceId: "ws-1",
      repoFullName: "acme/widgets",
    });
    expect(result.enqueued).toBe(true);

    const externalId = mockState.capturedValues?.["externalId"];
    expect(typeof externalId).toBe("string");
    // The writer used the shared constant (not a re-drifted literal)...
    expect(externalId).toBe(`${ONBOARD_EXTERNAL_ID_PREFIX}acme/widgets`);
    // ...and the console reader recovers the repo from the writer's own output.
    expect(onboardRepoFullName(externalId as string)).toBe("acme/widgets");
  });

  it("an issue-kind external id (the other writer's shape) still parses as NOT onboard", () => {
    // Complement of the round-trip: the reader must not over-match. Issue rows
    // carry `owner/name#123` / full URLs — never the onboard prefix.
    expect(onboardRepoFullName("acme/widgets#42")).toBeNull();
    expect(
      onboardRepoFullName("https://github.com/acme/widgets/issues/42")
    ).toBeNull();
  });
});
