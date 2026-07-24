import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Closed factory (an unlisted query fn stays undefined → loud crash), EXCEPT
// ONBOARD_EXTERNAL_ID_PREFIX which is picked from the REAL module: it is the
// single-source prefix constant (#1268 fix round) onboard-notify.ts routes on,
// and a literal copy here would be exactly the drift-prone duplication the
// constant exists to kill.
vi.mock("@agentrail/db-postgres", async (importActual) => {
  const actual =
    await importActual<typeof import("@agentrail/db-postgres")>();
  return {
    ONBOARD_EXTERNAL_ID_PREFIX: actual.ONBOARD_EXTERNAL_ID_PREFIX,
    recordRunnerResult: vi.fn(),
    touchApiKeyLastUsed: vi.fn(),
    // #1268 PR②: onboard-notify.ts's real implementation runs in this suite
    // (NOT mocked away as a module — see the onboard-kind describe block below),
    // so its one db-postgres dependency must be mockable here too.
    latestTelegramSessionForWorkspace: vi.fn(),
    // #1278 PR②: merge enforcement's two DB reads.
    getMergePermission: vi.fn(),
    getInstallationToken: vi.fn(),
    // #1338 PR①: recordRunOutcome is mocked (asserted on in its own dedicated
    // suite, route.run-outcome-capture.test.ts). mapTerminalStateToRunOutcome
    // is picked from the REAL module — same "harmless real value" precedent
    // as ONBOARD_EXTERNAL_ID_PREFIX above: it's a pure 3-way switch, so using
    // the real one means an assertion checks the ACTUAL mapped outcome
    // string instead of a meaningless mock return.
    recordRunOutcome: vi.fn(),
    mapTerminalStateToRunOutcome: actual.mapTerminalStateToRunOutcome,
    // #1290 PR② — wallet completion charge. isBillingEnabled defaults falsy
    // (undefined) so the charge block short-circuits and every test in this
    // suite stays byte-identical to pre-#1290; usdToCents is real+pure.
    isBillingEnabled: vi.fn(),
    chargeCompletedTask: vi.fn(),
    usdToCents: actual.usdToCents,
  };
});
vi.mock("@agentrail/db-clickhouse", () => ({
  insertFailureEvents: vi.fn(),
  recordRunLifecycleEvent: vi.fn(),
  // #1338 PR①: resolved once per terminal result to find the execute-phase
  // model + sum cost; see route.run-outcome-capture.test.ts for behavior.
  getRunCosts: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));
vi.mock("./notify", () => ({
  notifyRunOutcome: vi.fn(),
}));
// #1268 PR②: onboard-notify.ts's other dependency (its Telegram sender).
vi.mock("../../../../../lib/telegram-system-message", () => ({
  sendSystemTelegramMessage: vi.fn(),
}));
// NOTE: lib/evidence is intentionally NOT mocked so the route exercises the real
// bound + secret-scrub path (AC5). It only depends on the pure secret-scan util.
// NOTE: lib/github-merge is intentionally NOT mocked as a module (#1278 PR②)
// — its pure parse/match functions and mergePullRequestSquash run for REAL,
// so the security gate (pr_url vs. queue-entry-repo matching) is exercised
// end-to-end through this route. Only the network edge (global.fetch) is
// mocked, matching runner/repos/route.test.ts's own convention.

import { POST } from "./route";
import {
  recordRunnerResult,
  touchApiKeyLastUsed,
  latestTelegramSessionForWorkspace,
  getMergePermission,
  getInstallationToken,
  recordRunOutcome,
} from "@agentrail/db-postgres";
import {
  insertFailureEvents,
  recordRunLifecycleEvent,
  getRunCosts,
} from "@agentrail/db-clickhouse";
import { requireBearer } from "../../../../../lib/bearer-auth";
import { notifyRunOutcome } from "./notify";
import { sendSystemTelegramMessage } from "../../../../../lib/telegram-system-message";

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
  // #1268 PR②: harmless defaults for onboard-notify's real (unmocked-as-a-
  // module) dependencies — existing tests below all use issue-kind external
  // ids, so the onboard branch (and these two mocks) never fire for them.
  vi.mocked(latestTelegramSessionForWorkspace).mockResolvedValue(null);
  vi.mocked(sendSystemTelegramMessage).mockResolvedValue({ ok: true } as never);
  vi.mocked(insertFailureEvents).mockResolvedValue(1);
  vi.mocked(recordRunnerResult).mockResolvedValue({
    updated: true,
    terminalState: null,
    externalId: "owner/name#42",
    taskType: null,
  } as never);
  // #1278 PR②: default OFF — every pre-existing test in this file (and any
  // new test that doesn't explicitly opt in) gets the byte-identical-to-
  // before behavior: zero GitHub calls, merged always false.
  vi.mocked(getMergePermission).mockResolvedValue(false);
  vi.mocked(getInstallationToken).mockResolvedValue(null);
  // #1338 PR①: harmless defaults — terminalState is null by default above,
  // so this block never fires for a pre-existing test unless it explicitly
  // opts in (see route.run-outcome-capture.test.ts for the dedicated suite).
  vi.mocked(getRunCosts).mockResolvedValue([]);
  vi.mocked(recordRunOutcome).mockResolvedValue(undefined as never);
});

const ORIGINAL_FETCH = global.fetch;
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
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

/**
 * #1268 PR② — onboard-kind results ride a DIFFERENT, honest, workspace-scoped
 * notice (onboard-notify.ts) instead of notifyRunOutcome's issue-shaped
 * message ("PR ready — issue #", empty number for an onboard external id).
 * Both branches share the SAME existing terminal-state hook (no second
 * notify path, no second terminality check) — these tests pin that the
 * issue-kind branch stays byte-identical (regression) while the onboard-kind
 * branch is exercised end-to-end against the mocked db-postgres/telegram
 * seams (onboard-notify.ts itself is NOT mocked away as a module here, so
 * this also proves the route wires it correctly).
 */
describe("POST /api/v1/runner/result — onboard-kind vs issue-kind notify branching (#1268 PR②)", () => {
  const SESSION = {
    id: "session-1",
    workspaceId: WS,
    chatIdentityId: null,
    channel: "telegram",
    conversationKey: "tg-chat-onboard",
    eveSessionId: "eve-1",
    status: "active",
    lastActivityAt: new Date("2026-07-18T00:00:00Z"),
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-18T00:00:00Z"),
  };

  it("green onboard result: notifies the bound conversation, names the repo, never touches notifyRunOutcome", async () => {
    vi.mocked(latestTelegramSessionForWorkspace).mockResolvedValue(SESSION as never);
    vi.mocked(recordRunnerResult).mockResolvedValue({
      updated: true,
      terminalState: "green",
      externalId: "onboard:acme/widgets",
    } as never);

    const res = await POST(req({ ...base, status: "green" }));

    expect(res.status).toBe(202);
    expect(latestTelegramSessionForWorkspace).toHaveBeenCalledWith(WS);
    const [chatId, message] = vi.mocked(sendSystemTelegramMessage).mock.calls[0]!;
    expect(chatId).toBe("tg-chat-onboard");
    expect(message).toContain("acme/widgets");
    expect(message).toContain("indexed");
    expect(notifyRunOutcome).not.toHaveBeenCalled();
  });

  it("escalated-to-human onboard result: honest didn't-finish copy, no PR/issue-number nonsense", async () => {
    vi.mocked(latestTelegramSessionForWorkspace).mockResolvedValue(SESSION as never);
    vi.mocked(recordRunnerResult).mockResolvedValue({
      updated: true,
      terminalState: "escalated-to-human",
      externalId: "onboard:acme/widgets",
    } as never);

    await POST(req({ ...base, status: "error" }));

    const [, message] = vi.mocked(sendSystemTelegramMessage).mock.calls[0]!;
    expect(message).toContain("acme/widgets");
    expect(message).toMatch(/didn't finish/i);
    expect(message).not.toMatch(/PR ready/i);
    expect(notifyRunOutcome).not.toHaveBeenCalled();
  });

  it("regression-pin: an issue-kind result still calls notifyRunOutcome byte-identically and never touches the onboard telegram path", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue({
      updated: true,
      terminalState: "green",
      externalId: "owner/name#42",
    } as never);

    const res = await POST(
      req({
        ...base,
        status: "green",
        pr_url: "https://github.com/o/r/pull/9",
        cost_usd: 1.2,
      })
    );

    expect(res.status).toBe(202);
    expect(notifyRunOutcome).toHaveBeenCalledTimes(1);
    expect(notifyRunOutcome).toHaveBeenCalledWith(WS, {
      issueNumber: "42",
      outcome: "green",
      prUrl: "https://github.com/o/r/pull/9",
      costUsd: 1.2,
      // #1278 PR②: merge permission defaults OFF in this suite's beforeEach
      // — merged is always false here, the byte-identical-to-before value.
      merged: false,
    });
    expect(latestTelegramSessionForWorkspace).not.toHaveBeenCalled();
    expect(sendSystemTelegramMessage).not.toHaveBeenCalled();
  });

  it("no bound conversation: logs a no-op, never an error, and the route still returns 202", async () => {
    vi.mocked(latestTelegramSessionForWorkspace).mockResolvedValue(null);
    vi.mocked(recordRunnerResult).mockResolvedValue({
      updated: true,
      terminalState: "green",
      externalId: "onboard:acme/widgets",
    } as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const res = await POST(req({ ...base, status: "green" }));
      expect(res.status).toBe(202);
      expect(sendSystemTelegramMessage).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(WS));
    } finally {
      logSpy.mockRestore();
    }
  });
});

/**
 * #1278 PR② — merge enforcement at the publish step. The CONSOLE-SIDE
 * decision at result time: workspace.merge_permission is read FRESH inside
 * THIS handler call (never cached, never threaded through the WorkItem), so
 * a revoke between claim and result is honored immediately.
 *
 * lib/github-merge is deliberately NOT mocked as a module (see the top-of-
 * file note) — its pure parse/match functions and mergePullRequestSquash run
 * for REAL here, exercising the security gate (pr_url vs. the queue entry's
 * OWN repo, from external_id) end-to-end through this route. Only
 * global.fetch (the network edge) and the two DB reads (getMergePermission,
 * getInstallationToken) are mocked.
 */
describe("POST /api/v1/runner/result — merge enforcement (#1278 PR②)", () => {
  const PR_URL = "https://github.com/octocat/hello-world/pull/42";
  const TOKEN = "ghs_test_token_1234567890abcdef";

  function greenResult(externalId = "octocat/hello-world#42") {
    return { updated: true, terminalState: "green", externalId } as never;
  }

  function githubMergeSuccess() {
    return { ok: true, status: 200, json: async () => ({ merged: true }) };
  }
  function githubMergeFailure(status: number) {
    return { ok: false, status, json: async () => ({ message: "nope" }) };
  }

  it("permission ON: squash-merges via the exact REST call — token in the Authorization header, never the URL or body", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue(greenResult());
    vi.mocked(getMergePermission).mockResolvedValue(true);
    vi.mocked(getInstallationToken).mockResolvedValue(TOKEN);
    const fetchMock = vi.fn().mockResolvedValue(githubMergeSuccess());
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(
      req({ ...base, status: "green", pr_url: PR_URL, cost_usd: 1.2 })
    );

    expect(res.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.github.com/repos/octocat/hello-world/pulls/42/merge"
    );
    expect(url).not.toContain(TOKEN);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.body as string).not.toContain(TOKEN);
    expect(JSON.parse(init.body as string).merge_method).toBe("squash");
  });

  it("permission ON success: records a `merged` ClickHouse lifecycle event and notify says merged", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue(greenResult());
    vi.mocked(getMergePermission).mockResolvedValue(true);
    vi.mocked(getInstallationToken).mockResolvedValue(TOKEN);
    global.fetch = vi.fn().mockResolvedValue(githubMergeSuccess()) as unknown as typeof fetch;

    await POST(req({ ...base, status: "green", pr_url: PR_URL, cost_usd: 1.2 }));

    expect(recordRunLifecycleEvent).toHaveBeenCalledWith(
      WS,
      base.id,
      "merged",
      expect.stringContaining(PR_URL),
      expect.any(Number)
    );
    expect(notifyRunOutcome).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ outcome: "green", prUrl: PR_URL, merged: true })
    );
  });

  it("permission OFF: zero GitHub calls at all (regression-pin) — no token fetch, no merge lifecycle event, notify says merged:false", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue(greenResult());
    vi.mocked(getMergePermission).mockResolvedValue(false);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(req({ ...base, status: "green", pr_url: PR_URL }));

    expect(res.status).toBe(202);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getInstallationToken).not.toHaveBeenCalled();
    expect(recordRunLifecycleEvent).not.toHaveBeenCalledWith(
      WS,
      base.id,
      "merged",
      expect.anything(),
      expect.anything()
    );
    expect(recordRunLifecycleEvent).not.toHaveBeenCalledWith(
      WS,
      base.id,
      "merge_failed",
      expect.anything(),
      expect.anything()
    );
    expect(notifyRunOutcome).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ merged: false })
    );
  });

  it("revoke-between-claim-and-result: permission is read FRESH exactly once per result, never cached across the call", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue(greenResult());
    // Simulates the operator having revoked after this run claimed —
    // whatever was true at claim time is irrelevant; this handler call only
    // ever consults the CURRENT (now false) value.
    vi.mocked(getMergePermission).mockResolvedValue(false);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await POST(req({ ...base, status: "green", pr_url: PR_URL }));

    expect(getMergePermission).toHaveBeenCalledTimes(1);
    expect(getMergePermission).toHaveBeenCalledWith(WS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pr_url forgery — wrong repo than the queue entry's own: no merge attempted, loud log, notify still carries the (unmerged) PR link", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue(greenResult("octocat/hello-world#42"));
    vi.mocked(getMergePermission).mockResolvedValue(true);
    vi.mocked(getInstallationToken).mockResolvedValue(TOKEN);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const forgedUrl = "https://github.com/attacker/evil-repo/pull/1";
    const res = await POST(req({ ...base, status: "green", pr_url: forgedUrl }));

    expect(res.status).toBe(202);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    expect(notifyRunOutcome).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ prUrl: forgedUrl, merged: false })
    );
    errorSpy.mockRestore();
  });

  it("pr_url forgery — lookalike host: no merge attempted", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue(greenResult("octocat/hello-world#42"));
    vi.mocked(getMergePermission).mockResolvedValue(true);
    vi.mocked(getInstallationToken).mockResolvedValue(TOKEN);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});

    await POST(
      req({
        ...base,
        status: "green",
        pr_url: "https://github.com.evil.com/octocat/hello-world/pull/42",
      })
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pr_url forgery — junk value: no merge attempted, no throw, 202 still returned", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue(greenResult("octocat/hello-world#42"));
    vi.mocked(getMergePermission).mockResolvedValue(true);
    vi.mocked(getInstallationToken).mockResolvedValue(TOKEN);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req({ ...base, status: "green", pr_url: "not a url" }));

    expect(res.status).toBe(202);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("merge-failure path (GitHub rejects, e.g. not-mergeable 405): result stays recorded, notify still carries the PR link, merge_failed event, exactly one attempt (never retry-loops)", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue(greenResult());
    vi.mocked(getMergePermission).mockResolvedValue(true);
    vi.mocked(getInstallationToken).mockResolvedValue(TOKEN);
    const fetchMock = vi.fn().mockResolvedValue(githubMergeFailure(405));
    global.fetch = fetchMock as unknown as typeof fetch;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req({ ...base, status: "green", pr_url: PR_URL }));

    expect(res.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notifyRunOutcome).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ prUrl: PR_URL, merged: false })
    );
    expect(recordRunLifecycleEvent).toHaveBeenCalledWith(
      WS,
      base.id,
      "merge_failed",
      expect.stringContaining(PR_URL),
      expect.any(Number)
    );
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("no merge attempt for a non-green terminal (escalated-to-human), even with a pr_url present", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue({
      updated: true,
      terminalState: "escalated-to-human",
      externalId: "octocat/hello-world#42",
    } as never);
    vi.mocked(getMergePermission).mockResolvedValue(true);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await POST(req({ ...base, status: "error", pr_url: PR_URL }));

    expect(getMergePermission).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no merge attempt when the terminal is green but no pr_url was reported", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue(greenResult());
    vi.mocked(getMergePermission).mockResolvedValue(true);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await POST(req({ ...base, status: "green" }));

    expect(getMergePermission).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no merge attempt for an onboard-kind result, even green with a pr_url present", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue(
      greenResult("onboard:acme/widgets")
    );
    vi.mocked(getMergePermission).mockResolvedValue(true);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.mocked(latestTelegramSessionForWorkspace).mockResolvedValue(null);

    await POST(req({ ...base, status: "green", pr_url: PR_URL }));

    expect(getMergePermission).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a getMergePermission DB blip is swallowed — result still records 202, merge just never happens", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue(greenResult());
    vi.mocked(getMergePermission).mockRejectedValue(new Error("db down"));
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req({ ...base, status: "green", pr_url: PR_URL }));

    expect(res.status).toBe(202);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * #1343 — duplicate-green honesty. Before this fix, a replayed/duplicate
 * green result (recordRunnerResult reports `terminalState: "green"` again
 * because the row was ALREADY green — see that function's own
 * `transitioned` doc-comment) re-fired the merge block: GitHub refuses
 * (405 → not_mergeable, since the PR is already merged) → a FALSE
 * `merge_failed` lifecycle event ("PR left open") plus a contradictory
 * second chat ping ("PR ready"/merged:false right after "Merged"). The fix:
 * `recordRunnerResult` now reports `transitioned: false` on a duplicate, and
 * the route skips BOTH the merge attempt and the chat notify when that's the
 * case — proven here with a mocked `fetch` asserted at ZERO calls (AC1).
 */
describe("POST /api/v1/runner/result — duplicate-green honesty (#1343)", () => {
  const PR_URL = "https://github.com/octocat/hello-world/pull/42";
  const TOKEN = "ghs_test_token_1234567890abcdef";

  function duplicateGreenResult(externalId = "octocat/hello-world#42") {
    return {
      updated: true,
      terminalState: "green",
      externalId,
      taskType: null,
      transitioned: false,
    } as never;
  }

  it("permission ON: replayed green makes ZERO GitHub API calls (AC1) — no merge attempt at all", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue(duplicateGreenResult());
    vi.mocked(getMergePermission).mockResolvedValue(true);
    vi.mocked(getInstallationToken).mockResolvedValue(TOKEN);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(
      req({ ...base, status: "green", pr_url: PR_URL, cost_usd: 1.2 })
    );

    expect(res.status).toBe(202);
    expect(fetchMock).not.toHaveBeenCalled();
    // The permission read (a DB call, not a GitHub call) is skipped too —
    // there is nothing left to gate once the merge attempt itself is skipped.
    expect(getMergePermission).not.toHaveBeenCalled();
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it("no false `merge_failed` lifecycle event on a replay (AC1)", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue(duplicateGreenResult());
    vi.mocked(getMergePermission).mockResolvedValue(true);
    vi.mocked(getInstallationToken).mockResolvedValue(TOKEN);
    global.fetch = vi.fn() as unknown as typeof fetch;

    await POST(req({ ...base, status: "green", pr_url: PR_URL }));

    expect(recordRunLifecycleEvent).not.toHaveBeenCalledWith(
      WS,
      base.id,
      "merge_failed",
      expect.anything(),
      expect.anything()
    );
    expect(recordRunLifecycleEvent).not.toHaveBeenCalledWith(
      WS,
      base.id,
      "merged",
      expect.anything(),
      expect.anything()
    );
  });

  it("no contradictory second chat ping on a replay (AC1) — notifyRunOutcome is never called", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue(duplicateGreenResult());
    vi.mocked(getMergePermission).mockResolvedValue(true);
    vi.mocked(getInstallationToken).mockResolvedValue(TOKEN);
    global.fetch = vi.fn() as unknown as typeof fetch;

    const res = await POST(req({ ...base, status: "green", pr_url: PR_URL }));

    expect(res.status).toBe(202);
    expect(notifyRunOutcome).not.toHaveBeenCalled();
  });

  it("permission OFF: a replay is still a no-GitHub-call no-op (regression alongside the permission-OFF gate)", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue(duplicateGreenResult());
    vi.mocked(getMergePermission).mockResolvedValue(false);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(req({ ...base, status: "green", pr_url: PR_URL }));

    expect(res.status).toBe(202);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notifyRunOutcome).not.toHaveBeenCalled();
  });

  it("a GENUINE (non-duplicate) green result is unaffected — merge attempt and notify both still fire (regression)", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue({
      updated: true,
      terminalState: "green",
      externalId: "octocat/hello-world#42",
      taskType: null,
      transitioned: true,
    } as never);
    vi.mocked(getMergePermission).mockResolvedValue(true);
    vi.mocked(getInstallationToken).mockResolvedValue(TOKEN);
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ merged: true }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(req({ ...base, status: "green", pr_url: PR_URL }));

    expect(res.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notifyRunOutcome).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ merged: true })
    );
  });

  it("backward-compatible default: a RecordRunnerResult with no `transitioned` field at all behaves as a genuine transition (not a silent regression for an un-migrated caller)", async () => {
    vi.mocked(recordRunnerResult).mockResolvedValue({
      updated: true,
      terminalState: "green",
      externalId: "octocat/hello-world#42",
      taskType: null,
      // deliberately omitted — simulates a caller/mock that predates #1343
    } as never);
    vi.mocked(getMergePermission).mockResolvedValue(true);
    vi.mocked(getInstallationToken).mockResolvedValue(TOKEN);
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ merged: true }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await POST(req({ ...base, status: "green", pr_url: PR_URL }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notifyRunOutcome).toHaveBeenCalled();
  });
});
