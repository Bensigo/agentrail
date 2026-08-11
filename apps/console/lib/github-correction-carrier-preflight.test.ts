import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  getGithubCorrectionCarrierCredential: vi.fn(),
  reserveGithubCorrectionCarrierPreflight: vi.fn(),
  reportGithubCorrectionCarrierPreflight: vi.fn(),
}));
vi.mock("./github-current-pr", () => ({
  readCurrentGithubPullRequest: vi.fn(),
}));

import {
  getGithubCorrectionCarrierCredential,
  reportGithubCorrectionCarrierPreflight,
  reserveGithubCorrectionCarrierPreflight,
} from "@agentrail/db-postgres";
import { readCurrentGithubPullRequest } from "./github-current-pr";
import { preflightGithubCorrectionCarrier } from "./github-correction-carrier-preflight";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const DISPATCH_ID = "22222222-2222-4222-8222-222222222222";
const PREFLIGHT_ID = "33333333-3333-4333-8333-333333333333";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const reservation = {
  kind: "reserved" as const,
  preflight: {
    id: PREFLIGHT_ID,
    repo: "acme/widgets",
    prNumber: 42,
    headSha: HEAD,
    baseSha: BASE,
    dispatchId: DISPATCH_ID,
    dispatchIdentitySha256: "e".repeat(64),
    headCycleId: "44444444-4444-4444-8444-444444444444",
    authorityGeneration: 7,
    capabilityProfileId: "55555555-5555-4555-8555-555555555555",
    capabilityProfileSnapshotSha256: "f".repeat(64),
    permissionContract: "issues_write_and_pull_requests_write_v1",
  },
  inserted: true,
};

function credential() {
  return {
    ok: true as const,
    token: "ghs_never_return_this",
    expiresAt: "2030-01-01T00:00:00Z",
    permissionBasis: {
      repository: "scoped_installation_token" as const,
      issues: "write" as const,
      pullRequests: "write" as const,
    },
  };
}

function openPr(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    pullRequest: {
      repo: "acme/widgets",
      prNumber: 42,
      headSha: HEAD,
      baseSha: BASE,
      state: "open" as const,
      draft: false,
      merged: false,
      htmlUrl: "https://github.com/acme/widgets/pull/42",
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reserveGithubCorrectionCarrierPreflight).mockResolvedValue(reservation as never);
  vi.mocked(getGithubCorrectionCarrierCredential).mockResolvedValue(credential() as never);
  vi.mocked(readCurrentGithubPullRequest).mockResolvedValue(openPr());
  vi.mocked(reportGithubCorrectionCarrierPreflight).mockResolvedValue({
    kind: "reported",
    preflight: reservation.preflight,
  } as never);
});

afterEach(() => vi.unstubAllGlobals());

describe("preflightGithubCorrectionCarrier", () => {
  it("accepts only exact workspace/dispatch input and performs no work for malformed input", async () => {
    for (const input of [
      null,
      { workspaceId: WORKSPACE_ID },
      { workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID, repo: "acme/widgets" },
      { workspaceId: "ws-1", dispatchId: DISPATCH_ID },
    ]) {
      await expect(preflightGithubCorrectionCarrier(input as never)).resolves.toEqual({
        kind: "unavailable",
        reason: "invalid_input",
      });
    }
    expect(reserveGithubCorrectionCarrierPreflight).not.toHaveBeenCalled();
    expect(getGithubCorrectionCarrierCredential).not.toHaveBeenCalled();
    expect(readCurrentGithubPullRequest).not.toHaveBeenCalled();
  });

  it.each(["held", "not_current"] as const)(
    "does no credential or GitHub work when the reservation is %s",
    async (kind) => {
      vi.mocked(reserveGithubCorrectionCarrierPreflight).mockResolvedValue({ kind } as never);
      await expect(
        preflightGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID })
      ).resolves.toEqual({ kind });
      expect(getGithubCorrectionCarrierCredential).not.toHaveBeenCalled();
      expect(readCurrentGithubPullRequest).not.toHaveBeenCalled();
      expect(reportGithubCorrectionCarrierPreflight).not.toHaveBeenCalled();
    }
  );

  it("replays the persisted terminal ready outcome without credential or GitHub work", async () => {
    vi.mocked(reserveGithubCorrectionCarrierPreflight).mockResolvedValue({
      kind: "terminal",
      preflight: {
        ...reservation.preflight,
        status: "ready",
        result: { kind: "ready", headSha: HEAD, baseSha: BASE },
      },
    } as never);
    await expect(
      preflightGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID })
    ).resolves.toMatchObject({ kind: "ready", dispatchId: DISPATCH_ID, baseSha: BASE });
    expect(getGithubCorrectionCarrierCredential).not.toHaveBeenCalled();
    expect(readCurrentGithubPullRequest).not.toHaveBeenCalled();
    expect(reportGithubCorrectionCarrierPreflight).not.toHaveBeenCalled();
  });

  it.each([
    "github_unavailable",
    "invalid_github_response",
    "storage_unavailable",
  ] as const)("replays persisted indeterminate terminal truth: %s", async (reason) => {
    vi.mocked(reserveGithubCorrectionCarrierPreflight).mockResolvedValue({
      kind: "terminal",
      preflight: {
        ...reservation.preflight,
        status: "indeterminate",
        result: { kind: reason },
      },
    } as never);
    await expect(
      preflightGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID })
    ).resolves.toEqual({ kind: "indeterminate", reason });
    expect(getGithubCorrectionCarrierCredential).not.toHaveBeenCalled();
    expect(readCurrentGithubPullRequest).not.toHaveBeenCalled();
    expect(reportGithubCorrectionCarrierPreflight).not.toHaveBeenCalled();
  });

  it("reports known credential denial as unavailable without reading the PR", async () => {
    vi.mocked(getGithubCorrectionCarrierCredential).mockResolvedValue({
      ok: false,
      kind: "unavailable",
      reason: "installation_or_permission_denied",
    } as never);
    await expect(
      preflightGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID })
    ).resolves.toEqual({ kind: "unavailable", reason: "installation_or_permission_denied" });
    expect(readCurrentGithubPullRequest).not.toHaveBeenCalled();
    expect(reportGithubCorrectionCarrierPreflight).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      preflightId: PREFLIGHT_ID,
      outcome: { kind: "installation_or_permission_denied" },
    });
  });

  it.each([
    [
      { ok: false, kind: "indeterminate", reason: "github_unavailable" },
      { kind: "github_unavailable" },
      "github_unavailable",
    ],
    [
      { ok: false, kind: "indeterminate", reason: "invalid_github_response" },
      { kind: "invalid_github_response" },
      "invalid_github_response",
    ],
  ])("maps indeterminate credential failure %o through its closed DB outcome", async (failure, outcome, reason) => {
    vi.mocked(getGithubCorrectionCarrierCredential).mockResolvedValue(failure as never);
    await expect(
      preflightGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID })
    ).resolves.toEqual({ kind: "indeterminate", reason });
    expect(reportGithubCorrectionCarrierPreflight).toHaveBeenCalledWith(expect.objectContaining({ outcome }));
    expect(readCurrentGithubPullRequest).not.toHaveBeenCalled();
  });

  it("records a credential storage failure as a retryable closed outcome without falsely naming GitHub", async () => {
    vi.mocked(getGithubCorrectionCarrierCredential).mockResolvedValue({
      ok: false,
      kind: "indeterminate",
      reason: "storage_unavailable",
    } as never);
    await expect(
      preflightGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID })
    ).resolves.toEqual({ kind: "indeterminate", reason: "storage_unavailable" });
    expect(reportGithubCorrectionCarrierPreflight).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      preflightId: PREFLIGHT_ID,
      outcome: { kind: "storage_unavailable" },
    });
    expect(readCurrentGithubPullRequest).not.toHaveBeenCalled();
  });

  it("maps unavailable and malformed current-PR reads to indeterminate outcomes", async () => {
    for (const [reason, expectedReason] of [
      ["github_unavailable", "github_unavailable"],
      ["github_rejected", "invalid_github_response"],
      ["invalid_pr_metadata", "invalid_github_response"],
    ] as const) {
      vi.mocked(readCurrentGithubPullRequest).mockResolvedValue({
        ok: false,
        kind: "not_proven",
        reason,
      } as never);
      await expect(
        preflightGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID })
      ).resolves.toEqual({ kind: "indeterminate", reason: expectedReason });
      expect(reportGithubCorrectionCarrierPreflight).toHaveBeenLastCalledWith(
        expect.objectContaining({ outcome: { kind: expectedReason } })
      );
    }
  });

  it("contains an unexpected current-PR reader throw as a GitHub-indeterminate outcome", async () => {
    vi.mocked(readCurrentGithubPullRequest).mockRejectedValue(new Error("reader failure"));
    await expect(
      preflightGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID })
    ).resolves.toEqual({ kind: "indeterminate", reason: "github_unavailable" });
    expect(reportGithubCorrectionCarrierPreflight).toHaveBeenCalledWith(expect.objectContaining({
      outcome: { kind: "github_unavailable" },
    }));
  });

  it.each([
    ["closed", { state: "closed" }, "remote_pr_not_active"],
    ["merged", { state: "closed", merged: true }, "remote_pr_not_active"],
    ["draft", { draft: true }, "remote_pr_not_active"],
    ["head drift", { headSha: "c".repeat(40) }, "remote_head_mismatch"],
    ["base drift", { baseSha: "d".repeat(40) }, "remote_base_mismatch"],
  ])("rejects %s PR state", async (_label, overrides, reason) => {
    vi.mocked(readCurrentGithubPullRequest).mockResolvedValue(openPr(overrides) as never);
    await expect(
      preflightGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID })
    ).resolves.toEqual({ kind: "unavailable", reason });
  });

  it("returns token-free preparation proof only after a reported exact-head preflight", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await preflightGithubCorrectionCarrier({
      workspaceId: WORKSPACE_ID,
      dispatchId: DISPATCH_ID,
    });
    expect(result).toMatchObject({
      kind: "ready",
      headSha: HEAD,
      baseSha: BASE,
      proof: {
        repositoryGrant: "scoped_installation_token",
        issueCommentPermission: "issues_write",
        delivery: "not_attempted",
        activation: "not_started",
        acknowledgement: "not_observed",
        vendorAvailability: "not_asserted",
      },
    });
    expect(JSON.stringify(result)).not.toContain("ghs_never_return_this");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readCurrentGithubPullRequest).toHaveBeenCalledWith({
      token: "ghs_never_return_this",
      repo: "acme/widgets",
      prNumber: 42,
    });
    expect(reportGithubCorrectionCarrierPreflight).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      preflightId: PREFLIGHT_ID,
      outcome: { kind: "ready", headSha: HEAD, baseSha: BASE },
    });
  });

  it("never returns ready if the report loses current authority", async () => {
    vi.mocked(reportGithubCorrectionCarrierPreflight).mockResolvedValue({ kind: "not_current" } as never);
    await expect(
      preflightGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID })
    ).resolves.toEqual({ kind: "not_current" });
  });

  it("surfaces reserve/report/credential storage failures distinctly from GitHub availability", async () => {
    vi.mocked(reserveGithubCorrectionCarrierPreflight).mockRejectedValue(new Error("db offline"));
    await expect(
      preflightGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID })
    ).resolves.toEqual({ kind: "indeterminate", reason: "storage_unavailable" });

    vi.mocked(reserveGithubCorrectionCarrierPreflight).mockResolvedValue(reservation as never);
    vi.mocked(getGithubCorrectionCarrierCredential).mockRejectedValue(new Error("db offline"));
    await expect(
      preflightGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID })
    ).resolves.toEqual({ kind: "indeterminate", reason: "storage_unavailable" });
    expect(reportGithubCorrectionCarrierPreflight).toHaveBeenLastCalledWith({
      workspaceId: WORKSPACE_ID,
      preflightId: PREFLIGHT_ID,
      outcome: { kind: "storage_unavailable" },
    });

    vi.mocked(getGithubCorrectionCarrierCredential).mockResolvedValue(credential() as never);
    vi.mocked(reportGithubCorrectionCarrierPreflight).mockRejectedValue(new Error("db offline"));
    await expect(
      preflightGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID })
    ).resolves.toEqual({ kind: "indeterminate", reason: "storage_unavailable" });
  });

  it("remains fail-closed when storage-unavailable reporting itself cannot persist", async () => {
    vi.mocked(getGithubCorrectionCarrierCredential).mockResolvedValue({
      ok: false,
      kind: "indeterminate",
      reason: "storage_unavailable",
    } as never);
    vi.mocked(reportGithubCorrectionCarrierPreflight).mockRejectedValue(new Error("db outage"));
    await expect(
      preflightGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID })
    ).resolves.toEqual({ kind: "indeterminate", reason: "storage_unavailable" });
    expect(readCurrentGithubPullRequest).not.toHaveBeenCalled();
  });
});
