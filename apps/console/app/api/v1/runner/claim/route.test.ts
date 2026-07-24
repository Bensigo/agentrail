import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  claimQueueEntry: vi.fn(),
  touchApiKeyLastUsed: vi.fn(),
  hasActiveSelfHostedRunner: vi.fn(),
  getMcpConnectorKeys: vi.fn(),
  getInstallationToken: vi.fn(),
  getWorkspaceBudgetState: vi.fn(),
  sumWorkspaceSpendSince: vi.fn(),
  markBudgetExhaustedNotified: vi.fn(),
  // #1290 PR① — prepaid wallet admission. Defaulted to billing OFF in
  // beforeEach so every PRE-#1290 test above stays byte-identical (the wallet
  // block short-circuits before any wallet read).
  isBillingEnabled: vi.fn(),
  peekNextClaimEstimateUsd: vi.fn(),
  walletCanAdmit: vi.fn(),
}));
vi.mock("@agentrail/github-app", () => ({
  resolveGithubAppConfig: vi.fn(),
  botCommitIdentity: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  recordRunLifecycleEvent: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));
vi.mock("./notify", () => ({
  notifyWorkspaceBudgetExhausted: vi.fn(),
}));

import { GET } from "./route";
import {
  claimQueueEntry,
  touchApiKeyLastUsed,
  hasActiveSelfHostedRunner,
  getMcpConnectorKeys,
  getInstallationToken,
  getWorkspaceBudgetState,
  sumWorkspaceSpendSince,
  markBudgetExhaustedNotified,
  isBillingEnabled,
  peekNextClaimEstimateUsd,
  walletCanAdmit,
} from "@agentrail/db-postgres";
import { resolveGithubAppConfig, botCommitIdentity } from "@agentrail/github-app";
import { recordRunLifecycleEvent } from "@agentrail/db-clickhouse";
import { requireBearer } from "../../../../../lib/bearer-auth";
import { notifyWorkspaceBudgetExhausted } from "./notify";

const mockClaim = vi.mocked(claimQueueEntry);
const mockTouch = vi.mocked(touchApiKeyLastUsed);
const mockHasActiveSelfHosted = vi.mocked(hasActiveSelfHostedRunner);
const mockGetMcpKeys = vi.mocked(getMcpConnectorKeys);
const mockGetInstallationToken = vi.mocked(getInstallationToken);
const mockResolveGithubAppConfig = vi.mocked(resolveGithubAppConfig);
const mockBotCommitIdentity = vi.mocked(botCommitIdentity);
const mockRecordLifecycle = vi.mocked(recordRunLifecycleEvent);
const mockRequireBearer = vi.mocked(requireBearer);
const mockGetBudgetState = vi.mocked(getWorkspaceBudgetState);
const mockSumSpend = vi.mocked(sumWorkspaceSpendSince);
const mockMarkNotified = vi.mocked(markBudgetExhaustedNotified);
const mockNotifyBudgetExhausted = vi.mocked(notifyWorkspaceBudgetExhausted);
const mockIsBillingEnabled = vi.mocked(isBillingEnabled);
const mockPeekEstimate = vi.mocked(peekNextClaimEstimateUsd);
const mockWalletCanAdmit = vi.mocked(walletCanAdmit);

const CLAIM_BLOCKED_HEADER = "X-Agentrail-Claim-Blocked";

const WS = "ws-1";

function req(workspaceId?: string): NextRequest {
  const url =
    workspaceId === undefined
      ? "http://localhost/api/v1/runner/claim"
      : `http://localhost/api/v1/runner/claim?workspace_id=${workspaceId}`;
  return new NextRequest(url, {
    headers: { Authorization: "Bearer ar_test" },
  });
}

const WORK_ITEM = {
  id: "qe-1",
  workspace_id: WS,
  source: "cli",
  kind: "issue",
  external_id: "owner/repo#42",
  repo_url: "https://github.com/owner/repo",
  ref: "main",
  title: "Fix the thing",
  body: "body",
  repository_id: "repo-1",
  tier: 0,
};

function authResult(kind: "self_hosted" | "fleet" = "self_hosted") {
  return { apiKeyId: "key-1", workspaceId: WS, teamId: null, kind };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireBearer.mockResolvedValue(authResult() as never);
  mockTouch.mockResolvedValue(undefined as never);
  mockHasActiveSelfHosted.mockResolvedValue(false);
  mockClaim.mockResolvedValue(null);
  mockGetMcpKeys.mockResolvedValue({});
  // Default to "no installation bound" so pre-existing tests that assert
  // github_token:"" stay byte-identical. getInstallationToken mints a fresh
  // installation token on every call — no caching, no refresh state.
  mockGetInstallationToken.mockResolvedValue(null);
  // Default to "App env unconfigured" so pre-existing tests that assert no
  // git_bot_name/git_bot_email stay byte-identical.
  mockResolveGithubAppConfig.mockReturnValue({
    ok: false,
    missing: ["GITHUB_APP_ID"],
  } as never);
  mockBotCommitIdentity.mockImplementation(
    (slug: string, botUserId: string) =>
      ({
        name: `${slug}[bot]`,
        email: `${botUserId}+${slug}[bot]@users.noreply.github.com`,
      }) as never
  );
  mockRecordLifecycle.mockResolvedValue(undefined as never);
  // Uncapped by default (the product default — see #1269 PR ②a's own suite
  // below for every capped-path behavior) so every PRE-EXISTING test above
  // stays byte-identical: the budget block short-circuits before touching
  // sumWorkspaceSpendSince/markBudgetExhaustedNotified/notify at all.
  mockGetBudgetState.mockResolvedValue({
    monthlyBudgetUsd: null,
    budgetExhaustedNotifiedPeriod: null,
  });
  mockSumSpend.mockResolvedValue(0);
  mockMarkNotified.mockResolvedValue(false);
  mockNotifyBudgetExhausted.mockResolvedValue(undefined);
  // Billing OFF by default (the product default — see the #1290 suite below
  // for the ON paths) so every PRE-#1290 test stays byte-identical: the
  // wallet admission block short-circuits before touching
  // peekNextClaimEstimateUsd / walletCanAdmit at all.
  mockIsBillingEnabled.mockResolvedValue(false);
  mockPeekEstimate.mockResolvedValue(null);
  mockWalletCanAdmit.mockResolvedValue(true);
});

describe("GET /api/v1/runner/claim — baseline (pre-#1267 behavior)", () => {
  it("401 when requireBearer rejects", async () => {
    mockRequireBearer.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );

    const res = await GET(req(WS));

    expect(res.status).toBe(401);
    expect(mockTouch).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("400 when workspace_id query param is missing", async () => {
    const res = await GET(req(undefined));

    expect(res.status).toBe(400);
    expect(mockTouch).not.toHaveBeenCalled();
  });

  it("403 when the bearer's workspace differs from the requested workspace_id", async () => {
    mockRequireBearer.mockResolvedValue(authResult() as never);

    const res = await GET(req("some-other-ws"));

    expect(res.status).toBe(403);
    expect(mockTouch).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("touches api key last-used on every authorized request, before claiming", async () => {
    await GET(req(WS));

    expect(mockTouch).toHaveBeenCalledWith("key-1");
  });

  it("204 (empty) when nothing is queued", async () => {
    mockClaim.mockResolvedValue(null);

    const res = await GET(req(WS));

    expect(res.status).toBe(204);
    expect(mockRecordLifecycle).not.toHaveBeenCalled();
  });

  it("200 with the claimed item plus mcp_keys/github_token when something is queued", async () => {
    mockClaim.mockResolvedValue(WORK_ITEM as never);
    mockGetMcpKeys.mockResolvedValue({ linear: "mcp-key-1" });
    mockGetInstallationToken.mockResolvedValue("gh-token-1");

    const res = await GET(req(WS));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ...WORK_ITEM, mcp_keys: { linear: "mcp-key-1" }, github_token: "gh-token-1" });
    // A fresh installation token is minted for THIS workspace before it ships.
    expect(mockGetInstallationToken).toHaveBeenCalledWith(WS);
    expect(mockRecordLifecycle).toHaveBeenCalledWith(
      WS,
      WORK_ITEM.id,
      "run_started",
      expect.stringContaining(WORK_ITEM.external_id)
    );
  });

  it("#1275: carries estimated_budget_usd/model_override through when the claimed WorkItem has them", async () => {
    mockClaim.mockResolvedValue({
      ...WORK_ITEM,
      estimated_budget_usd: 12.5,
      model_override: "anthropic/claude-opus-4-8",
    } as never);

    const res = await GET(req(WS));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.estimated_budget_usd).toBe(12.5);
    expect(body.model_override).toBe("anthropic/claude-opus-4-8");
  });

  it("#1275: still 200s with both fields null — the dormant case every entry is in today", async () => {
    mockClaim.mockResolvedValue({
      ...WORK_ITEM,
      estimated_budget_usd: null,
      model_override: null,
    } as never);

    const res = await GET(req(WS));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.estimated_budget_usd).toBeNull();
    expect(body.model_override).toBeNull();
  });

  it("still returns 200 (mcp_keys: {}) when getMcpConnectorKeys throws — best-effort, never fails the claim", async () => {
    mockClaim.mockResolvedValue(WORK_ITEM as never);
    mockGetMcpKeys.mockRejectedValue(new Error("decrypt failed"));

    const res = await GET(req(WS));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.mcp_keys).toEqual({});
  });

  it("still returns 200 (github_token: '') when getInstallationToken throws — best-effort", async () => {
    mockClaim.mockResolvedValue(WORK_ITEM as never);
    mockGetInstallationToken.mockRejectedValue(new Error("mint failed"));

    const res = await GET(req(WS));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.github_token).toBe("");
  });

  it("mints a fresh installation token on every claim — no caching, no refresh state", async () => {
    mockClaim.mockResolvedValue(WORK_ITEM as never);
    mockGetInstallationToken.mockResolvedValue("gh-fresh-token");

    const res = await GET(req(WS));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.github_token).toBe("gh-fresh-token");
    expect(mockGetInstallationToken).toHaveBeenCalledWith(WS);
  });

  it("\"\" when the workspace has no GitHub App installation bound", async () => {
    mockClaim.mockResolvedValue(WORK_ITEM as never);
    mockGetInstallationToken.mockResolvedValue(null);

    const res = await GET(req(WS));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.github_token).toBe("");
  });

  it("\"\" when the mint fails — degrades to no token, the push-401 backstop covers it", async () => {
    mockClaim.mockResolvedValue(WORK_ITEM as never);
    mockGetInstallationToken.mockResolvedValue(null);

    const res = await GET(req(WS));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.github_token).toBe("");
  });

  it("adds git_bot_name/git_bot_email when the GitHub App env is configured", async () => {
    mockClaim.mockResolvedValue(WORK_ITEM as never);
    mockGetInstallationToken.mockResolvedValue("gh-fresh-token");
    mockResolveGithubAppConfig.mockReturnValue({
      ok: true,
      appId: "12345",
      privateKey: "pem",
      slug: "jace",
      botUserId: "98765",
    } as never);

    const res = await GET(req(WS));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.git_bot_name).toBe("jace[bot]");
    expect(body.git_bot_email).toBe("98765+jace[bot]@users.noreply.github.com");
    expect(mockBotCommitIdentity).toHaveBeenCalledWith("jace", "98765");
  });

  it("omits git_bot_name/git_bot_email entirely when the GitHub App env is unconfigured", async () => {
    mockClaim.mockResolvedValue(WORK_ITEM as never);
    mockGetInstallationToken.mockResolvedValue("gh-fresh-token");
    mockResolveGithubAppConfig.mockReturnValue({
      ok: false,
      missing: ["GITHUB_APP_ID"],
    } as never);

    const res = await GET(req(WS));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).not.toHaveProperty("git_bot_name");
    expect(body).not.toHaveProperty("git_bot_email");
    expect(mockBotCommitIdentity).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/runner/claim — self-hosted precedence guard (#1267 PR ① Locked-5)", () => {
  it("kind='self_hosted' NEVER calls hasActiveSelfHostedRunner — byte-identical to pre-#1267", async () => {
    mockRequireBearer.mockResolvedValue(authResult("self_hosted") as never);
    mockClaim.mockResolvedValue(WORK_ITEM as never);

    await GET(req(WS));

    expect(mockHasActiveSelfHosted).not.toHaveBeenCalled();
    expect(mockClaim).toHaveBeenCalledWith(WS);
  });

  it("kind='self_hosted' still claims normally even if a self-hosted runner is (hypothetically) reported active — the guard is fleet-only", async () => {
    mockRequireBearer.mockResolvedValue(authResult("self_hosted") as never);
    mockHasActiveSelfHosted.mockResolvedValue(true);
    mockClaim.mockResolvedValue(WORK_ITEM as never);

    const res = await GET(req(WS));

    expect(res.status).toBe(200);
    expect(mockClaim).toHaveBeenCalledWith(WS);
  });

  it("kind='fleet' + an active self-hosted runner -> 204, never calls claimQueueEntry", async () => {
    mockRequireBearer.mockResolvedValue(authResult("fleet") as never);
    mockHasActiveSelfHosted.mockResolvedValue(true);

    const res = await GET(req(WS));

    expect(res.status).toBe(204);
    expect(mockHasActiveSelfHosted).toHaveBeenCalledWith(WS);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("kind='fleet' + NO active self-hosted runner -> claims normally", async () => {
    mockRequireBearer.mockResolvedValue(authResult("fleet") as never);
    mockHasActiveSelfHosted.mockResolvedValue(false);
    mockClaim.mockResolvedValue(WORK_ITEM as never);

    const res = await GET(req(WS));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.id).toBe(WORK_ITEM.id);
    expect(mockClaim).toHaveBeenCalledWith(WS);
  });

  it("kind='fleet' + a gone-stale self-hosted runner (outside the presence window) -> claims normally", async () => {
    // hasActiveSelfHostedRunner itself owns the staleness window (last_used_at
    // within 1h); from the route's point of view this is indistinguishable
    // from "never had one" — both resolve false.
    mockRequireBearer.mockResolvedValue(authResult("fleet") as never);
    mockHasActiveSelfHosted.mockResolvedValue(false);
    mockClaim.mockResolvedValue(null);

    const res = await GET(req(WS));

    expect(mockHasActiveSelfHosted).toHaveBeenCalledWith(WS);
    expect(mockClaim).toHaveBeenCalledWith(WS);
    expect(res.status).toBe(204); // nothing queued, but reached via claimQueueEntry, not the guard
  });

  it("touches api key last-used even when the fleet guard subsequently returns 204", async () => {
    mockRequireBearer.mockResolvedValue(authResult("fleet") as never);
    mockHasActiveSelfHosted.mockResolvedValue(true);

    await GET(req(WS));

    expect(mockTouch).toHaveBeenCalledWith("key-1");
  });
});

describe("GET /api/v1/runner/claim — workspace monthly-budget ceiling (#1269 PR ②a)", () => {
  it("uncapped (monthly_budget_usd null, the default) — claims normally, never runs the spend SUM", async () => {
    mockGetBudgetState.mockResolvedValue({
      monthlyBudgetUsd: null,
      budgetExhaustedNotifiedPeriod: null,
    });
    mockClaim.mockResolvedValue(WORK_ITEM as never);

    const res = await GET(req(WS));

    expect(res.status).toBe(200);
    // The whole point of the NULL short-circuit: zero EXTRA queries beyond
    // the one cheap ceiling lookup itself.
    expect(mockSumSpend).not.toHaveBeenCalled();
    expect(mockMarkNotified).not.toHaveBeenCalled();
    expect(mockNotifyBudgetExhausted).not.toHaveBeenCalled();
    expect(mockClaim).toHaveBeenCalledWith(WS);
    expect(res.headers.get(CLAIM_BLOCKED_HEADER)).toBeNull();
  });

  it("capped, spend below ceiling — claims normally, no header", async () => {
    mockGetBudgetState.mockResolvedValue({
      monthlyBudgetUsd: 10,
      budgetExhaustedNotifiedPeriod: null,
    });
    mockSumSpend.mockResolvedValue(4.5);
    mockClaim.mockResolvedValue(WORK_ITEM as never);

    const res = await GET(req(WS));

    expect(res.status).toBe(200);
    expect(mockSumSpend).toHaveBeenCalledWith(WS, expect.any(String), expect.any(String));
    expect(mockMarkNotified).not.toHaveBeenCalled();
    expect(mockClaim).toHaveBeenCalledWith(WS);
    expect(res.headers.get(CLAIM_BLOCKED_HEADER)).toBeNull();
  });

  it("capped, spend at/above ceiling — 204 + the blocked header, claimQueueEntry never called", async () => {
    mockGetBudgetState.mockResolvedValue({
      monthlyBudgetUsd: 10,
      budgetExhaustedNotifiedPeriod: null,
    });
    mockSumSpend.mockResolvedValue(10);
    mockMarkNotified.mockResolvedValue(true);

    const res = await GET(req(WS));

    expect(res.status).toBe(204);
    expect(res.headers.get(CLAIM_BLOCKED_HEADER)).toBe("workspace-budget");
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockRecordLifecycle).not.toHaveBeenCalled();
  });

  it("sends the notice ONLY when markBudgetExhaustedNotified flips (the CAS), never on a read-only check", async () => {
    mockGetBudgetState.mockResolvedValue({
      monthlyBudgetUsd: 10,
      budgetExhaustedNotifiedPeriod: null,
    });
    mockSumSpend.mockResolvedValue(15);
    mockMarkNotified.mockResolvedValue(true);

    await GET(req(WS));

    expect(mockMarkNotified).toHaveBeenCalledWith(WS, expect.any(String));
    expect(mockNotifyBudgetExhausted).toHaveBeenCalledWith(WS, 15, 10);
  });

  it("two consecutive exceeded polls — exactly one notify send (the second poll's CAS reports already-notified)", async () => {
    mockGetBudgetState.mockResolvedValue({
      monthlyBudgetUsd: 10,
      budgetExhaustedNotifiedPeriod: null,
    });
    mockSumSpend.mockResolvedValue(12);
    mockMarkNotified.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const first = await GET(req(WS));
    const second = await GET(req(WS));

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(first.headers.get(CLAIM_BLOCKED_HEADER)).toBe("workspace-budget");
    expect(second.headers.get(CLAIM_BLOCKED_HEADER)).toBe("workspace-budget");
    expect(mockMarkNotified).toHaveBeenCalledTimes(2);
    expect(mockNotifyBudgetExhausted).toHaveBeenCalledTimes(1);
  });

  it("a notify-send failure still 204s with the header — best-effort, never fails the claim response", async () => {
    mockGetBudgetState.mockResolvedValue({
      monthlyBudgetUsd: 10,
      budgetExhaustedNotifiedPeriod: null,
    });
    mockSumSpend.mockResolvedValue(10);
    mockMarkNotified.mockResolvedValue(true);
    mockNotifyBudgetExhausted.mockRejectedValue(new Error("telegram down"));

    const res = await GET(req(WS));

    expect(res.status).toBe(204);
    expect(res.headers.get(CLAIM_BLOCKED_HEADER)).toBe("workspace-budget");
  });

  it("blocks a self_hosted bearer too — the ceiling is a workspace property, not a fleet-only guard", async () => {
    mockRequireBearer.mockResolvedValue(authResult("self_hosted") as never);
    mockGetBudgetState.mockResolvedValue({
      monthlyBudgetUsd: 10,
      budgetExhaustedNotifiedPeriod: null,
    });
    mockSumSpend.mockResolvedValue(10);

    const res = await GET(req(WS));

    expect(res.status).toBe(204);
    expect(res.headers.get(CLAIM_BLOCKED_HEADER)).toBe("workspace-budget");
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("blocks a fleet bearer too (with no active self-hosted runner in the way)", async () => {
    mockRequireBearer.mockResolvedValue(authResult("fleet") as never);
    mockHasActiveSelfHosted.mockResolvedValue(false);
    mockGetBudgetState.mockResolvedValue({
      monthlyBudgetUsd: 10,
      budgetExhaustedNotifiedPeriod: null,
    });
    mockSumSpend.mockResolvedValue(10);

    const res = await GET(req(WS));

    expect(res.status).toBe(204);
    expect(res.headers.get(CLAIM_BLOCKED_HEADER)).toBe("workspace-budget");
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("does NOT set the header on an ordinary nothing-queued 204 (uncapped)", async () => {
    mockClaim.mockResolvedValue(null);

    const res = await GET(req(WS));

    expect(res.status).toBe(204);
    expect(res.headers.get(CLAIM_BLOCKED_HEADER)).toBeNull();
  });

  it("does NOT set the header on an ordinary nothing-queued 204 (capped, but under the ceiling)", async () => {
    mockGetBudgetState.mockResolvedValue({
      monthlyBudgetUsd: 10,
      budgetExhaustedNotifiedPeriod: null,
    });
    mockSumSpend.mockResolvedValue(2);
    mockClaim.mockResolvedValue(null);

    const res = await GET(req(WS));

    expect(res.status).toBe(204);
    expect(res.headers.get(CLAIM_BLOCKED_HEADER)).toBeNull();
  });

  it("computes the spend window as the current UTC calendar month (cross-month-boundary safe)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-31T23:59:00.000Z"));
    mockGetBudgetState.mockResolvedValue({
      monthlyBudgetUsd: 10,
      budgetExhaustedNotifiedPeriod: null,
    });
    mockSumSpend.mockResolvedValue(0);
    mockClaim.mockResolvedValue(null);

    try {
      await GET(req(WS));
    } finally {
      vi.useRealTimers();
    }

    expect(mockSumSpend).toHaveBeenCalledWith(
      WS,
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z"
    );
    expect(mockMarkNotified).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/runner/claim — prepaid wallet admission (#1290 PR ①)", () => {
  it("billing OFF (the default) — never reads the wallet, claims normally, no header", async () => {
    mockIsBillingEnabled.mockResolvedValue(false);
    mockClaim.mockResolvedValue(WORK_ITEM as never);

    const res = await GET(req(WS));

    expect(res.status).toBe(200);
    // The whole flag-OFF guarantee: not a single wallet read happens.
    expect(mockPeekEstimate).not.toHaveBeenCalled();
    expect(mockWalletCanAdmit).not.toHaveBeenCalled();
    expect(mockClaim).toHaveBeenCalledWith(WS);
    expect(res.headers.get(CLAIM_BLOCKED_HEADER)).toBeNull();
  });

  it("billing ON, balance covers the next entry's estimate — claims normally, no header", async () => {
    mockIsBillingEnabled.mockResolvedValue(true);
    mockPeekEstimate.mockResolvedValue(3.5);
    mockWalletCanAdmit.mockResolvedValue(true);
    mockClaim.mockResolvedValue(WORK_ITEM as never);

    const res = await GET(req(WS));

    expect(res.status).toBe(200);
    expect(mockPeekEstimate).toHaveBeenCalledWith(WS);
    expect(mockWalletCanAdmit).toHaveBeenCalledWith(WS, 3.5);
    expect(mockClaim).toHaveBeenCalledWith(WS);
    expect(res.headers.get(CLAIM_BLOCKED_HEADER)).toBeNull();
  });

  it("billing ON, balance cannot cover the estimate — 204 + wallet-balance header, claimQueueEntry never called (nothing killed, next claim blocks)", async () => {
    mockIsBillingEnabled.mockResolvedValue(true);
    mockPeekEstimate.mockResolvedValue(9.0);
    mockWalletCanAdmit.mockResolvedValue(false);

    const res = await GET(req(WS));

    expect(res.status).toBe(204);
    expect(res.headers.get(CLAIM_BLOCKED_HEADER)).toBe("wallet-balance");
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockRecordLifecycle).not.toHaveBeenCalled();
  });

  it("billing ON, next queued entry has no estimate (null) — un-gateable, admits normally", async () => {
    mockIsBillingEnabled.mockResolvedValue(true);
    mockPeekEstimate.mockResolvedValue(null);
    mockClaim.mockResolvedValue(WORK_ITEM as never);

    const res = await GET(req(WS));

    expect(res.status).toBe(200);
    // A null estimate means we can't gate — walletCanAdmit is never consulted.
    expect(mockWalletCanAdmit).not.toHaveBeenCalled();
    expect(mockClaim).toHaveBeenCalledWith(WS);
    expect(res.headers.get(CLAIM_BLOCKED_HEADER)).toBeNull();
  });

  it("billing ON but a wallet read throws — best-effort: falls through to a normal claim, never strands work", async () => {
    mockIsBillingEnabled.mockResolvedValue(true);
    mockPeekEstimate.mockRejectedValue(new Error("db blip"));
    mockClaim.mockResolvedValue(WORK_ITEM as never);

    const res = await GET(req(WS));

    expect(res.status).toBe(200);
    expect(mockClaim).toHaveBeenCalledWith(WS);
    expect(res.headers.get(CLAIM_BLOCKED_HEADER)).toBeNull();
  });

  it("the wallet gate sits AFTER the workspace-budget ceiling — a ceiling-blocked claim never reaches the wallet read", async () => {
    mockIsBillingEnabled.mockResolvedValue(true);
    mockGetBudgetState.mockResolvedValue({
      monthlyBudgetUsd: 10,
      budgetExhaustedNotifiedPeriod: null,
    });
    mockSumSpend.mockResolvedValue(10);

    const res = await GET(req(WS));

    expect(res.status).toBe(204);
    expect(res.headers.get(CLAIM_BLOCKED_HEADER)).toBe("workspace-budget");
    // The budget gate returned first; the wallet block was never reached.
    expect(mockPeekEstimate).not.toHaveBeenCalled();
    expect(mockWalletCanAdmit).not.toHaveBeenCalled();
  });
});
