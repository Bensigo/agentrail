import { describe, expect, it } from "vitest";
import { isConnectorProvider, validateConnectorUpdate } from "./connectors.js";

/**
 * Pure-function coverage only (Task 7, debugging design spec). Both
 * functions under test are synchronous and touch no I/O — `getConnectors.js`
 * / `db.js` mocking (see `briefs.test.ts`'s own doc-comment: "there is no
 * live-DB harness in this package") is unnecessary here.
 *
 * Task 7 adds `"railway"` to `connectorProviderEnum` (a free-text column, so
 * this is a TS-union addition only — no migration, same precedent as
 * `"jace"`) and a `railwayProjectId` branch to `validateConnectorUpdate`
 * (the workspace's Railway project id, saved via this route alongside the
 * secret PUT — see `schema/connectors.ts`'s doc-comment on
 * `ConnectorConfig.railwayProjectId`).
 */

describe("isConnectorProvider — railway (Task 7)", () => {
  it("recognizes 'railway' as a known connector provider", () => {
    expect(isConnectorProvider("railway")).toBe(true);
  });

  it("still rejects an arbitrary string", () => {
    expect(isConnectorProvider("not-a-provider")).toBe(false);
  });
});

describe("validateConnectorUpdate — railwayProjectId (Task 7)", () => {
  it("accepts and trims a well-formed railwayProjectId", () => {
    const res = validateConnectorUpdate({ config: { railwayProjectId: "  proj-123  " } });
    expect(res).toEqual({ ok: true, value: { config: { railwayProjectId: "proj-123" } } });
  });

  it("rejects a non-string railwayProjectId", () => {
    const res = validateConnectorUpdate({ config: { railwayProjectId: 123 as unknown as string } });
    expect(res).toEqual({ ok: false, error: "railwayProjectId must be a string" });
  });

  it("rejects an empty (or whitespace-only) railwayProjectId", () => {
    const res = validateConnectorUpdate({ config: { railwayProjectId: "   " } });
    expect(res).toEqual({ ok: false, error: "railwayProjectId must not be empty" });
  });

  it("rejects a railwayProjectId over 64 characters", () => {
    const res = validateConnectorUpdate({ config: { railwayProjectId: "x".repeat(65) } });
    expect(res).toEqual({
      ok: false,
      error: "railwayProjectId must be at most 64 characters",
    });
  });

  it("leaves railwayProjectId out of the normalized value when absent (no accidental default)", () => {
    const res = validateConnectorUpdate({ config: { triggerLabel: "afk" } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.config).not.toHaveProperty("railwayProjectId");
    }
  });

  it("composes with an unrelated field (triggerLabel) in the same update, unaffected by this addition", () => {
    const res = validateConnectorUpdate({
      config: { triggerLabel: "ready-for-agent", railwayProjectId: "proj-abc" },
    });
    expect(res).toEqual({
      ok: true,
      value: { config: { triggerLabel: "ready-for-agent", railwayProjectId: "proj-abc" } },
    });
  });
});
