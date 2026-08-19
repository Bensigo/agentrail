import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  reserveAcceptanceDependencyBuilderDelivery: vi.fn(),
  getGithubDependencyBuilderCredential: vi.fn(),
  reportAcceptanceDependencyBuilderDelivery: vi.fn(),
}));
vi.mock("./github-dependency-builder-comment", () => ({
  postGithubDependencyBuilderComment: vi.fn(),
}));

import {
  getGithubDependencyBuilderCredential,
  reportAcceptanceDependencyBuilderDelivery,
  reserveAcceptanceDependencyBuilderDelivery,
} from "@agentrail/db-postgres";
import { postGithubDependencyBuilderComment } from "./github-dependency-builder-comment";
import { runGithubDependencyBuilderDelivery } from "./github-dependency-builder-delivery";

const command = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  recordId: "22222222-2222-4222-8222-222222222222",
  externalBuilderPackEventId: "33333333-3333-4333-8333-333333333333",
  requestedBy: "user:44444444-4444-4444-8444-444444444444",
};
const delivery = {
  id: "55555555-5555-4555-8555-555555555555",
  repo: "acme/widgets",
  prNumber: 42,
  bodySha256: "a".repeat(64),
  githubInstallationIdentitySha256: "b".repeat(64),
};

beforeEach(() => vi.clearAllMocks());

describe("runGithubDependencyBuilderDelivery", () => {
  it("reserves before the sole write and closes the exact receipt", async () => {
    vi.mocked(reserveAcceptanceDependencyBuilderDelivery).mockResolvedValue({
      kind: "reserved", delivery, body: "@claude\nJace dependency handoff",
    } as never);
    vi.mocked(getGithubDependencyBuilderCredential).mockResolvedValue({
      ok: true, token: "ghs_scoped", expiresAt: "2026-08-14T12:00:00Z",
      permissionBasis: { repository: "scoped_installation_token", issues: "write", pullRequests: "write" },
    });
    vi.mocked(postGithubDependencyBuilderComment).mockResolvedValue({
      kind: "published", commentId: "901",
      commentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-901",
      bodySha256: "a".repeat(64),
    });
    vi.mocked(reportAcceptanceDependencyBuilderDelivery).mockResolvedValue({
      kind: "reported", delivery: { status: "carrier_accepted" },
    } as never);
    await expect(runGithubDependencyBuilderDelivery(command)).resolves.toEqual({
      kind: "carrier_accepted", deliveryId: delivery.id, githubCommentId: "901",
      githubCommentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-901",
    });
    expect(vi.mocked(reserveAcceptanceDependencyBuilderDelivery).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(postGithubDependencyBuilderComment).mock.invocationCallOrder[0]!);
    expect(postGithubDependencyBuilderComment).toHaveBeenCalledOnce();
    expect(getGithubDependencyBuilderCredential).toHaveBeenCalledWith({
      workspaceId: command.workspaceId,
      repo: delivery.repo,
      expectedInstallationIdentitySha256: delivery.githubInstallationIdentitySha256,
    });
    expect(reportAcceptanceDependencyBuilderDelivery).toHaveBeenCalledWith({
      workspaceId: command.workspaceId,
      deliveryId: delivery.id,
      outcome: {
        kind: "carrier_accepted", githubCommentId: "901",
        githubCommentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-901",
        bodySha256: "a".repeat(64),
      },
    });
  });

  it("fails closed without posting when the reserved installation identity no longer matches", async () => {
    vi.mocked(reserveAcceptanceDependencyBuilderDelivery).mockResolvedValue({
      kind: "reserved", delivery, body: "@claude\nJace dependency handoff",
    } as never);
    vi.mocked(getGithubDependencyBuilderCredential).mockResolvedValue({
      ok: false,
      kind: "unavailable",
      reason: "installation_or_permission_denied",
    });
    vi.mocked(reportAcceptanceDependencyBuilderDelivery).mockResolvedValue({
      kind: "reported", delivery: { status: "bounded_failed" },
    } as never);

    await expect(runGithubDependencyBuilderDelivery(command)).resolves.toEqual({
      kind: "bounded_failed",
      deliveryId: delivery.id,
    });
    expect(getGithubDependencyBuilderCredential).toHaveBeenCalledWith({
      workspaceId: command.workspaceId,
      repo: delivery.repo,
      expectedInstallationIdentitySha256: delivery.githubInstallationIdentitySha256,
    });
    expect(postGithubDependencyBuilderComment).not.toHaveBeenCalled();
    expect(reportAcceptanceDependencyBuilderDelivery).toHaveBeenCalledWith({
      workspaceId: command.workspaceId,
      deliveryId: delivery.id,
      outcome: { kind: "bounded_failed", reason: "credential_unavailable" },
    });
  });

  it("never posts an inert replay or uncertain reservation", async () => {
    vi.mocked(reserveAcceptanceDependencyBuilderDelivery).mockResolvedValue({
      kind: "held", reason: "ambiguous_hold", deliveryId: delivery.id,
    });
    await expect(runGithubDependencyBuilderDelivery(command)).resolves.toEqual({
      kind: "held", reason: "ambiguous_hold", deliveryId: delivery.id,
    });
    expect(getGithubDependencyBuilderCredential).not.toHaveBeenCalled();
    expect(postGithubDependencyBuilderComment).not.toHaveBeenCalled();
  });

  it("returns a storage hold after an accepted write whose receipt cannot be persisted", async () => {
    vi.mocked(reserveAcceptanceDependencyBuilderDelivery).mockResolvedValue({
      kind: "reserved", delivery, body: "@claude\nJace dependency handoff",
    } as never);
    vi.mocked(getGithubDependencyBuilderCredential).mockResolvedValue({
      ok: true, token: "ghs_scoped", expiresAt: "2026-08-14T12:00:00Z",
      permissionBasis: { repository: "scoped_installation_token", issues: "write", pullRequests: "write" },
    });
    vi.mocked(postGithubDependencyBuilderComment).mockResolvedValue({
      kind: "published", commentId: "901",
      commentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-901",
      bodySha256: "a".repeat(64),
    });
    vi.mocked(reportAcceptanceDependencyBuilderDelivery).mockRejectedValue(new Error("storage unavailable"));
    await expect(runGithubDependencyBuilderDelivery(command)).resolves.toEqual({
      kind: "held", reason: "storage_unavailable",
    });
    expect(postGithubDependencyBuilderComment).toHaveBeenCalledOnce();
  });
});
