import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * #1274 PR③ — the runner-result route's reconciler trigger, in isolation
 * from `route.test.ts` (which does not mock `lib/alignment-reconciler` at
 * all, so the reconciler call there throws on its own — see that file; this
 * one exists to assert the trigger IS wired and IS non-fatal explicitly,
 * mirroring the webhook route's own dedicated trigger test).
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
    // #1338 PR① — see route.test.ts's own mock for the full rationale.
    recordRunOutcome: vi.fn(),
    mapTerminalStateToRunOutcome: actual.mapTerminalStateToRunOutcome,
    // #1290 PR② — wallet completion charge. isBillingEnabled defaults falsy
    // (undefined) so the charge block short-circuits and this suite stays
    // byte-identical to pre-#1290; usdToCents is real+pure.
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
} from "@agentrail/db-postgres";
import { recordRunLifecycleEvent } from "@agentrail/db-clickhouse";
import { requireBearer } from "../../../../../lib/bearer-auth";
import { reconcileAlignmentBriefs } from "../../../../../lib/alignment-reconciler";

const WS = "00000000-0000-0000-0000-000000000001";

const mockRecordRunnerResult = vi.mocked(recordRunnerResult);
const mockReconcile = vi.mocked(reconcileAlignmentBriefs);
const mockLifecycleEvent = vi.mocked(recordRunLifecycleEvent);

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/result", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBearer).mockResolvedValue({ workspaceId: WS, apiKeyId: "key-1" } as never);
  vi.mocked(touchApiKeyLastUsed).mockResolvedValue(undefined as never);
  vi.mocked(getMergePermission).mockResolvedValue(false);
  vi.mocked(getGithubToken).mockResolvedValue(null);
  mockRecordRunnerResult.mockResolvedValue({
    updated: true,
    terminalState: null,
    externalId: "acme/widgets#7",
  } as never);
  mockReconcile.mockResolvedValue([]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/v1/runner/result — alignment-reconciler trigger (#1274 PR③)", () => {
  it("calls reconcileAlignmentBriefs workspace-scoped (I2) with a bounded limit after a successful recordRunnerResult", async () => {
    await POST(req({ id: "run-1", workspace_id: WS, status: "green" }));
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledWith(WS, 5);
  });

  it("does NOT fire when the queue entry was not found (recordRunnerResult.updated=false) — no real result was recorded", async () => {
    mockRecordRunnerResult.mockResolvedValue({ updated: false, terminalState: null, externalId: "" } as never);
    const res = await POST(req({ id: "run-1", workspace_id: WS, status: "green" }));
    expect(res.status).toBe(404);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("NON-FATAL: a reconciler rejection does not change the route's 202 response", async () => {
    mockReconcile.mockRejectedValue(new Error("reconciler exploded"));

    const res = await POST(req({ id: "run-1", workspace_id: WS, status: "green" }));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ ok: true });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("alignment-reconciler"),
      expect.any(Error)
    );
  });

  it("NON-FATAL: a reconciler rejection does not prevent the timeline/lifecycle work later in the SAME request", async () => {
    mockReconcile.mockRejectedValue(new Error("reconciler exploded"));

    const res = await POST(req({ id: "run-1", workspace_id: WS, status: "green" }));

    expect(res.status).toBe(202);
    // recordRunLifecycleEvent runs unconditionally after the reconciler call
    // (the gate_<status> timeline marker) — proving the handler kept going
    // past the reconciler's throw rather than being aborted by it.
    expect(mockLifecycleEvent).toHaveBeenCalled();
  });
});
