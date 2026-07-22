import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * #1290 PR② — the prepaid wallet COMPLETION CHARGE wiring in the runner-result
 * route, isolated from the other result-route suites (same isolation pattern
 * as route.run-outcome-capture.test.ts). Asserts: the charge fires ONLY when
 * the workspace billing flag is ON, fires on EVERY terminal transition, prices
 * the REAL token cost (the ClickHouse-first `costUsd`, converted to integer
 * cents), is idempotent per run (delegated to chargeCompletedTask's own DB
 * guard), and is entirely best-effort (never changes the route's 202).
 */
vi.mock("@agentrail/db-postgres", async (importActual) => {
  const actual = await importActual<typeof import("@agentrail/db-postgres")>();
  return {
    ONBOARD_EXTERNAL_ID_PREFIX: actual.ONBOARD_EXTERNAL_ID_PREFIX,
    recordRunnerResult: vi.fn(),
    touchApiKeyLastUsed: vi.fn(),
    latestTelegramSessionForWorkspace: vi.fn(),
    getMergePermission: vi.fn(),
    getGithubToken: vi.fn(),
    recordRunOutcome: vi.fn(),
    mapTerminalStateToRunOutcome: actual.mapTerminalStateToRunOutcome,
    isBillingEnabled: vi.fn(),
    chargeCompletedTask: vi.fn(),
    // Real+pure: the actual float→cents boundary, so assertions check the
    // ACTUAL converted cents, not a meaningless mock return.
    usdToCents: actual.usdToCents,
  };
});
vi.mock("@agentrail/db-clickhouse", () => ({
  insertFailureEvents: vi.fn(),
  recordRunLifecycleEvent: vi.fn(),
  getRunCosts: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));
vi.mock("./notify", () => ({
  notifyRunOutcome: vi.fn(),
}));
vi.mock("../../../../../lib/telegram-system-message", () => ({
  sendSystemTelegramMessage: vi.fn(),
}));
vi.mock("../../../../../lib/alignment-reconciler", () => ({
  reconcileAlignmentBriefs: vi.fn(),
}));

import { POST } from "./route";
import {
  recordRunnerResult,
  touchApiKeyLastUsed,
  getMergePermission,
  getGithubToken,
  recordRunOutcome,
  isBillingEnabled,
  chargeCompletedTask,
  type RecordRunnerResult,
} from "@agentrail/db-postgres";
import {
  recordRunLifecycleEvent,
  getRunCosts,
  type RunCostRow,
} from "@agentrail/db-clickhouse";
import { requireBearer } from "../../../../../lib/bearer-auth";
import { reconcileAlignmentBriefs } from "../../../../../lib/alignment-reconciler";

const WS = "00000000-0000-0000-0000-000000000001";

const mockRecordRunnerResult = vi.mocked(recordRunnerResult);
const mockRecordRunOutcome = vi.mocked(recordRunOutcome);
const mockGetRunCosts = vi.mocked(getRunCosts);
const mockIsBillingEnabled = vi.mocked(isBillingEnabled);
const mockChargeCompletedTask = vi.mocked(chargeCompletedTask);

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/result", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok" },
    body: JSON.stringify(body),
  });
}

function costRow(
  phase: string,
  model: string,
  costUsd: number,
  occurredAt: string
): RunCostRow {
  return {
    phase,
    model,
    input_tokens: 0,
    output_tokens: 0,
    cache_tokens: 0,
    tokens: 0,
    cost_usd: costUsd,
    occurred_at: occurredAt,
  };
}

function recordRunnerResultOf(
  overrides: Partial<RecordRunnerResult>
): RecordRunnerResult {
  return {
    updated: true,
    terminalState: null,
    externalId: "acme/widgets#7",
    taskType: null,
    transitioned: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBearer).mockResolvedValue({ workspaceId: WS, apiKeyId: "key-1" } as never);
  vi.mocked(touchApiKeyLastUsed).mockResolvedValue(undefined as never);
  vi.mocked(getMergePermission).mockResolvedValue(false);
  vi.mocked(getGithubToken).mockResolvedValue(null);
  vi.mocked(recordRunLifecycleEvent).mockResolvedValue(undefined as never);
  vi.mocked(reconcileAlignmentBriefs).mockResolvedValue([] as never);
  mockGetRunCosts.mockResolvedValue([]);
  mockRecordRunOutcome.mockResolvedValue(undefined);
  // Billing OFF by default; the ON cases opt in explicitly.
  mockIsBillingEnabled.mockResolvedValue(false);
  mockChargeCompletedTask.mockResolvedValue({
    charged: true,
    amountUsdCents: -180,
    priceCents: 180,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/v1/runner/result — prepaid wallet completion charge (#1290 PR②)", () => {
  it("billing OFF (the default): a green terminal records the outcome but posts NO wallet charge", async () => {
    mockIsBillingEnabled.mockResolvedValue(false);
    mockRecordRunnerResult.mockResolvedValue(
      recordRunnerResultOf({ terminalState: "green" })
    );
    mockGetRunCosts.mockResolvedValue([
      costRow("execute", "anthropic/claude-sonnet-5", 1.5, "2026-01-01 00:00:00"),
    ]);

    const res = await POST(req({ id: "run-off", workspace_id: WS, status: "green" }));

    expect(res.status).toBe(202);
    expect(mockRecordRunOutcome).toHaveBeenCalled();
    expect(mockChargeCompletedTask).not.toHaveBeenCalled();
  });

  it("billing ON: charges the task priced from the REAL token cost (ClickHouse-first cost → integer cents), keyed by run id + task ref", async () => {
    mockIsBillingEnabled.mockResolvedValue(true);
    mockRecordRunnerResult.mockResolvedValue(
      recordRunnerResultOf({ terminalState: "green", externalId: "acme/widgets#7" })
    );
    mockGetRunCosts.mockResolvedValue([
      costRow("execute", "anthropic/claude-sonnet-5", 1.2, "2026-01-01 00:00:00"),
      costRow("verify", "anthropic/claude-sonnet-5", 0.3, "2026-01-01 00:01:00"),
    ]);

    const res = await POST(req({ id: "run-1", workspace_id: WS, status: "green" }));

    expect(res.status).toBe(202);
    // costUsd summed to 1.5 → usdToCents → 150 integer cents.
    expect(mockChargeCompletedTask).toHaveBeenCalledWith({
      workspaceId: WS,
      runId: "run-1",
      taskRef: "acme/widgets#7",
      actualTokenCostCents: 150,
    });
  });

  it("billing ON: charges on a human_review terminal too (every terminal, a task that ran consumed real compute)", async () => {
    mockIsBillingEnabled.mockResolvedValue(true);
    mockRecordRunnerResult.mockResolvedValue(
      recordRunnerResultOf({ terminalState: "escalated-to-human" })
    );
    mockGetRunCosts.mockResolvedValue([]);

    await POST(req({ id: "run-2", workspace_id: WS, status: "error", cost_usd: 0.75 }));

    expect(mockChargeCompletedTask).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-2", actualTokenCostCents: 75 })
    );
  });

  it("billing ON: never charges on a non-terminal 'running' heartbeat", async () => {
    mockIsBillingEnabled.mockResolvedValue(true);
    mockRecordRunnerResult.mockResolvedValue(
      recordRunnerResultOf({ terminalState: null })
    );

    await POST(req({ id: "run-3", workspace_id: WS, status: "running" }));

    expect(mockChargeCompletedTask).not.toHaveBeenCalled();
  });

  it("BEST-EFFORT: chargeCompletedTask throwing never changes the 202, and never disturbs the outcome capture", async () => {
    mockIsBillingEnabled.mockResolvedValue(true);
    mockRecordRunnerResult.mockResolvedValue(
      recordRunnerResultOf({ terminalState: "green" })
    );
    mockChargeCompletedTask.mockRejectedValue(new Error("wallet db down"));

    const res = await POST(req({ id: "run-4", workspace_id: WS, status: "green" }));

    expect(res.status).toBe(202);
    expect(mockRecordRunOutcome).toHaveBeenCalled(); // ran BEFORE the charge
    expect(console.error).toHaveBeenCalled();
  });

  it("BEST-EFFORT: isBillingEnabled throwing never changes the 202", async () => {
    mockIsBillingEnabled.mockRejectedValue(new Error("flag read failed"));
    mockRecordRunnerResult.mockResolvedValue(
      recordRunnerResultOf({ terminalState: "green" })
    );

    const res = await POST(req({ id: "run-5", workspace_id: WS, status: "green" }));

    expect(res.status).toBe(202);
    expect(mockChargeCompletedTask).not.toHaveBeenCalled();
  });
});
