import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * #1338 PR① — the model-selection learning loop's FUEL, in isolation from
 * `route.test.ts` (which does not mock `lib/alignment-reconciler` at all, so
 * the reconciler call there throws on its own — see that file's own note;
 * this file mirrors `route.reconciler-trigger.test.ts`'s isolation pattern
 * for the SAME reason). Asserts the wiring the report describes: the capture
 * fires ONLY on a terminal transition, resolves the execute model + cost
 * from ClickHouse `cost_events` (via `getRunCosts`), maps the outcome, and
 * is entirely best-effort (never changes the route's 202).
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
    // Real+pure (a 3-way switch) — assertions below check the ACTUAL mapped
    // outcome string, not a meaningless mock return.
    mapTerminalStateToRunOutcome: actual.mapTerminalStateToRunOutcome,
    // #1290 PR② — wallet completion charge. Defaults billing OFF (falsy
    // isBillingEnabled) so this capture suite is byte-identical to pre-#1290;
    // usdToCents is real+pure. The wallet charge has its own dedicated suite
    // (route.wallet-charge.test.ts).
    isBillingEnabled: vi.fn(),
    chargeCompletedTask: vi.fn(),
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

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/result", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok" },
    body: JSON.stringify(body),
  });
}

/** A minimal well-formed cost_events row for a given phase/model/cost. */
function costRow(phase: string, model: string, costUsd: number, occurredAt: string): RunCostRow {
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
    // #1343: every test in this suite is a genuine (non-duplicate) terminal —
    // the run-outcome capture block this file tests is unaffected by the
    // #1343 duplicate-green guard (only the merge-attempt/notify blocks in
    // route.ts are gated on it), so `true` keeps this suite's fixture
    // byte-identical to a real first-time result unless a test overrides it.
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
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/v1/runner/result — run-outcome capture (#1338 PR①)", () => {
  it("fires on a green terminal: maps outcome to 'success', resolves the LAST execute-phase model, sums cost_events cost", async () => {
    mockRecordRunnerResult.mockResolvedValue(
      recordRunnerResultOf({ terminalState: "green", taskType: "ui" })
    );
    mockGetRunCosts.mockResolvedValue([
      costRow("execute", "anthropic/claude-sonnet-5", 1.2, "2026-01-01 00:00:00"),
      costRow("verify", "anthropic/claude-sonnet-5", 0.3, "2026-01-01 00:01:00"),
    ]);

    const res = await POST(req({ id: "run-1", workspace_id: WS, status: "green" }));

    expect(res.status).toBe(202);
    expect(mockGetRunCosts).toHaveBeenCalledWith(WS, "run-1");
    expect(mockRecordRunOutcome).toHaveBeenCalledWith({
      queueEntryId: "run-1",
      workspaceId: WS,
      taskType: "ui",
      executeModel: "anthropic/claude-sonnet-5",
      outcome: "success",
      costUsd: 1.5,
    });
  });

  it("fires on an escalated-to-human terminal: maps outcome to 'human_review'", async () => {
    mockRecordRunnerResult.mockResolvedValue(
      recordRunnerResultOf({ terminalState: "escalated-to-human" })
    );

    await POST(req({ id: "run-2", workspace_id: WS, status: "error" }));

    expect(mockRecordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "human_review" })
    );
  });

  it("FALLBACK (no reported model): picks the LAST (most recent) execute-phase model when a retry escalated across attempts — the model that produced THIS outcome, not the first one tried", async () => {
    mockRecordRunnerResult.mockResolvedValue(recordRunnerResultOf({ terminalState: "green" }));
    mockGetRunCosts.mockResolvedValue([
      costRow("execute", "anthropic/claude-haiku-4-5", 0.1, "2026-01-01 00:00:00"),
      costRow("execute", "anthropic/claude-sonnet-5", 0.9, "2026-01-01 00:05:00"),
    ]);

    // No execute_model in the body → the ClickHouse-reconstruction fallback runs.
    await POST(req({ id: "run-3", workspace_id: WS, status: "green" }));

    expect(mockRecordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ executeModel: "anthropic/claude-sonnet-5" })
    );
  });

  it("executeModel is null only when the runner reported NO model AND no execute-phase cost_event exists (e.g. a hosted-refusal that never reached execute)", async () => {
    mockRecordRunnerResult.mockResolvedValue(
      recordRunnerResultOf({ terminalState: "escalated-to-human" })
    );
    mockGetRunCosts.mockResolvedValue([]);

    await POST(req({ id: "run-4", workspace_id: WS, status: "error" }));

    expect(mockRecordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ executeModel: null })
    );
  });

  // #1338 PR① fix round — the authoritative reported-model path (the fix).
  it("uses the runner's reported execute_model EVEN WHEN ClickHouse has no execute cost_event (the dropped-cost-event data-loss path this fix closes)", async () => {
    mockRecordRunnerResult.mockResolvedValue(
      recordRunnerResultOf({ terminalState: "green", taskType: "ui" })
    );
    // Simulate the drop: cost_push.py's execute cost_event never landed, so
    // ClickHouse has NOTHING — the reconstruction would have written null.
    mockGetRunCosts.mockResolvedValue([]);

    await POST(
      req({
        id: "run-drop",
        workspace_id: WS,
        status: "green",
        execute_model: "anthropic/claude-sonnet-5",
      })
    );

    expect(mockRecordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ executeModel: "anthropic/claude-sonnet-5" })
    );
  });

  it("the reported execute_model WINS over a ClickHouse execute row (reported is authoritative, ClickHouse is fallback-only)", async () => {
    mockRecordRunnerResult.mockResolvedValue(recordRunnerResultOf({ terminalState: "green" }));
    mockGetRunCosts.mockResolvedValue([
      costRow("execute", "anthropic/claude-haiku-4-5", 0.5, "2026-01-01 00:00:00"),
    ]);

    await POST(
      req({
        id: "run-precedence",
        workspace_id: WS,
        status: "green",
        execute_model: "anthropic/claude-sonnet-5",
      })
    );

    expect(mockRecordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ executeModel: "anthropic/claude-sonnet-5" })
    );
  });

  it("falls back to ClickHouse when the reported execute_model is an empty string (older runner sends '' — treated as absent)", async () => {
    mockRecordRunnerResult.mockResolvedValue(recordRunnerResultOf({ terminalState: "green" }));
    mockGetRunCosts.mockResolvedValue([
      costRow("execute", "anthropic/claude-haiku-4-5", 0.5, "2026-01-01 00:00:00"),
    ]);

    await POST(
      req({ id: "run-empty", workspace_id: WS, status: "green", execute_model: "" })
    );

    expect(mockRecordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ executeModel: "anthropic/claude-haiku-4-5" })
    );
  });

  it("falls back to the runner's self-reported cost_usd when ClickHouse has no cost_events yet", async () => {
    mockRecordRunnerResult.mockResolvedValue(recordRunnerResultOf({ terminalState: "green" }));
    mockGetRunCosts.mockResolvedValue([]);

    await POST(req({ id: "run-5", workspace_id: WS, status: "green", cost_usd: 2.75 }));

    expect(mockRecordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ costUsd: 2.75 })
    );
  });

  it("cost defaults to 0 when NEITHER ClickHouse nor the report carries a cost figure", async () => {
    mockRecordRunnerResult.mockResolvedValue(recordRunnerResultOf({ terminalState: "green" }));
    mockGetRunCosts.mockResolvedValue([]);

    await POST(req({ id: "run-6", workspace_id: WS, status: "green" }));

    expect(mockRecordRunOutcome).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 0 }));
  });

  it("does NOT query ClickHouse or record an outcome on a non-terminal 'running' heartbeat", async () => {
    mockRecordRunnerResult.mockResolvedValue(recordRunnerResultOf({ terminalState: null }));

    await POST(req({ id: "run-7", workspace_id: WS, status: "running" }));

    expect(mockGetRunCosts).not.toHaveBeenCalled();
    expect(mockRecordRunOutcome).not.toHaveBeenCalled();
  });

  it("does NOT query ClickHouse or record an outcome on a red retry that still has budget (terminalState null)", async () => {
    mockRecordRunnerResult.mockResolvedValue(recordRunnerResultOf({ terminalState: null }));

    await POST(req({ id: "run-8", workspace_id: WS, status: "red" }));

    expect(mockGetRunCosts).not.toHaveBeenCalled();
    expect(mockRecordRunOutcome).not.toHaveBeenCalled();
  });

  it("passes the queue entry's taskType straight through from recordRunnerResult", async () => {
    mockRecordRunnerResult.mockResolvedValue(
      recordRunnerResultOf({ terminalState: "green", taskType: "mechanical" })
    );

    await POST(req({ id: "run-9", workspace_id: WS, status: "green" }));

    expect(mockRecordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: "mechanical" })
    );
  });

  it("BEST-EFFORT: getRunCosts throwing never changes the 202 response, and never calls recordRunOutcome", async () => {
    mockRecordRunnerResult.mockResolvedValue(recordRunnerResultOf({ terminalState: "green" }));
    mockGetRunCosts.mockRejectedValue(new Error("clickhouse unreachable"));

    const res = await POST(req({ id: "run-10", workspace_id: WS, status: "green" }));

    expect(res.status).toBe(202);
    expect(mockRecordRunOutcome).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it("BEST-EFFORT: recordRunOutcome throwing never changes the 202 response", async () => {
    mockRecordRunnerResult.mockResolvedValue(recordRunnerResultOf({ terminalState: "green" }));
    mockRecordRunOutcome.mockRejectedValue(new Error("unique violation"));

    const res = await POST(req({ id: "run-11", workspace_id: WS, status: "green" }));

    expect(res.status).toBe(202);
    expect(console.error).toHaveBeenCalled();
  });
});
