import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  recordAcceptanceBuilderRouteSelection: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  recordAcceptanceBuilderRouteSelection,
} from "@agentrail/db-postgres";
import { POST } from "./route";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const RECORD_ID = "00000000-0000-0000-0000-000000000002";
const ROUTE_ID = "00000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-08-10T12:00:00.000Z");

const serverPayload = {
  kind: "acceptance_builder_route_selection",
  version: 1,
  workspaceId: WORKSPACE_ID,
  repository: "acme/widgets",
  recordId: RECORD_ID,
  contract: { id: "00000000-0000-4000-8000-000000000004", version: 1, status: "confirmed" },
  selection: { routeId: ROUTE_ID },
  route: { id: ROUTE_ID, adapter: "github_codex", configurationVersion: 2, status: "active" },
  snapshot: {
    builder: { adapter: "github_codex", routeId: ROUTE_ID },
    protocol: "github_comment",
    capability: {
      availability: "unverified",
      activation: "github_mention",
      acknowledgement: "vendor_activity",
      repairHead: "github_synchronize",
    },
    scopeBoundary: "correction_delivery_only",
  },
};

function params() {
  return Promise.resolve({ workspaceId: WORKSPACE_ID, recordId: RECORD_ID });
}

function request(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/change-records/${RECORD_ID}/builder-route`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

function malformedRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/change-records/${RECORD_ID}/builder-route`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "membership-1", role: "owner" } as never);
  vi.stubGlobal("fetch", vi.fn());
  vi.mocked(recordAcceptanceBuilderRouteSelection).mockResolvedValue({
    inserted: true,
    event: {
      id: "event-1",
      recordId: RECORD_ID,
      eventKey: "acceptance-builder-route:selected",
      stage: "builder_handoff",
      actor: "user:user-1",
      at: NOW,
      payloadRef: serverPayload,
      createdAt: NOW,
    },
  } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/v1/workspaces/[workspaceId]/change-records/[recordId]/builder-route", () => {
  it("requires authentication before workspace membership or persistence", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    expect((await POST(request({ routeId: ROUTE_ID }), { params: params() })).status).toBe(401);
    expect(getWorkspaceMembership).not.toHaveBeenCalled();
    expect(recordAcceptanceBuilderRouteSelection).not.toHaveBeenCalled();
  });

  it("requires an owner or admin before parsing or persisting the route", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "membership-1", role: "member" } as never);

    expect((await POST(request({ routeId: ROUTE_ID }), { params: params() })).status).toBe(403);
    expect(recordAcceptanceBuilderRouteSelection).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", malformedRequest()],
    ["a missing routeId", {}],
    ["an extra top-level field", { routeId: ROUTE_ID, adapter: "github_codex" }],
    ["an array body", [ROUTE_ID]],
    ["a non-string routeId", { routeId: { id: ROUTE_ID } }],
    ["an arbitrary string routeId", { routeId: "github_codex" }],
    ["a JWT-shaped routeId", { routeId: "eyJhbGciOiJIUzI1NiJ9.payload.signature" }],
    ["a non-UUID routeId", { routeId: "00000000-0000-4000-8000" }],
    ["a UUID without a supported version", { routeId: "00000000-0000-0000-8000-000000000003" }],
    ["a UUID without an RFC variant", { routeId: "00000000-0000-4000-0000-000000000003" }],
  ])("rejects %s before persistence", async (_name, body) => {
    const response = await POST(
      body instanceof NextRequest ? body : request(body),
      { params: params() }
    );

    expect(response.status).toBe(400);
    expect(recordAcceptanceBuilderRouteSelection).not.toHaveBeenCalled();
  });

  it("persists only the route ID with the authenticated actor and no dispatch side effect", async () => {
    const response = await POST(request({ routeId: ROUTE_ID }), { params: params() });

    expect(response.status).toBe(201);
    expect(recordAcceptanceBuilderRouteSelection).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      selectedBy: "user:user-1",
      routeId: ROUTE_ID,
    });
    await expect(response.json()).resolves.toEqual({
      inserted: true,
      event: {
        id: "event-1",
        eventKey: "acceptance-builder-route:selected",
        stage: "builder_handoff",
        at: NOW.toISOString(),
        payloadRef: serverPayload,
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 200 for an exact idempotent replay", async () => {
    vi.mocked(recordAcceptanceBuilderRouteSelection).mockResolvedValueOnce({
      inserted: false,
      event: {
        id: "event-1",
        recordId: RECORD_ID,
        eventKey: "acceptance-builder-route:selected",
        stage: "builder_handoff",
        actor: "user:user-1",
        at: NOW,
        payloadRef: serverPayload,
        createdAt: NOW,
      },
    } as never);

    const response = await POST(request({ routeId: ROUTE_ID }), { params: params() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ inserted: false });
  });

  it.each([
    "route belongs to another workspace",
    "route not found",
    "route is disabled",
  ])("returns 409 when storage rejects %s", async (reason) => {
    vi.mocked(recordAcceptanceBuilderRouteSelection).mockRejectedValueOnce(new Error(reason));

    expect((await POST(request({ routeId: ROUTE_ID }), { params: params() })).status).toBe(409);
    expect(recordAcceptanceBuilderRouteSelection).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      selectedBy: "user:user-1",
      routeId: ROUTE_ID,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
