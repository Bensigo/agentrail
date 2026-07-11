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
