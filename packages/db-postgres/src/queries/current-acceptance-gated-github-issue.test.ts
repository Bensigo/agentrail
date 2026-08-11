import { describe, expect, it } from "vitest";
import {
  mintAcceptanceGatedGithubIssueApprovalRequest,
  normalizeAcceptanceGatedGithubIssueReceipt,
  readCurrentAcceptanceGatedGithubIssue,
  reportAcceptanceGatedGithubIssueApprovalPublication,
  reportAcceptanceGatedGithubIssueManualReconciliation,
  reportAcceptanceGatedGithubIssuePublication,
  reserveAcceptanceGatedGithubIssueApprovalRequest,
  reserveCurrentAcceptanceGatedGithubIssue,
  resolveAcceptanceGatedGithubIssueApprovalRequest,
} from "./change_records.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const RECORD_ID = "22222222-2222-4222-8222-222222222222";
const BINDING_ID = "33333333-3333-4333-8333-333333333333";
const PUBLICATION_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "55555555-5555-4555-8555-555555555555";

describe("current Acceptance gated GitHub issue input boundary", () => {
  it("accepts only workspace and Record on the current read", async () => {
    await expect(readCurrentAcceptanceGatedGithubIssue({
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      headSha: "a".repeat(40),
    } as never)).rejects.toThrow("requires only workspace and Record");
    await expect(readCurrentAcceptanceGatedGithubIssue({
      workspaceId: "not-a-uuid",
      recordId: RECORD_ID,
    })).rejects.toThrow("requires only workspace and Record");
  });

  it("rejects caller-supplied issue content, labels, packet custody, and role", async () => {
    const valid = {
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      bindingId: BINDING_ID,
      reservedBy: `user:${USER_ID}`,
    };
    for (const extra of [
      { title: "caller title" },
      { body: "caller body" },
      { labels: ["ready-for-agent"] },
      { headSha: "a".repeat(40) },
      { packetIds: ["correction-deadbeef"] },
      { reservedRole: "owner" },
    ]) {
      await expect(reserveCurrentAcceptanceGatedGithubIssue({ ...valid, ...extra } as never))
        .rejects.toThrow("requires only workspace, Record, binding, and reserving user");
    }
    await expect(reserveCurrentAcceptanceGatedGithubIssue({
      ...valid,
      reservedBy: "server:console",
    })).rejects.toThrow("requires only workspace, Record, binding, and reserving user");
  });

  it("keeps the GitHub receipt grammar exact and closed", async () => {
    const base = {
      workspaceId: WORKSPACE_ID,
      publicationId: PUBLICATION_ID,
    };
    await expect(reportAcceptanceGatedGithubIssuePublication({
      ...base,
      outcome: {
        kind: "github_201",
        httpStatus: 200,
        githubIssueId: "123",
        githubIssueNumber: 9,
        githubApiUrl: "https://api.github.com/repos/acme/repo/issues/9",
        githubIssueUrl: "https://github.com/acme/repo/issues/9",
        githubRequestId: "REQ:1",
        responseTitleSha256: "a".repeat(64),
        responseBodySha256: "b".repeat(64),
        state: "open",
      },
    } as never)).rejects.toThrow("requires only workspace, publication, and closed receipt");
    await expect(reportAcceptanceGatedGithubIssuePublication({
      ...base,
      outcome: { kind: "bounded_failed", reason: "retry_later" },
    } as never)).rejects.toThrow("requires only workspace, publication, and closed receipt");
    await expect(reportAcceptanceGatedGithubIssuePublication({
      ...base,
      outcome: { kind: "bounded_failed", reason: "remote_not_current" },
    } as never)).rejects.toThrow("requires only workspace, publication, and closed receipt");
    await expect(reportAcceptanceGatedGithubIssuePublication({
      ...base,
      outcome: { kind: "ambiguous_hold", reason: "github_unavailable" },
      labels: [],
    } as never)).rejects.toThrow("requires only workspace, publication, and closed receipt");
  });
});

describe("Jace approval-bound gated issue boundary", () => {
  const REQUEST_ID = "66666666-6666-4666-8666-666666666666";
  const APPROVAL_ID = "77777777-7777-4777-8777-777777777777";
  const receipt = {
    kind: "github_201" as const,
    httpStatus: 201 as const,
    githubIssueId: "123",
    githubIssueNumber: 9,
    githubApiUrl: "https://api.github.com/repos/Acme/Widgets/issues/9",
    githubIssueUrl: "https://github.com/Acme/Widgets/issues/9",
    githubRequestId: "REQ:1",
    responseTitleSha256: "a".repeat(64),
    responseBodySha256: "b".repeat(64),
    state: "open" as const,
  };

  it("accepts no caller draft, repo, packet subset, or workspace locator", async () => {
    await expect(mintAcceptanceGatedGithubIssueApprovalRequest({
      eveSessionId: "eve-1",
      recordId: RECORD_ID,
      title: "caller title",
    } as never)).rejects.toThrow("requires only Eve session and Acceptance Record");
    await expect(resolveAcceptanceGatedGithubIssueApprovalRequest({
      eveSessionId: "eve-1",
      requestId: REQUEST_ID,
      workspaceId: WORKSPACE_ID,
    } as never)).rejects.toThrow("requires only Eve session and opaque request id");
    await expect(reserveAcceptanceGatedGithubIssueApprovalRequest({
      eveSessionId: "eve-1",
      requestId: REQUEST_ID,
      approvalId: APPROVAL_ID,
      repo: "attacker/repo",
    } as never)).rejects.toThrow("requires only Eve session, request, and approval");
    await expect(reportAcceptanceGatedGithubIssueApprovalPublication({
      eveSessionId: "eve-1",
      requestId: REQUEST_ID,
      approvalId: APPROVAL_ID,
      receipt,
      packetIds: ["subset"],
    } as never)).rejects.toThrow("requires only Eve session, request, approval, and exact receipt");
    await expect(reportAcceptanceGatedGithubIssueManualReconciliation({
      eveSessionId: "eve-1",
      requestId: REQUEST_ID,
      approvalId: APPROVAL_ID,
      reason: "retry_allowed",
    } as never)).rejects.toThrow("requires a closed server reason");
  });

  it("normalizes owner/repo case and rejects wrong-repo, query, fragment, or digest drift", () => {
    expect(normalizeAcceptanceGatedGithubIssueReceipt({
      receipt,
      repoNormalized: "acme/widgets",
      titleSha256: receipt.responseTitleSha256,
      bodySha256: receipt.responseBodySha256,
    })).toEqual({
      ...receipt,
      githubApiUrl: "https://api.github.com/repos/acme/widgets/issues/9",
      githubIssueUrl: "https://github.com/acme/widgets/issues/9",
    });
    for (const changed of [
      { githubIssueUrl: "https://github.com/other/repo/issues/9" },
      { githubIssueUrl: "https://github.com/acme/widgets/issues/9?tab=activity" },
      { githubIssueUrl: "https://github.com/acme/widgets/issues/9#issuecomment-1" },
      { githubApiUrl: "https://api.github.com/repos/other/repo/issues/9" },
      { responseBodySha256: "0".repeat(64) },
    ]) {
      expect(normalizeAcceptanceGatedGithubIssueReceipt({
        receipt: { ...receipt, ...changed },
        repoNormalized: "acme/widgets",
        titleSha256: receipt.responseTitleSha256,
        bodySha256: receipt.responseBodySha256,
      })).toBeNull();
    }
  });
});
