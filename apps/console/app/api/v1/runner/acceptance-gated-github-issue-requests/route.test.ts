import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  mintAcceptanceGatedGithubIssueApprovalRequest: vi.fn(),
  resolveAcceptanceGatedGithubIssueApprovalRequest: vi.fn(),
  reserveAcceptanceGatedGithubIssueApprovalRequest: vi.fn(),
  reportAcceptanceGatedGithubIssueApprovalPublication: vi.fn(),
  reportAcceptanceGatedGithubIssueManualReconciliation: vi.fn(),
}));

import { POST as mint } from "./route";
import { POST as resolve } from "./[requestId]/route";
import { POST as reserve } from "./[requestId]/reserve/route";
import { POST as publish } from "./[requestId]/published/route";
import { POST as reconcile } from "./[requestId]/reconciliation/route";
import {
  mintAcceptanceGatedGithubIssueApprovalRequest,
  resolveAcceptanceGatedGithubIssueApprovalRequest,
  reserveAcceptanceGatedGithubIssueApprovalRequest,
  reportAcceptanceGatedGithubIssueApprovalPublication,
  reportAcceptanceGatedGithubIssueManualReconciliation,
} from "@agentrail/db-postgres";

const SECRET = "runner-secret";
const ORIGINAL_SECRET = process.env["JACE_CONSOLE_TOKEN"];
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const RECORD_ID = "22222222-2222-4222-8222-222222222222";
const APPROVAL_ID = "33333333-3333-4333-8333-333333333333";
const mockMint = vi.mocked(mintAcceptanceGatedGithubIssueApprovalRequest);
const mockResolve = vi.mocked(resolveAcceptanceGatedGithubIssueApprovalRequest);
const mockReserve = vi.mocked(reserveAcceptanceGatedGithubIssueApprovalRequest);
const mockPublish = vi.mocked(reportAcceptanceGatedGithubIssueApprovalPublication);
const mockReconcile = vi.mocked(reportAcceptanceGatedGithubIssueManualReconciliation);

function request(path: string, body: unknown, authenticated = true) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: `Bearer ${SECRET}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ requestId: REQUEST_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  process.env["JACE_CONSOLE_TOKEN"] = SECRET;
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env["JACE_CONSOLE_TOKEN"];
  else process.env["JACE_CONSOLE_TOKEN"] = ORIGINAL_SECRET;
});

describe("Jace gated issue custody routes", () => {
  it("authenticates before minting and exposes only opaque request identity", async () => {
    const unauthorized = await mint(request(
      "/api/v1/runner/acceptance-gated-github-issue-requests",
      { eveSessionId: "eve-1", recordId: RECORD_ID },
      false,
    ));
    expect(unauthorized.status).toBe(401);
    expect(mockMint).not.toHaveBeenCalled();

    mockMint.mockResolvedValue({
      kind: "ready",
      request: { id: REQUEST_ID, status: "draft", title: "must stay hidden" },
    } as never);
    const response = await mint(request(
      "/api/v1/runner/acceptance-gated-github-issue-requests",
      { eveSessionId: "eve-1", recordId: RECORD_ID },
    ));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      kind: "ready",
      request: { id: REQUEST_ID, status: "draft" },
    });
    expect(mockMint).toHaveBeenCalledWith({ eveSessionId: "eve-1", recordId: RECORD_ID });
  });

  it("rejects extra mint fields before database custody", async () => {
    const response = await mint(request(
      "/api/v1/runner/acceptance-gated-github-issue-requests",
      { eveSessionId: "eve-1", recordId: RECORD_ID, title: "caller draft" },
    ));
    expect(response.status).toBe(400);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("rejects malformed identities and receipt fields before database custody", async () => {
    const malformedMint = await mint(request(
      "/api/v1/runner/acceptance-gated-github-issue-requests",
      { eveSessionId: "eve-1", recordId: "not-a-record" },
    ));
    expect(malformedMint.status).toBe(400);
    expect(mockMint).not.toHaveBeenCalled();

    const malformedResolve = await resolve(request(
      "/api/v1/runner/acceptance-gated-github-issue-requests/not-a-request",
      { eveSessionId: "eve-1" },
    ), { params: Promise.resolve({ requestId: "not-a-request" }) });
    expect(malformedResolve.status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();

    const malformedReceipt = await publish(request(
      `/api/v1/runner/acceptance-gated-github-issue-requests/${REQUEST_ID}/published`,
      {
        eveSessionId: "eve-1",
        approvalId: APPROVAL_ID,
        receipt: {
          kind: "github_201",
          httpStatus: 201,
          githubIssueId: "9",
          githubIssueNumber: 4,
          githubApiUrl: "https://api.github.com/repos/acme/widgets/issues/4",
          githubIssueUrl: "https://github.com/acme/widgets/issues/4?attacker=1",
          githubRequestId: "REQ:4",
          responseTitleSha256: "a".repeat(64),
          responseBodySha256: "b".repeat(64),
          state: "open",
          callerDraft: "not accepted",
        },
      },
    ), params);
    expect(malformedReceipt.status).toBe(400);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("resolves by exact Eve session plus opaque request id", async () => {
    mockResolve.mockResolvedValue({ kind: "ready", request: { id: REQUEST_ID } } as never);
    const response = await resolve(request(
      `/api/v1/runner/acceptance-gated-github-issue-requests/${REQUEST_ID}`,
      { eveSessionId: "eve-1" },
    ), params);
    expect(response.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith({ eveSessionId: "eve-1", requestId: REQUEST_ID });
  });

  it("does not grant a CLI permit for replayed or conflicting reservation", async () => {
    mockReserve.mockResolvedValue({ kind: "already_reserved" } as never);
    const response = await reserve(request(
      `/api/v1/runner/acceptance-gated-github-issue-requests/${REQUEST_ID}/reserve`,
      { eveSessionId: "eve-1", approvalId: APPROVAL_ID },
    ), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ kind: "already_reserved" });
    expect(mockReserve).toHaveBeenCalledWith({
      eveSessionId: "eve-1",
      approvalId: APPROVAL_ID,
      requestId: REQUEST_ID,
    });
  });

  it("binds the publication receipt to request, approval, and Eve session", async () => {
    const receipt = {
      kind: "github_201" as const,
      httpStatus: 201 as const,
      githubIssueId: "9",
      githubIssueNumber: 4,
      githubApiUrl: "https://api.github.com/repos/acme/widgets/issues/4",
      githubIssueUrl: "https://github.com/acme/widgets/issues/4",
      githubRequestId: "REQ:4",
      responseTitleSha256: "a".repeat(64),
      responseBodySha256: "b".repeat(64),
      state: "open" as const,
    };
    mockPublish.mockResolvedValue({ kind: "published", issue: {} } as never);
    const response = await publish(request(
      `/api/v1/runner/acceptance-gated-github-issue-requests/${REQUEST_ID}/published`,
      { eveSessionId: "eve-1", approvalId: APPROVAL_ID, receipt },
    ), params);
    expect(response.status).toBe(201);
    expect(mockPublish).toHaveBeenCalledWith({
      eveSessionId: "eve-1",
      approvalId: APPROVAL_ID,
      requestId: REQUEST_ID,
      receipt,
    });
  });

  it("records a closed manual-reconciliation reason without accepting extra fields", async () => {
    mockReconcile.mockResolvedValue({ kind: "recorded" } as never);
    const response = await reconcile(request(
      `/api/v1/runner/acceptance-gated-github-issue-requests/${REQUEST_ID}/reconciliation`,
      {
        eveSessionId: "eve-1",
        approvalId: APPROVAL_ID,
        reason: "external_issue_wrong_repo",
        observedIssueUrl: "https://github.com/other/repo/issues/4",
      },
    ), params);
    expect(response.status).toBe(201);
    expect(mockReconcile).toHaveBeenCalledWith({
      eveSessionId: "eve-1",
      approvalId: APPROVAL_ID,
      requestId: REQUEST_ID,
      reason: "external_issue_wrong_repo",
      observedIssueUrl: "https://github.com/other/repo/issues/4",
    });

    const invalid = await reconcile(request(
      `/api/v1/runner/acceptance-gated-github-issue-requests/${REQUEST_ID}/reconciliation`,
      {
        eveSessionId: "eve-1",
        approvalId: APPROVAL_ID,
        reason: "external_issue_wrong_repo",
        title: "not accepted",
      },
    ), params);
    expect(invalid.status).toBe(400);
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });
});
