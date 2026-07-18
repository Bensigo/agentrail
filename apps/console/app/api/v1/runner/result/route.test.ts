import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  recordRunnerResult: vi.fn(),
  touchApiKeyLastUsed: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  insertFailureEvents: vi.fn(),
  recordRunLifecycleEvent: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));
vi.mock("./notify", () => ({
  notifyRunOutcome: vi.fn(),
}));
// NOTE: lib/evidence is intentionally NOT mocked so the route exercises the real
// bound + secret-scrub path (AC5). It only depends on the pure secret-scan util.

import { POST } from "./route";
import { recordRunnerResult, touchApiKeyLastUsed } from "@agentrail/db-postgres";
import { insertFailureEvents, recordRunLifecycleEvent } from "@agentrail/db-clickhouse";
import { requireBearer } from "../../../../../lib/bearer-auth";
import { notifyRunOutcome } from "./notify";

const WS = "00000000-0000-0000-0000-000000000001";
const REPO = "00000000-0000-0000-0000-000000000010";
const KEY = "k1";
const TEAM = "t1";

function req(body: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/result", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: "Bearer ar_test" } : {}),
    },
    body: JSON.stringify(body),
  });
}

const base = {
  id: "qe-1",
  workspace_id: WS,
  repository_id: REPO,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBearer).mockResolvedValue({
    workspaceId: WS,
    apiKeyId: KEY,
    teamId: TEAM,
  } as never);
  vi.mocked(touchApiKeyLastUsed).mockResolvedValue(undefined as never);
  vi.mocked(recordRunLifecycleEvent).mockResolvedValue(undefined as never);
  vi.mocked(notifyRunOutcome).mockResolvedValue(undefined as never);
  vi.mocked(insertFailureEvents).mockResolvedValue(1);
  vi.mocked(recordRunnerResult).mockResolvedValue({
    updated: true,
    terminalState: null,
    externalId: "owner/name#42",
  } as never);
});

describe("POST /api/v1/runner/result — failure evidence (#1146 AC2)", () => {
  it("401 when requireBearer rejects", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireBearer).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );
    const res = await POST(req({ ...base, status: "red" }, false));
    expect(res.status).toBe(401);
    expect(insertFailureEvents).not.toHaveBeenCalled();
  });

  it("403 when the key's workspace differs from the body", async () => {
    const res = await POST(
      req({ ...base, workspace_id: "other-ws", status: "red" })
    );
    expect(res.status).toBe(403);
    expect(insertFailureEvents).not.toHaveBeenCalled();
  });

  it("404 when the queue entry is not in the workspace", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue({
      updated: false,
      terminalState: null,
      externalId: "",
    } as never);
    const res = await POST(
      req({ ...base, status: "red", logs_tail: "boom" })
    );
    expect(res.status).toBe(404);
    expect(insertFailureEvents).not.toHaveBeenCalled();
  });

  it("persists a failure_event on a red result carrying a logs_tail", async () => {
    const res = await POST(
      req({
        ...base,
        status: "red",
        gate_reason: "hidden tests failed",
        logs_tail: "E   AssertionError: expected 3 got 4",
      })
    );
    expect(res.status).toBe(202);
    expect(insertFailureEvents).toHaveBeenCalledTimes(1);
    const [row] = vi.mocked(insertFailureEvents).mock.calls[0][0];
    expect(row).toMatchObject({
      workspace_id: WS,
      run_id: base.id,
      repository_id: REPO,
      failure_type: "objective_gate",
      message: "hidden tests failed",
      phase: "verify",
      severity: "error",
      normalized_error: "",
      fingerprint: "",
    });
    expect(row.evidence).toBe("E   AssertionError: expected 3 got 4");
    expect(row.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
  });

  it("maps an error result onto execution_error / execute", async () => {
    await POST(
      req({ ...base, status: "error", logs_tail: "Traceback ..." })
    );
    const [row] = vi.mocked(insertFailureEvents).mock.calls[0][0];
    expect(row.failure_type).toBe("execution_error");
    expect(row.phase).toBe("execute");
    expect(row.message).toBe("run error"); // no gate_reason → fallback
  });

  it("secret-scrubs the logs_tail before persisting (AC5)", async () => {
    const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    await POST(
      req({
        ...base,
        status: "red",
        logs_tail: `auth failed with key ${secret}\nretrying`,
      })
    );
    const [row] = vi.mocked(insertFailureEvents).mock.calls[0][0];
    expect(row.evidence).not.toContain(secret);
    expect(row.evidence).toContain("[REDACTED_SECRET]");
  });

  it("defaults repository_id to '' when the body omits it", async () => {
    await POST(
      req({ id: base.id, workspace_id: WS, status: "red", logs_tail: "boom" })
    );
    const [row] = vi.mocked(insertFailureEvents).mock.calls[0][0];
    expect(row.repository_id).toBe("");
  });

  it("does NOT persist a failure_event on a green result", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue({
      updated: true,
      terminalState: "green",
      externalId: "owner/name#42",
    } as never);
    const res = await POST(
      req({ ...base, status: "green", logs_tail: "all good" })
    );
    expect(res.status).toBe(202);
    expect(insertFailureEvents).not.toHaveBeenCalled();
  });

  it("does NOT persist when a red result has no logs_tail", async () => {
    const res = await POST(req({ ...base, status: "red" }));
    expect(res.status).toBe(202);
    expect(insertFailureEvents).not.toHaveBeenCalled();
  });

  it("still returns 202 when the failure-event insert throws (AC4)", async () => {
    vi.mocked(insertFailureEvents).mockRejectedValue(new Error("clickhouse down"));
    const res = await POST(
      req({ ...base, status: "red", logs_tail: "boom" })
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
  });
});

/**
 * #1267 PR③ — the route must thread `body.gate_reason` into recordRunnerResult
 * as `gateReason`; without this passthrough the hosted-refusal detection in the
 * db layer can never fire and every refusal silently burns the full retry
 * budget (the review's CRITICAL). This file mocks @agentrail/db-postgres (the
 * established idiom — there is no live-DB harness in the console suite), so
 * these tests pin the two halves of the chain this route owns:
 *   1. the exact gateReason string reaches recordRunnerResult;
 *   2. the route honors the db layer's committed refusal terminal
 *      ('escalated-to-human') — notify fires immediately, first attempt.
 * The other half — that recordRunnerResult with a "hosted-refusal: "-prefixed
 * gateReason commits escalated-to-human while touching NEITHER
 * remaining_budget NOR tier — is pinned in the db package's lockstep suites
 * (packages/db-postgres/src/__tests__/runner-transition.test.ts and
 * runner-result-sql.test.ts), which test the real transition + real SQL.
 */
describe("POST /api/v1/runner/result — hosted refusal gateReason passthrough (#1267 PR③)", () => {
  const REFUSAL_REASON =
    "hosted-refusal: FATAL: hosted run refused — no Independent Reviewer configured";

  it("threads a hosted-refusal gate_reason into recordRunnerResult and notifies on the committed terminal", async () => {
    // The db layer (real behavior pinned in its own suite) commits the refusal
    // terminal on the FIRST attempt, budget/tier untouched — simulate exactly
    // that committed outcome and assert the route's side of the contract.
    vi.mocked(recordRunnerResult).mockResolvedValue({
      updated: true,
      terminalState: "escalated-to-human",
      externalId: "owner/name#42",
    } as never);

    const res = await POST(
      req({ ...base, status: "error", gate_reason: REFUSAL_REASON })
    );

    expect(res.status).toBe(202);
    expect(recordRunnerResult).toHaveBeenCalledTimes(1);
    expect(recordRunnerResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: base.id,
        workspaceId: WS,
        status: "error",
        gateReason: REFUSAL_REASON, // the exact string, unmodified
      })
    );
    // Terminal on the FIRST attempt → the operator hears immediately, not
    // after 5 burned retries.
    expect(notifyRunOutcome).toHaveBeenCalledTimes(1);
    expect(notifyRunOutcome).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({
        issueNumber: "42",
        outcome: "escalated-to-human",
      })
    );
  });

  it("an ordinary error with a non-refusal gate_reason still follows the retry path (no terminal, no notify)", async () => {
    // The db layer re-queues an ordinary error (budget-spend path) and reports
    // no terminal — the route must pass the reason through UNCHANGED (detection
    // is the db layer's job, not the route's) and stay silent on the retry.
    vi.mocked(recordRunnerResult).mockResolvedValue({
      updated: true,
      terminalState: null,
      externalId: "owner/name#42",
    } as never);

    const res = await POST(
      req({ ...base, status: "error", gate_reason: "agentrail run exited 1" })
    );

    expect(res.status).toBe(202);
    expect(recordRunnerResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        gateReason: "agentrail run exited 1",
      })
    );
    expect(notifyRunOutcome).not.toHaveBeenCalled();
  });

  it("omits gateReason when the body carries none (regression: pre-PR③ calls unchanged)", async () => {
    await POST(req({ ...base, status: "red" }));
    expect(recordRunnerResult).toHaveBeenCalledWith(
      expect.objectContaining({ gateReason: undefined })
    );
  });

  it("omits gateReason when gate_reason is not a string", async () => {
    await POST(req({ ...base, status: "error", gate_reason: 42 }));
    expect(recordRunnerResult).toHaveBeenCalledWith(
      expect.objectContaining({ gateReason: undefined })
    );
  });
});
