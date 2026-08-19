import { createHash } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  lookupApiKeyByHash: vi.fn(),
  claimAcceptanceDependencyObservationWork: vi.fn(),
  getGithubDependencyObservationCredential: vi.fn(),
  releaseAcceptanceDependencyObservationClaim: vi.fn(),
  recordAcceptanceDependencyObservation: vi.fn(),
  AcceptanceDependencyObservationClaimError: class AcceptanceDependencyObservationClaimError extends Error {},
  AcceptanceDependencyObservationConflictError: class AcceptanceDependencyObservationConflictError extends Error {},
  AcceptanceDependencyObservationInvalidEvidenceError: class AcceptanceDependencyObservationInvalidEvidenceError extends Error {},
}));
vi.mock("../../../../lib/acceptance-dependency-observation", () => ({
  readBoundedAcceptanceDependencyObservationJson: vi.fn(),
  parseAcceptanceDependencyObservationForStorage: vi.fn(),
}));

import {
  claimAcceptanceDependencyObservationWork,
  lookupApiKeyByHash,
  recordAcceptanceDependencyObservation,
} from "@agentrail/db-postgres";
import {
  parseAcceptanceDependencyObservationForStorage,
  readBoundedAcceptanceDependencyObservationJson,
} from "../../../../lib/acceptance-dependency-observation";
import { POST as claim } from "./acceptance-dependency-observation-work/claim/route";
import { POST as submit } from "./acceptance-dependency-observations/route";

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";

function request(path: string, token: string, body: unknown, claimToken = false): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(claimToken ? { "x-agentrail-dependency-claim-token": "claim-token" } : {}),
    },
    body: JSON.stringify(body),
  });
}

function apiKey(token: string, kind: "fleet" | "self_hosted" | "agent_mcp", workspaceId = WORKSPACE_A) {
  return {
    tokenHash: createHash("sha256").update(token).digest("hex"),
    row: { id: `key-${kind}`, workspaceId, teamId: null, kind },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(claimAcceptanceDependencyObservationWork).mockResolvedValue(null as never);
  vi.mocked(readBoundedAcceptanceDependencyObservationJson).mockResolvedValue({
    ok: true,
    value: {},
  } as never);
  vi.mocked(parseAcceptanceDependencyObservationForStorage).mockReturnValue({
    input: { workspaceId: WORKSPACE_A },
  } as never);
});

describe("dependency observation worker route authentication", () => {
  it.each(["fleet", "self_hosted"] as const)(
    "derives the claim tenant from a workspace %s key",
    async (kind) => {
      const token = `ar_${kind}_runner`;
      const expected = apiKey(token, kind);
      vi.mocked(lookupApiKeyByHash).mockImplementation(async (hash) => (
        hash === expected.tokenHash ? expected.row as never : null as never
      ));

      const response = await claim(request(
        "/api/v1/runner/acceptance-dependency-observation-work/claim",
        token,
        { workerId: "worker:pnpm" },
      ));

      expect(response.status).toBe(204);
      expect(claimAcceptanceDependencyObservationWork).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_A,
        workerId: "worker:pnpm",
      });
    },
  );

  it("rejects an unknown deployment-wide Jace secret", async () => {
    vi.mocked(lookupApiKeyByHash).mockResolvedValue(null as never);

    const response = await claim(request(
      "/api/v1/runner/acceptance-dependency-observation-work/claim",
      "old-jace-console-secret",
      { workerId: "worker:pnpm" },
    ));

    expect(response.status).toBe(401);
    expect(claimAcceptanceDependencyObservationWork).not.toHaveBeenCalled();
  });

  it("rejects an agent_mcp key from the worker routes", async () => {
    const token = "ar_agent_mcp";
    const expected = apiKey(token, "agent_mcp");
    vi.mocked(lookupApiKeyByHash).mockResolvedValue(expected.row as never);

    const response = await claim(request(
      "/api/v1/runner/acceptance-dependency-observation-work/claim",
      token,
      { workerId: "worker:pnpm" },
    ));

    expect(response.status).toBe(403);
    expect(claimAcceptanceDependencyObservationWork).not.toHaveBeenCalled();
  });

  it("rejects a caller-selected claim workspace", async () => {
    const token = "ar_fleet_foreign_claim";
    const expected = apiKey(token, "fleet");
    vi.mocked(lookupApiKeyByHash).mockResolvedValue(expected.row as never);

    const response = await claim(request(
      "/api/v1/runner/acceptance-dependency-observation-work/claim",
      token,
      { workerId: "worker:pnpm", workspaceId: WORKSPACE_B },
    ));

    expect(response.status).toBe(400);
    expect(claimAcceptanceDependencyObservationWork).not.toHaveBeenCalled();
  });

  it("rejects evidence whose workspace differs from the authenticated key", async () => {
    const token = "ar_self_hosted_foreign_submit";
    const expected = apiKey(token, "self_hosted");
    vi.mocked(lookupApiKeyByHash).mockResolvedValue(expected.row as never);
    vi.mocked(parseAcceptanceDependencyObservationForStorage).mockReturnValue({
      input: { workspaceId: WORKSPACE_B },
    } as never);

    const response = await submit(request(
      "/api/v1/runner/acceptance-dependency-observations",
      token,
      {},
      true,
    ));

    expect(response.status).toBe(403);
    expect(recordAcceptanceDependencyObservation).not.toHaveBeenCalled();
  });
});
