import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  readCurrentAcceptanceCriterionOutcomeBundle: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  readCurrentAcceptanceCriterionOutcomeBundle,
} from "@agentrail/db-postgres";
import { GET } from "./route";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const recordId = "00000000-0000-4000-8000-000000000002";
const params = { params: Promise.resolve({ workspaceId, recordId }) };

function request(query = "") {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${workspaceId}/change-records/${recordId}/criterion-outcomes${query}`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "member" } as never);
  vi.mocked(readCurrentAcceptanceCriterionOutcomeBundle).mockResolvedValue({
    kind: "current",
    bundle: { recordedAt: new Date("2026-08-11T08:00:00.000Z") },
  } as never);
});

describe("GET member criterion outcomes", () => {
  it("authenticates before workspace or Record lookup", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const response = await GET(request(), params);
    expect(response.status).toBe(401);
    expect(getWorkspaceMembership).not.toHaveBeenCalled();
    expect(readCurrentAcceptanceCriterionOutcomeBundle).not.toHaveBeenCalled();
  });

  it("requires workspace membership", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const response = await GET(request(), params);
    expect(response.status).toBe(403);
    expect(readCurrentAcceptanceCriterionOutcomeBundle).not.toHaveBeenCalled();
  });

  it("rejects every query parameter instead of accepting caller custody", async () => {
    const response = await GET(request("?headSha=untrusted&objectKey=secret"), params);
    expect(response.status).toBe(400);
    expect(readCurrentAcceptanceCriterionOutcomeBundle).not.toHaveBeenCalled();
  });

  it("returns the DB-derived current bundle with serialized dates and no-store", async () => {
    const response = await GET(request(), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({
      kind: "current",
      bundle: { recordedAt: "2026-08-11T08:00:00.000Z" },
    });
    expect(readCurrentAcceptanceCriterionOutcomeBundle).toHaveBeenCalledWith({
      workspaceId,
      recordId,
    });
  });

  it("maps absence to 404 and currentness/readiness failures to 409", async () => {
    vi.mocked(readCurrentAcceptanceCriterionOutcomeBundle).mockResolvedValueOnce({
      kind: "not_found",
    } as never);
    expect((await GET(request(), params)).status).toBe(404);

    vi.mocked(readCurrentAcceptanceCriterionOutcomeBundle).mockResolvedValueOnce({
      kind: "not_current",
    } as never);
    expect((await GET(request(), params)).status).toBe(409);

    vi.mocked(readCurrentAcceptanceCriterionOutcomeBundle).mockResolvedValueOnce({
      kind: "not_ready",
      reason: "criterion_outcome_bundle_not_recorded",
    } as never);
    expect((await GET(request(), params)).status).toBe(409);
  });

  it.each([
    "authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "token=abcdefghijk12345",
    "api_key=abcdefghijk12345",
  ])("fails a secret-shaped DB projection closed without returning the value", async (observed) => {
    vi.mocked(readCurrentAcceptanceCriterionOutcomeBundle).mockResolvedValueOnce({
      kind: "current",
      bundle: {
        outcomes: [{ observed }],
        recordedAt: new Date("2026-08-11T08:00:00.000Z"),
      },
    } as never);

    const response = await GET(request(), params);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({
      kind: "not_ready",
      reason: "invalid_criterion_outcome_custody",
    });
    expect(JSON.stringify(body)).not.toContain(observed);
  });

  it("sanitizes storage failures", async () => {
    vi.mocked(readCurrentAcceptanceCriterionOutcomeBundle).mockRejectedValueOnce(
      new Error("postgres secret detail"),
    );
    const response = await GET(request(), params);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Criterion outcomes unavailable" });
  });
});
