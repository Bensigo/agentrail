import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  resolveAcceptanceCriterionArtifact: vi.fn(),
}));
vi.mock("../../../../../../../../../../lib/artifacts/proxy", () => ({
  readBoundedArtifactForProxy: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  resolveAcceptanceCriterionArtifact,
} from "@agentrail/db-postgres";
import { readBoundedArtifactForProxy } from "../../../../../../../../../../lib/artifacts/proxy";
import { GET } from "./route";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const recordId = "00000000-0000-4000-8000-000000000002";
const artifactId = "00000000-0000-5000-8000-000000000003";
const objectKey = "review-evidence/private/object.png";

function params(id = artifactId) {
  return { params: Promise.resolve({ workspaceId, recordId, artifactId: id }) };
}

function request(query = "") {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${workspaceId}/change-records/${recordId}/criterion-outcomes/artifacts/${artifactId}${query}`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "viewer" } as never);
  vi.mocked(resolveAcceptanceCriterionArtifact).mockResolvedValue({
    kind: "resolved",
    artifact: {
      artifactId,
      contentType: "image/png",
      contentSha256: "a".repeat(64),
      artifactKey: objectKey,
    },
  } as never);
  vi.mocked(readBoundedArtifactForProxy).mockResolvedValue({
    kind: "available",
    bytes: new Uint8Array([137, 80, 78, 71]),
  });
});

describe("GET opaque criterion artifact", () => {
  it("authenticates before membership, resolution, or storage", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const response = await GET(request(), params());
    expect(response.status).toBe(401);
    expect(getWorkspaceMembership).not.toHaveBeenCalled();
    expect(resolveAcceptanceCriterionArtifact).not.toHaveBeenCalled();
    expect(readBoundedArtifactForProxy).not.toHaveBeenCalled();
  });

  it("requires workspace membership", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const response = await GET(request(), params());
    expect(response.status).toBe(403);
    expect(resolveAcceptanceCriterionArtifact).not.toHaveBeenCalled();
  });

  it("accepts no raw object key, URL, or other query authority", async () => {
    const response = await GET(request("?key=foreign&url=https://evil.test"), params());
    expect(response.status).toBe(400);
    expect(resolveAcceptanceCriterionArtifact).not.toHaveBeenCalled();
  });

  it("treats a malformed opaque id as absent", async () => {
    const response = await GET(request(), params("NOT-A-UUID"));
    expect(response.status).toBe(404);
    expect(resolveAcceptanceCriterionArtifact).not.toHaveBeenCalled();
  });

  it("accepts only the server-issued UUIDv5 artifact identity family", async () => {
    const response = await GET(
      request(),
      params("00000000-0000-4000-8000-000000000003"),
    );
    expect(response.status).toBe(404);
    expect(resolveAcceptanceCriterionArtifact).not.toHaveBeenCalled();
  });

  it("server-resolves the private key and proxies exact bytes without a URL or key response", async () => {
    const response = await GET(request(), params());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("location")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
    expect(resolveAcceptanceCriterionArtifact).toHaveBeenCalledWith({
      workspaceId,
      recordId,
      artifactId,
    });
    expect(readBoundedArtifactForProxy).toHaveBeenCalledWith({
      artifactKey: objectKey,
      contentSha256: "a".repeat(64),
    });
  });

  it("maps Record/artifact absence to one non-leaking 404", async () => {
    for (const kind of ["not_found", "artifact_not_found"] as const) {
      vi.mocked(resolveAcceptanceCriterionArtifact).mockResolvedValueOnce({ kind } as never);
      const response = await GET(request(), params());
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Artifact not found" });
      expect(readBoundedArtifactForProxy).not.toHaveBeenCalled();
    }
  });

  it("maps stale or unavailable custody to 409 before storage", async () => {
    vi.mocked(resolveAcceptanceCriterionArtifact).mockResolvedValueOnce({
      kind: "not_current",
    } as never);
    expect((await GET(request(), params())).status).toBe(409);

    vi.mocked(resolveAcceptanceCriterionArtifact).mockResolvedValueOnce({
      kind: "not_ready",
      reason: "invalid_criterion_outcome_custody",
    } as never);
    expect((await GET(request(), params())).status).toBe(409);
    expect(readBoundedArtifactForProxy).not.toHaveBeenCalled();
  });

  it("fails closed without partial bytes when private storage is unavailable", async () => {
    vi.mocked(readBoundedArtifactForProxy).mockResolvedValueOnce({ kind: "unavailable" });
    const response = await GET(request(), params());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      kind: "unavailable",
      reason: "artifact_bytes_unavailable",
    });
    expect(response.headers.get("location")).toBeNull();
  });

  it("sanitizes resolver failures", async () => {
    vi.mocked(resolveAcceptanceCriterionArtifact).mockRejectedValueOnce(
      new Error("private object key detail"),
    );
    const response = await GET(request(), params());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(objectKey);
  });
});
