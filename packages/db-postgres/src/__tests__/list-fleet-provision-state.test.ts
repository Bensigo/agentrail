import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// The db module is mocked so importing the query module never touches a real
// Postgres. `listFleetProvisionState` is a single
// select({...}).from(workspaces).leftJoin(apiKeys, cond) with no further
// chain — the LEFT JOIN call itself is the terminal, awaited step, so the
// mock's `leftJoin` both captures its arguments (for structural assertions)
// AND resolves the configured rows.
const mockState = vi.hoisted(() => ({
  rows: [] as Array<{
    workspaceId: string;
    slug: string;
    hostedExecution: boolean;
    fleetKeyId: string | null;
  }>,
  capturedSelectShape: undefined as unknown,
  capturedJoinTable: undefined as unknown,
  capturedJoinCondition: undefined as unknown,
}));

vi.mock("../db.js", () => ({
  db: {
    select: (shape: unknown) => {
      mockState.capturedSelectShape = shape;
      return {
        from: () => ({
          leftJoin: (table: unknown, cond: unknown) => {
            mockState.capturedJoinTable = table;
            mockState.capturedJoinCondition = cond;
            return Promise.resolve(mockState.rows);
          },
        }),
      };
    },
  },
}));

import { listFleetProvisionState } from "../queries/index.js";
import { apiKeys } from "../schema/api_keys.js";
import { workspaces } from "../schema/workspaces.js";

const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

beforeEach(() => {
  mockState.rows = [];
  mockState.capturedSelectShape = undefined;
  mockState.capturedJoinTable = undefined;
  mockState.capturedJoinCondition = undefined;
});

describe("listFleetProvisionState (#1267 PR ①)", () => {
  it("selects workspaceId, slug, hostedExecution, and the joined fleet key id", async () => {
    mockState.rows = [];

    await listFleetProvisionState();

    const shape = mockState.capturedSelectShape as Record<string, unknown>;
    expect(shape.workspaceId).toBe(workspaces.id);
    expect(shape.slug).toBe(workspaces.slug);
    expect(shape.hostedExecution).toBe(workspaces.hostedExecution);
    expect(shape.fleetKeyId).toBe(apiKeys.id);
  });

  it("LEFT JOINs api_keys scoped to workspace_id + kind='fleet' + revoked_at IS NULL — not just workspace_id", async () => {
    await listFleetProvisionState();

    expect(mockState.capturedJoinTable).toBe(apiKeys);
    expect(renderCondition(mockState.capturedJoinCondition)).toEqual(
      renderCondition(
        and(
          eq(apiKeys.workspaceId, workspaces.id),
          eq(apiKeys.kind, "fleet"),
          isNull(apiKeys.revokedAt)
        )
      )
    );
  });

  it("maps a joined fleet key row to hasActiveFleetKey: true with its id", async () => {
    mockState.rows = [
      { workspaceId: "ws-1", slug: "acme", hostedExecution: true, fleetKeyId: "key-1" },
    ];

    const result = await listFleetProvisionState();

    expect(result).toEqual([
      {
        workspaceId: "ws-1",
        slug: "acme",
        hostedExecution: true,
        hasActiveFleetKey: true,
        fleetKeyId: "key-1",
      },
    ]);
  });

  it("maps a null joined fleet key (no active fleet key) to hasActiveFleetKey: false, fleetKeyId: null", async () => {
    mockState.rows = [
      { workspaceId: "ws-2", slug: "acme-self-hosted", hostedExecution: false, fleetKeyId: null },
    ];

    const result = await listFleetProvisionState();

    expect(result).toEqual([
      {
        workspaceId: "ws-2",
        slug: "acme-self-hosted",
        hostedExecution: false,
        hasActiveFleetKey: false,
        fleetKeyId: null,
      },
    ]);
  });

  it("returns one row per workspace, mixed eligibility/key states preserved in order", async () => {
    mockState.rows = [
      { workspaceId: "ws-1", slug: "a", hostedExecution: true, fleetKeyId: "key-1" },
      { workspaceId: "ws-2", slug: "b", hostedExecution: true, fleetKeyId: null },
      { workspaceId: "ws-3", slug: "c", hostedExecution: false, fleetKeyId: "key-3" },
    ];

    const result = await listFleetProvisionState();

    expect(result.map((r) => r.workspaceId)).toEqual(["ws-1", "ws-2", "ws-3"]);
    expect(result[0]!.hasActiveFleetKey).toBe(true);
    expect(result[1]!.hasActiveFleetKey).toBe(false);
    expect(result[2]!.hasActiveFleetKey).toBe(true);
  });
});
