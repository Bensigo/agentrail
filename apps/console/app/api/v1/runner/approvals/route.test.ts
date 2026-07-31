import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  recordApprovalRequest: vi.fn(),
  getInvestigationById: vi.fn(),
}));
vi.mock("../../../../../lib/approval-message", () => ({
  renderApprovalMessage: vi.fn(),
}));
vi.mock("../../workspaces/[workspaceId]/connectors/secret/telegram", () => ({
  sendTelegramMessage: vi.fn(),
  buildApprovalKeyboard: vi.fn(),
}));

import { POST } from "./route";
import {
  getJaceSessionByEveSessionId,
  recordApprovalRequest,
  getInvestigationById,
} from "@agentrail/db-postgres";
import { renderApprovalMessage } from "../../../../../lib/approval-message";
import {
  sendTelegramMessage,
  buildApprovalKeyboard,
} from "../../workspaces/[workspaceId]/connectors/secret/telegram";

const mockGetSession = vi.mocked(getJaceSessionByEveSessionId);
const mockRecord = vi.mocked(recordApprovalRequest);
const mockRender = vi.mocked(renderApprovalMessage);
const mockSend = vi.mocked(sendTelegramMessage);
const mockBuildKeyboard = vi.mocked(buildApprovalKeyboard);
const mockGetInvestigation = vi.mocked(getInvestigationById);

const NOW = new Date("2026-07-18T00:00:00.000Z");
const ORIGINAL_TOKEN_ENV = process.env["TELEGRAM_BOT_TOKEN"];

// Central-secret auth (2026-07-20 fix): the route now authenticates via
// requireJaceConsoleSecret / JACE_CONSOLE_TOKEN instead of a per-workspace
// bearer api_key. Real helper, real env var, real header — same idiom as
// fleet/workspace-tokens/sync/route.test.ts uses for its own shared secret.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(body?: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/approvals", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const MOCK_BODY = {
  eveSessionId: "eve-session-1",
  toolName: "create_issue",
  toolInput: { title: "Add dark mode", acceptanceCriteria: ["Toggle in settings"] },
  idempotencyKey: "eve-session-1:turn-1:create_issue:abc123",
};

const MOCK_SESSION_WS = {
  id: "session-1",
  workspaceId: "ws-1",
  chatIdentityId: "chat-identity-1",
  channel: "telegram",
  conversationKey: "-100123",
  eveSessionId: "eve-session-1",
  status: "active",
  lastActivityAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

const MOCK_SESSION_INTRO = {
  ...MOCK_SESSION_WS,
  id: "session-intro-1",
  workspaceId: null,
};

// Task 12 (investigation issue-link stamping): a session anchored to an
// investigation via jace_sessions.anchored_investigation_id — read straight
// off the SAME row getJaceSessionByEveSessionId already fetches, no second
// query (mirrors runner/investigations' own anchor-mode reasoning).
const MOCK_SESSION_ANCHORED = {
  ...MOCK_SESSION_WS,
  anchoredInvestigationId: "inv-1",
};

const MOCK_INVESTIGATION = {
  investigation: {
    id: "inv-1",
    workspaceId: "ws-1",
    repositoryId: null,
    slug: "checkout-500s",
    title: "Checkout returns 500",
    status: "investigating",
    severity: "high",
    openedBy: "chat",
    symptomStatement: "checkout returns 500 intermittently",
    symptomSignature: "checkout 500 intermittent",
    affectedSurface: "",
    firstSeenAt: null,
    verdict: null,
    confidence: null,
    depthBudget: 8,
    jaceSessionIds: ["session-1"],
    createdAt: NOW,
    updatedAt: NOW,
  },
  items: [],
};

const MOCK_APPROVAL = {
  id: "approval-1",
  workspaceId: "ws-1",
  chatIdentityId: "chat-identity-1",
  sessionId: "session-1",
  eveSessionId: "eve-session-1",
  requestId: MOCK_BODY.idempotencyKey,
  callbackToken: "cbtoken123456",
  toolName: "create_issue",
  toolInput: MOCK_BODY.toolInput,
  approveOptionId: "approve",
  denyOptionId: "deny",
  status: "pending",
  publishedIssueUrl: null,
  createdAt: NOW,
  resolvedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env["TELEGRAM_BOT_TOKEN"] = "test-bot-token";
  process.env[ENV_KEY] = SECRET;
  mockRender.mockReturnValue("rendered approval text");
  mockBuildKeyboard.mockReturnValue({ inline_keyboard: [[]] } as never);
  mockSend.mockResolvedValue({ ok: true } as never);
  mockGetInvestigation.mockResolvedValue(null);
});

afterEach(() => {
  if (ORIGINAL_TOKEN_ENV === undefined) {
    delete process.env["TELEGRAM_BOT_TOKEN"];
  } else {
    process.env["TELEGRAM_BOT_TOKEN"] = ORIGINAL_TOKEN_ENV;
  }
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/approvals — auth + body validation", () => {
  it("401 when no Authorization header is sent, and never touches session/record/send", async () => {
    const res = await POST(req(MOCK_BODY, false));

    expect(res.status).toBe(401);
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("401 when JACE_CONSOLE_TOKEN is unset (fail closed, never 'open') — even the objectively correct secret is rejected", async () => {
    delete process.env[ENV_KEY];

    const res = await POST(req(MOCK_BODY, true));

    expect(res.status).toBe(401);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("401 on a wrong secret", async () => {
    const request = new NextRequest("http://localhost/api/v1/runner/approvals", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer wrong-secret" },
      body: JSON.stringify(MOCK_BODY),
    });

    const res = await POST(request);

    expect(res.status).toBe(401);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON body", async () => {
    const request = new NextRequest("http://localhost/api/v1/runner/approvals", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` },
      body: "{not valid json",
    });
    const res = await POST(request);
    expect(res.status).toBe(400);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("400 when eveSessionId is missing", async () => {
    const res = await POST(
      req({ toolName: "create_issue", toolInput: {}, idempotencyKey: "k" })
    );
    expect(res.status).toBe(400);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("400 when toolName is missing", async () => {
    const res = await POST(
      req({ eveSessionId: "eve-session-1", toolInput: {}, idempotencyKey: "k" })
    );
    expect(res.status).toBe(400);
  });

  it("400 when toolInput is missing", async () => {
    const res = await POST(
      req({ eveSessionId: "eve-session-1", toolName: "create_issue", idempotencyKey: "k" })
    );
    expect(res.status).toBe(400);
  });

  it("400 when toolInput is not a plain object (e.g. an array)", async () => {
    const res = await POST(
      req({
        eveSessionId: "eve-session-1",
        toolName: "create_issue",
        toolInput: [],
        idempotencyKey: "k",
      })
    );
    expect(res.status).toBe(400);
  });

  it("400 when idempotencyKey is missing — it is REQUIRED, not optional", async () => {
    const res = await POST(
      req({ eveSessionId: "eve-session-1", toolName: "create_issue", toolInput: {} })
    );
    expect(res.status).toBe(400);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("400 when idempotencyKey is an empty string", async () => {
    const res = await POST(req({ ...MOCK_BODY, idempotencyKey: "" }));
    expect(res.status).toBe(400);
    expect(mockGetSession).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/runner/approvals — session resolution + tenant scoping", () => {
  it("404 when no jace_sessions row is bound to this eveSessionId", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await POST(req(MOCK_BODY));

    expect(res.status).toBe(404);
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("404 when the session has neither workspaceId nor chatIdentityId (defensive, unreachable in practice)", async () => {
    mockGetSession.mockResolvedValue({
      ...MOCK_SESSION_INTRO,
      chatIdentityId: null,
    } as never);

    const res = await POST(req(MOCK_BODY));
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(mockRecord).not.toHaveBeenCalled();

    mockGetSession.mockResolvedValue(null);
    const unknownRes = await POST(req(MOCK_BODY));
    expect(await unknownRes.text()).toBe(text);
  });

  it("BEHAVIOR CHANGE (accepted, central-secret model — see route doc-comment): a resolved session workspaceId no longer needs to match anything — there is no bearer-own workspace left to cross-check against (JACE_CONSOLE_TOKEN is ONE shared secret for the whole deployment). Records successfully (201) where the old per-workspace-bearer model would have refused a mismatch (404).", async () => {
    mockGetSession.mockResolvedValue({
      ...MOCK_SESSION_WS,
      workspaceId: "ws-some-other-tenant",
    } as never);
    mockRecord.mockResolvedValue({
      approval: { ...MOCK_APPROVAL, workspaceId: "ws-some-other-tenant" },
      created: true,
    } as never);

    const res = await POST(req(MOCK_BODY));

    expect(res.status).toBe(201);
    const recordArgs = mockRecord.mock.calls[0]?.[0];
    expect(recordArgs).toMatchObject({ workspaceId: "ws-some-other-tenant" });
  });

  it("201 when the session is an intro (workspaceId null) session, regardless of which caller asks — the create_workspace cold-start flow", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_INTRO as never);
    mockRecord.mockResolvedValue({
      approval: {
        ...MOCK_APPROVAL,
        workspaceId: null,
        sessionId: MOCK_SESSION_INTRO.id,
      },
      created: true,
    } as never);

    const res = await POST(req(MOCK_BODY));

    expect(res.status).toBe(201);
    const recordArgs = mockRecord.mock.calls[0]?.[0];
    expect(recordArgs).toMatchObject({
      chatIdentityId: "chat-identity-1",
      sessionId: "session-intro-1",
    });
    expect(recordArgs?.workspaceId).toBeUndefined();
  });

  it("201 for the common case — a normal resolved-workspace session", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    const res = await POST(req(MOCK_BODY));

    expect(res.status).toBe(201);
    const recordArgs = mockRecord.mock.calls[0]?.[0];
    expect(recordArgs).toMatchObject({
      workspaceId: "ws-1",
      chatIdentityId: "chat-identity-1",
      sessionId: "session-1",
    });
  });
});

describe("POST /api/v1/runner/approvals — recordApprovalRequest arguments + response shape", () => {
  it("passes eveSessionId/toolName/toolInput straight through for a tool #1274 PR ② does NOT enrich, vestigial literal approve/deny option ids, and requestId = the caller's idempotencyKey verbatim", async () => {
    // create_workspace (not create_issue): proves the "straight through" claim
    // for every OTHER tool. create_issue's own toolInput is now enriched with
    // a `_brief` before recording — see the dedicated "#1274 PR ② chat-born
    // enrichment" describe block below for that tool's specific contract.
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);
    const body = {
      ...MOCK_BODY,
      toolName: "create_workspace",
      toolInput: { name: "Acme Corp" },
    };

    await POST(req(body));

    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        eveSessionId: "eve-session-1",
        toolName: "create_workspace",
        toolInput: body.toolInput,
        approveOptionId: "approve",
        denyOptionId: "deny",
        requestId: MOCK_BODY.idempotencyKey,
      })
    );
  });

  it("derives requestId from idempotencyKey alone — two different keys produce two different requestIds, same key produces the same requestId", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(req({ ...MOCK_BODY, idempotencyKey: "key-a" }));
    await POST(req({ ...MOCK_BODY, idempotencyKey: "key-b" }));
    await POST(req({ ...MOCK_BODY, idempotencyKey: "key-a" }));

    const requestIds = mockRecord.mock.calls.map((c) => c[0]?.requestId);
    expect(requestIds).toEqual(["key-a", "key-b", "key-a"]);
  });

  it("responds 201 { approvalId, status: 'pending' } — exactly those two fields — on a fresh (created: true) record", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    const res = await POST(req(MOCK_BODY));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body).toEqual({ approvalId: "approval-1", status: "pending" });
  });
});

describe("POST /api/v1/runner/approvals — idempotent replay (created: false, issue #1273 PR ②)", () => {
  it("responds 200 with the EXISTING approval's { approvalId, status } — no second row, no second send", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    const existing = { ...MOCK_APPROVAL, id: "approval-existing", status: "pending" };
    mockRecord.mockResolvedValue({ approval: existing, created: false } as never);

    const res = await POST(req(MOCK_BODY));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ approvalId: "approval-existing", status: "pending" });
    expect(mockRender).not.toHaveBeenCalled();
    expect(mockBuildKeyboard).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("reflects the EXISTING approval's actual (already-terminal) status on replay, not a hardcoded 'pending'", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    const existing = { ...MOCK_APPROVAL, id: "approval-existing", status: "approved" };
    mockRecord.mockResolvedValue({ approval: existing, created: false } as never);

    const res = await POST(req(MOCK_BODY));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ approvalId: "approval-existing", status: "approved" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("still calls recordApprovalRequest with the same derived requestId on replay (the DB layer is what detects the conflict, not this route)", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: false } as never);

    await POST(req(MOCK_BODY));

    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: MOCK_BODY.idempotencyKey })
    );
  });
});

describe("POST /api/v1/runner/approvals — #1274 PR ② chat-born enrichment (create_issue only)", () => {
  it("enriches a create_issue toolInput with a _brief computed from its own title/whatToBuild/acceptanceCriteria", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        ...MOCK_BODY,
        toolInput: {
          title: "Add dark mode toggle",
          whatToBuild: "A settings toggle that persists across reload.",
          acceptanceCriteria: ["Toggle in settings", "Persists across reload"],
        },
      })
    );

    const recordArgs = mockRecord.mock.calls[0]?.[0];
    const brief = (recordArgs?.toolInput as Record<string, unknown>)?._brief as
      | Record<string, unknown>
      | undefined;
    expect(brief).toBeDefined();
    expect(typeof brief?.taskType).toBe("string");
    expect(typeof brief?.estimateUsd).toBe("number");
    expect((brief?.estimateUsd as number)).toBeGreaterThan(0);
    expect(brief?.suggestedModel).toMatchObject({ slug: expect.any(String), displayName: expect.any(String) });
    // Original create_issue fields survive untouched alongside _brief.
    expect(recordArgs?.toolInput).toMatchObject({
      title: "Add dark mode toggle",
      whatToBuild: "A settings toggle that persists across reload.",
      acceptanceCriteria: ["Toggle in settings", "Persists across reload"],
    });
  });

  it("INJECTION GUARD: a caller-supplied _brief is overwritten with the server-computed one, never passed through", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        ...MOCK_BODY,
        toolInput: {
          title: "Add dark mode toggle",
          whatToBuild: "A settings toggle that persists across reload.",
          acceptanceCriteria: ["Toggle in settings"],
          _brief: { evil: true, estimateUsd: 0, suggestedModel: { slug: "attacker/free-model" } },
        },
      })
    );

    const recordArgs = mockRecord.mock.calls[0]?.[0];
    const brief = (recordArgs?.toolInput as Record<string, unknown>)?._brief as
      | Record<string, unknown>
      | undefined;
    expect(brief).not.toHaveProperty("evil");
    expect(brief?.estimateUsd).not.toBe(0);
    expect((brief?.suggestedModel as Record<string, unknown>)?.slug).not.toBe(
      "attacker/free-model"
    );
  });

  it("INJECTION GUARD: an attacker-cheap _brief attempting to undercut the real estimate is discarded — the recorded estimate always matches the server's own computation for the SAME content", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    const honestToolInput = {
      title: "Add dark mode toggle",
      whatToBuild: "A settings toggle that persists across reload.",
      acceptanceCriteria: ["Toggle in settings"],
    };
    await POST(
      req({ ...MOCK_BODY, toolInput: honestToolInput })
    );
    const honestBrief = (mockRecord.mock.calls[0]?.[0]?.toolInput as Record<string, unknown>)
      ?._brief as Record<string, unknown>;

    mockRecord.mockClear();
    await POST(
      req({
        ...MOCK_BODY,
        idempotencyKey: "different-key-same-content",
        toolInput: {
          ...honestToolInput,
          _brief: { estimateUsd: 0.01, suggestedModel: { slug: "attacker/free-model", displayName: "Free" } },
        },
      })
    );
    const attackerAttemptBrief = (
      mockRecord.mock.calls[0]?.[0]?.toolInput as Record<string, unknown>
    )?._brief as Record<string, unknown>;

    expect(attackerAttemptBrief).toEqual(honestBrief);
  });

  it("does NOT enrich other tools' toolInput — passes through unchanged, no _brief added", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        eveSessionId: "eve-session-1",
        toolName: "create_workspace",
        toolInput: { name: "Acme Corp" },
        idempotencyKey: "k-workspace",
      })
    );

    const recordArgs = mockRecord.mock.calls[0]?.[0];
    expect(recordArgs?.toolInput).toEqual({ name: "Acme Corp" });
  });

  it("sends the ENRICHED toolInput to renderApprovalMessage, not the raw request body", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        ...MOCK_BODY,
        toolInput: { title: "x", whatToBuild: "y", acceptanceCriteria: ["ac1"] },
      })
    );

    const renderedInput = mockRender.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(renderedInput).toHaveProperty("_brief");
  });

  it("#1338 PR②: with the model-selection-learning flag off (the default — no MODEL_SELECTION_LEARNING_* env set), the enriched _brief carries NO modelSelectionReason key at all — byte-identical to before #1338", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        ...MOCK_BODY,
        toolInput: {
          title: "Add dark mode toggle",
          whatToBuild: "A settings toggle that persists across reload.",
          acceptanceCriteria: ["Toggle in settings"],
        },
      })
    );

    const recordArgs = mockRecord.mock.calls[0]?.[0];
    const brief = (recordArgs?.toolInput as Record<string, unknown>)?._brief as Record<string, unknown>;
    expect(brief).not.toHaveProperty("modelSelectionReason");
  });

  it("a malformed create_issue toolInput (missing whatToBuild, non-array acceptanceCriteria) never throws — degrades gracefully, still 201", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    const res = await POST(
      req({
        ...MOCK_BODY,
        toolInput: { title: "only a title", acceptanceCriteria: "not-an-array" },
      })
    );

    expect(res.status).toBe(201);
  });
});

describe("POST /api/v1/runner/approvals — Task 12 investigation issue-link stamping (create_issue only)", () => {
  it("INJECTION GUARD: a caller-supplied _investigation is stripped even when the session is unanchored — never passed through as-is", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never); // no anchoredInvestigationId
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        ...MOCK_BODY,
        toolInput: {
          title: "Add dark mode toggle",
          acceptanceCriteria: ["y"],
          _investigation: { id: "attacker-inv", role: "mitigative" },
        },
      })
    );

    const recordArgs = mockRecord.mock.calls[0]?.[0];
    expect(recordArgs?.toolInput).not.toHaveProperty("_investigation");
    expect(mockGetInvestigation).not.toHaveBeenCalled();
  });

  it("INJECTION GUARD: a caller-supplied _investigation is stripped and replaced with the server-computed one when the session IS anchored — attacker cannot pick their own investigation id or role", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_ANCHORED as never);
    mockGetInvestigation.mockResolvedValue(MOCK_INVESTIGATION as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        ...MOCK_BODY,
        toolInput: {
          title: "Add dark mode toggle",
          acceptanceCriteria: ["y"],
          requiredContext: "Role: mitigative",
          _investigation: { id: "attacker-inv", role: "preventative" },
        },
      })
    );

    const recordArgs = mockRecord.mock.calls[0]?.[0];
    const stamped = (recordArgs?.toolInput as Record<string, unknown>)?._investigation;
    expect(stamped).toEqual({ id: "inv-1", role: "mitigative" });
  });

  it("stamps _investigation with role: mitigative parsed from an explicit Role line in requiredContext", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_ANCHORED as never);
    mockGetInvestigation.mockResolvedValue(MOCK_INVESTIGATION as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        ...MOCK_BODY,
        toolInput: {
          title: "Fix checkout 500",
          requiredContext: "Some context first.\nRole: mitigative\nMore context after.",
          acceptanceCriteria: [],
        },
      })
    );

    const recordArgs = mockRecord.mock.calls[0]?.[0];
    expect((recordArgs?.toolInput as Record<string, unknown>)?._investigation).toEqual({
      id: "inv-1",
      role: "mitigative",
    });
  });

  it("stamps _investigation with role: preventative parsed from an explicit Role line in requiredContext", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_ANCHORED as never);
    mockGetInvestigation.mockResolvedValue(MOCK_INVESTIGATION as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        ...MOCK_BODY,
        toolInput: {
          title: "Prevent this class of bug",
          requiredContext: "Role: preventative",
          acceptanceCriteria: [],
        },
      })
    );

    const recordArgs = mockRecord.mock.calls[0]?.[0];
    expect((recordArgs?.toolInput as Record<string, unknown>)?._investigation).toEqual({
      id: "inv-1",
      role: "preventative",
    });
  });

  it("DEFAULT CASE: defaults role to preventative when requiredContext has no Role line at all", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_ANCHORED as never);
    mockGetInvestigation.mockResolvedValue(MOCK_INVESTIGATION as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        ...MOCK_BODY,
        toolInput: {
          title: "x",
          requiredContext: "Just some prose, no role stated anywhere.",
          acceptanceCriteria: [],
        },
      })
    );

    const recordArgs = mockRecord.mock.calls[0]?.[0];
    expect((recordArgs?.toolInput as Record<string, unknown>)?._investigation).toEqual({
      id: "inv-1",
      role: "preventative",
    });
  });

  it("MALFORMED LINE: defaults role to preventative when a Role line is present but its value isn't exactly mitigative|preventative", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_ANCHORED as never);
    mockGetInvestigation.mockResolvedValue(MOCK_INVESTIGATION as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        ...MOCK_BODY,
        toolInput: { title: "x", requiredContext: "Role: fixit-now", acceptanceCriteria: [] },
      })
    );

    const recordArgs = mockRecord.mock.calls[0]?.[0];
    expect((recordArgs?.toolInput as Record<string, unknown>)?._investigation).toEqual({
      id: "inv-1",
      role: "preventative",
    });
  });

  it("does NOT stamp when the session has no anchored investigation (anchoredInvestigationId absent) — no _investigation key at all, getInvestigationById never called", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        ...MOCK_BODY,
        toolInput: { title: "x", requiredContext: "Role: mitigative", acceptanceCriteria: [] },
      })
    );

    const recordArgs = mockRecord.mock.calls[0]?.[0];
    expect(recordArgs?.toolInput).not.toHaveProperty("_investigation");
    expect(mockGetInvestigation).not.toHaveBeenCalled();
  });

  it("does NOT stamp when the anchored investigation belongs to a DIFFERENT workspace (T3/T4 precedent: stale/foreign anchor treated identically to unanchored)", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_ANCHORED as never);
    mockGetInvestigation.mockResolvedValue({
      ...MOCK_INVESTIGATION,
      investigation: { ...MOCK_INVESTIGATION.investigation, workspaceId: "ws-foreign-tenant" },
    } as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        ...MOCK_BODY,
        toolInput: { title: "x", requiredContext: "Role: mitigative", acceptanceCriteria: [] },
      })
    );

    const recordArgs = mockRecord.mock.calls[0]?.[0];
    expect(recordArgs?.toolInput).not.toHaveProperty("_investigation");
  });

  it("does NOT stamp (and does not throw) when the anchor points at an investigation id that no longer resolves", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_ANCHORED as never);
    mockGetInvestigation.mockResolvedValue(null);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    const res = await POST(req({ ...MOCK_BODY, toolInput: { title: "x", acceptanceCriteria: [] } }));

    expect(res.status).toBe(201);
    const recordArgs = mockRecord.mock.calls[0]?.[0];
    expect(recordArgs?.toolInput).not.toHaveProperty("_investigation");
  });

  it("degrades gracefully (still 201, no _investigation) when getInvestigationById throws — mirrors _brief's own fail-safe direction, same catch-and-fall-back posture", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_ANCHORED as never);
    mockGetInvestigation.mockRejectedValue(new Error("db down"));
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    const res = await POST(req({ ...MOCK_BODY, toolInput: { title: "x", acceptanceCriteria: [] } }));

    expect(res.status).toBe(201);
    const recordArgs = mockRecord.mock.calls[0]?.[0];
    expect(recordArgs?.toolInput).not.toHaveProperty("_investigation");
  });

  it("does not affect non-create_issue tools even with an anchored session — no _investigation stamped, getInvestigationById never called", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_ANCHORED as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        eveSessionId: "eve-session-1",
        toolName: "create_workspace",
        toolInput: { name: "Acme Corp" },
        idempotencyKey: "k-workspace-anchored",
      })
    );

    expect(mockGetInvestigation).not.toHaveBeenCalled();
    const recordArgs = mockRecord.mock.calls[0]?.[0];
    expect(recordArgs?.toolInput).toEqual({ name: "Acme Corp" });
  });

  it("REGRESSION: _brief enrichment is untouched by the _investigation stamp — both keys coexist correctly on the same call", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_ANCHORED as never);
    mockGetInvestigation.mockResolvedValue(MOCK_INVESTIGATION as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(
      req({
        ...MOCK_BODY,
        toolInput: {
          title: "Add dark mode toggle",
          whatToBuild: "A settings toggle that persists across reload.",
          acceptanceCriteria: ["Toggle in settings"],
          requiredContext: "Role: mitigative",
        },
      })
    );

    const recordArgs = mockRecord.mock.calls[0]?.[0];
    const toolInput = recordArgs?.toolInput as Record<string, unknown>;
    const brief = toolInput._brief as Record<string, unknown>;
    expect(brief).toBeDefined();
    expect(typeof brief.taskType).toBe("string");
    expect(toolInput._investigation).toEqual({ id: "inv-1", role: "mitigative" });
  });
});

describe("POST /api/v1/runner/approvals — rich Telegram send (best-effort)", () => {
  it("renders the message from toolName/toolInput and sends it with an Approve/Deny keyboard to the session's conversation", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    await POST(req(MOCK_BODY));

    // MOCK_BODY.toolName is create_issue, so the RENDERED toolInput is the
    // #1274 PR ② enriched one (carries an extra `_brief` on top of the
    // original fields) — objectContaining proves the original fields still
    // reach the renderer; the enrichment's own contract is covered by the
    // dedicated "#1274 PR ② chat-born enrichment" describe block above.
    expect(mockRender).toHaveBeenCalledWith(
      "create_issue",
      expect.objectContaining(MOCK_BODY.toolInput)
    );
    expect(mockBuildKeyboard).toHaveBeenCalledWith("cbtoken123456");
    expect(mockSend).toHaveBeenCalledWith(
      "test-bot-token",
      "-100123",
      "rendered approval text",
      { inline_keyboard: [[]] }
    );
  });

  it("still responds 201 when the Telegram send fails (best-effort, never blocks the record)", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);
    mockSend.mockResolvedValue({ ok: false, error: "boom" } as never);

    const res = await POST(req(MOCK_BODY));

    expect(res.status).toBe(201);
  });

  it("still responds 201 when the Telegram send throws unexpectedly", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);
    mockSend.mockRejectedValue(new Error("network down"));

    const res = await POST(req(MOCK_BODY));

    expect(res.status).toBe(201);
  });

  it("skips the send (no throw, still 201) when TELEGRAM_BOT_TOKEN is unset", async () => {
    delete process.env["TELEGRAM_BOT_TOKEN"];
    mockGetSession.mockResolvedValue(MOCK_SESSION_WS as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    const res = await POST(req(MOCK_BODY));

    expect(res.status).toBe(201);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("skips the send (no throw, still 201) for a non-telegram channel", async () => {
    mockGetSession.mockResolvedValue({
      ...MOCK_SESSION_WS,
      channel: "slack",
    } as never);
    mockRecord.mockResolvedValue({ approval: MOCK_APPROVAL, created: true } as never);

    const res = await POST(req(MOCK_BODY));

    expect(res.status).toBe(201);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
