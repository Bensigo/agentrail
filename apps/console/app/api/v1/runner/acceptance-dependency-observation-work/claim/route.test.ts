import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  claimAcceptanceDependencyObservationWork: vi.fn(),
  getGithubDependencyObservationCredential: vi.fn(),
  releaseAcceptanceDependencyObservationClaim: vi.fn(),
}));

import {
  claimAcceptanceDependencyObservationWork,
  getGithubDependencyObservationCredential,
  releaseAcceptanceDependencyObservationClaim,
} from "@agentrail/db-postgres";
import { POST } from "./route";

const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_SECRET = process.env.JACE_CONSOLE_TOKEN;
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const INSTALLATION_IDENTITY = "2".repeat(64);
const descriptor = {
  claim: {
    id: "22222222-2222-4222-8222-222222222222",
    token: "claim-token",
    expiresAt: new Date("2026-08-14T08:05:00.000Z"),
  },
  binding: {
    workspaceId: WORKSPACE_ID,
    recordId: "33333333-3333-4333-8333-333333333333",
    repo: "acme/widgets",
    prNumber: 42,
    headSha: "a".repeat(40),
    headCycleId: "44444444-4444-4444-8444-444444444444",
    authorityGeneration: 3,
    acceptanceContract: { id: "55555555-5555-4555-8555-555555555555", version: 1, sha256: "b".repeat(64) },
    compiledPack: {
      id: "66666666-6666-4666-8666-666666666666",
      sha256: "c".repeat(64),
      sourceSnapshotId: "77777777-7777-4777-8777-777777777777",
      sourceCustodyIdentitySha256: "d".repeat(64),
      compilerVersion: "exact-head-correction-pack-v6",
      policyVersion: "bounded-exact-ranges-v4",
    },
  },
  candidate: {
    identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" },
    package: "lodash",
    dependencyKind: "dependencies",
    specifier: "^4.17.20",
    currentVersion: "4.17.20",
    targetVersion: "4.17.21",
    proposalFingerprint: `sha256:${"e".repeat(64)}`,
  },
  source: {
    manifest: { path: "package.json", blobSha: "f".repeat(40) },
    lockfile: { path: "pnpm-lock.yaml", blobSha: "1".repeat(40) },
  },
  operation: {
    updateArgv: ["pnpm", "update", "lodash@4.17.21", "--lockfile-only", "--ignore-scripts"],
    authority: "observe_or_refuse_only",
  },
  githubInstallationIdentitySha256: INSTALLATION_IDENTITY,
};

function request(body: unknown, auth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/acceptance-dependency-observation-work/claim", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${SECRET}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = SECRET;
  vi.mocked(getGithubDependencyObservationCredential).mockResolvedValue({
    ok: true,
    token: "github-installation-token",
    expiresAt: "2030-01-01T00:00:00.000Z",
    permissionBasis: { repository: "scoped_installation_token", contents: "read" },
  } as never);
  vi.mocked(releaseAcceptanceDependencyObservationClaim).mockResolvedValue(true as never);
  vi.mocked(claimAcceptanceDependencyObservationWork).mockResolvedValue(null as never);
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.JACE_CONSOLE_TOKEN;
  else process.env.JACE_CONSOLE_TOKEN = ORIGINAL_SECRET;
});

describe("POST /runner/acceptance-dependency-observation-work/claim", () => {
  it("fails closed before tenant or claim reads without runner auth", async () => {
    const response = await POST(request({ workspaceId: WORKSPACE_ID, workerId: "worker:pnpm" }, false));
    expect(response.status).toBe(401);
    expect(getGithubDependencyObservationCredential).not.toHaveBeenCalled();
    expect(claimAcceptanceDependencyObservationWork).not.toHaveBeenCalled();
  });

  it("rejects caller-selected work locators", async () => {
    const response = await POST(request({
      workspaceId: WORKSPACE_ID,
      workerId: "worker:pnpm",
      recordId: descriptor.binding.recordId,
    }));
    expect(response.status).toBe(400);
    expect(claimAcceptanceDependencyObservationWork).not.toHaveBeenCalled();
  });

  it("releases the exact lease when the repository-scoped credential is unavailable", async () => {
    vi.mocked(claimAcceptanceDependencyObservationWork).mockResolvedValue(descriptor as never);
    vi.mocked(getGithubDependencyObservationCredential).mockResolvedValue({
      ok: false,
      kind: "unavailable",
      reason: "installation_or_permission_denied",
    } as never);
    const response = await POST(request({ workspaceId: WORKSPACE_ID, workerId: "worker:pnpm" }));
    expect(response.status).toBe(503);
    expect(releaseAcceptanceDependencyObservationClaim).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      claimId: descriptor.claim.id,
      claimToken: descriptor.claim.token,
    });
  });

  it("returns an exact server-derived descriptor and ephemeral source credential", async () => {
    vi.mocked(claimAcceptanceDependencyObservationWork).mockResolvedValue(descriptor as never);
    const response = await POST(request({ workspaceId: WORKSPACE_ID, workerId: "worker:pnpm" }));
    expect(response.status).toBe(200);
    expect(claimAcceptanceDependencyObservationWork).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      workerId: "worker:pnpm",
    });
    expect(getGithubDependencyObservationCredential).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      repo: descriptor.binding.repo,
      expectedInstallationIdentitySha256: INSTALLATION_IDENTITY,
    });
    const responseBody = await response.json();
    expect(responseBody).toEqual({
      claim: { ...descriptor.claim, expiresAt: descriptor.claim.expiresAt.toISOString() },
      binding: descriptor.binding,
      candidate: descriptor.candidate,
      source: descriptor.source,
      operation: descriptor.operation,
      github: { token: "github-installation-token" },
    });
    expect(responseBody).not.toHaveProperty("githubInstallationIdentitySha256");
  });

  it("returns 204 when no current pnpm work is eligible", async () => {
    const response = await POST(request({ workspaceId: WORKSPACE_ID, workerId: "worker:pnpm" }));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
});
