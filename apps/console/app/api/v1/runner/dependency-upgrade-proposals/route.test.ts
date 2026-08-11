import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  createDraftAcceptanceRecordFromDependencyObservation: vi.fn(),
  dependencyObservationDraftErrorCodes: [
    "not_found",
    "unsupported_manager",
    "unsafe_custody",
    "conflict",
  ],
}));

import { createDraftAcceptanceRecordFromDependencyObservation } from "@agentrail/db-postgres";
import { POST } from "./route";

const SECRET = "jace-secret";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const WATCH_ID = "22222222-2222-4222-8222-222222222222";
const FINGERPRINT = `sha256:${"a".repeat(64)}`;
const locator = {
  workspaceId: WORKSPACE_ID,
  watchId: WATCH_ID,
  candidateFingerprint: FINGERPRINT,
};
const draftResult = {
  record: { id: "record-1", repo: "acme/widgets" },
  contract: { id: "contract-1", version: 1 },
  event: { id: "event-1" },
  observation: { id: "observation-1", key: "dependency-observation:one" },
  profile: {
    ecosystem: "node",
    manager: "pnpm",
    profile: "pnpm_lockfile_only_v1",
    capability: "proposal_observation_only",
  },
};

function request(
  body: unknown,
  options: { auth?: boolean; contentType?: string } = {}
) {
  return new NextRequest("http://localhost/api/v1/runner/dependency-upgrade-proposals", {
    method: "POST",
    headers: {
      "content-type": options.contentType ?? "application/json",
      ...(options.auth === false ? {} : { Authorization: `Bearer ${SECRET}` }),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = SECRET;
  vi.mocked(createDraftAcceptanceRecordFromDependencyObservation).mockResolvedValue({
    ...draftResult,
    created: true,
  } as never);
});

describe("dependency observation draft boundary", () => {
  it("authenticates before reading or resolving the locator", async () => {
    const response = await POST(request(locator, { auth: false }));

    expect(response.status).toBe(401);
    expect(createDraftAcceptanceRecordFromDependencyObservation).not.toHaveBeenCalled();
  });

  it("accepts only the three opaque locator fields", async () => {
    for (const extra of ["repo", "baseSha", "manifestPath", "candidate", "profile", "evidence"]) {
      const response = await POST(request({ ...locator, [extra]: "caller-authority" }));
      expect(response.status).toBe(400);
    }
    expect(createDraftAcceptanceRecordFromDependencyObservation).not.toHaveBeenCalled();
  });

  it("rejects noncanonical digests and media types", async () => {
    const uppercase = await POST(request({
      ...locator,
      candidateFingerprint: FINGERPRINT.toUpperCase(),
    }));
    const wrongMedia = await POST(request(locator, { contentType: "text/plain" }));

    expect(uppercase.status).toBe(400);
    expect(wrongMedia.status).toBe(400);
    expect(createDraftAcceptanceRecordFromDependencyObservation).not.toHaveBeenCalled();
  });

  it("returns only the server-derived draft identity and unresolved evidence boundary", async () => {
    const response = await POST(request(locator));
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(createDraftAcceptanceRecordFromDependencyObservation).toHaveBeenCalledWith(locator);
    expect(payload).toEqual({
      record: { id: "record-1", repo: "acme/widgets" },
      contract: { id: "contract-1", version: 1, status: "draft" },
      profile: {
        ecosystem: "node",
        manager: "pnpm",
        profile: "pnpm_lockfile_only_v1",
        capability: "proposal_observation_only",
      },
      evidence: {
        status: "unresolved",
        message:
          "This draft records observation-proposal custody only. Release, usage, runtime, target-lock, security, human confirmation, approval, Context Pack, builder handoff, delivery, pull request and merge remain unproven.",
      },
    });
    for (const forbiddenKey of [
      "candidate",
      "baseline",
      "lockfile",
      "commands",
      "approvalId",
      "token",
    ]) {
      expect(payload).not.toHaveProperty(forbiddenKey);
    }
  });

  it("returns the server-derived npm profile without accepting profile input", async () => {
    vi.mocked(createDraftAcceptanceRecordFromDependencyObservation).mockResolvedValue({
      ...draftResult,
      profile: {
        ecosystem: "node",
        manager: "npm",
        profile: "npm_package_lock_only_v1",
        capability: "proposal_observation_only",
      },
      created: true,
    } as never);

    const response = await POST(request(locator));
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(createDraftAcceptanceRecordFromDependencyObservation).toHaveBeenCalledWith(locator);
    expect(payload.profile).toEqual({
      ecosystem: "node",
      manager: "npm",
      profile: "npm_package_lock_only_v1",
      capability: "proposal_observation_only",
    });
    expect(payload).not.toHaveProperty("candidate");
    expect(payload).not.toHaveProperty("commands");
  });

  it("returns 200 for an exact immutable replay", async () => {
    vi.mocked(createDraftAcceptanceRecordFromDependencyObservation).mockResolvedValue({
      ...draftResult,
      created: false,
    } as never);

    const response = await POST(request(locator));

    expect(response.status).toBe(200);
  });

  it.each([
    ["not_found", 404, { error: "Dependency observation not found" }],
    ["unsupported_manager", 409, {
      error: "Dependency manager has no admitted proposal-observation profile",
      reason: "unsupported_manager",
      capability: "unavailable",
    }],
    ["unsafe_custody", 409, {
      error: "Dependency observation custody is unsafe for drafting",
      reason: "unsafe_custody",
      capability: "unavailable",
    }],
    ["conflict", 409, {
      error: "Dependency observation is already bound to a different draft",
    }],
  ] as const)("maps %s to a closed sanitized response", async (code, status, expected) => {
    vi.mocked(createDraftAcceptanceRecordFromDependencyObservation).mockRejectedValue({ code });

    const response = await POST(request(locator));

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(expected);
  });

  it("withholds unexpected storage errors", async () => {
    vi.mocked(createDraftAcceptanceRecordFromDependencyObservation).mockRejectedValue(
      new Error("postgres password=super-secret")
    );

    const response = await POST(request(locator));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toEqual({
      error: "Dependency observation draft storage is temporarily unavailable",
    });
    expect(JSON.stringify(payload)).not.toContain("super-secret");
  });

  it("has no legacy approval, publisher, queue, Pack, PR, or merge seam", () => {
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    for (const forbidden of [
      "recordApprovalRequest",
      "attachDependencyUpgradeApproval",
      "latestTelegramSessionForWorkspace",
      "sendTelegramMessage",
      "publishDependencyUpgradeIssue",
      "enqueueGithubIssue",
      "createAcceptanceContextPack",
      "createIssue(",
      "createPullRequest",
      "mergePullRequest",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
