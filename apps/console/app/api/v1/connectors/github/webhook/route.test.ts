import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  findWorkspaceByRepo: vi.fn(),
  getConnector: vi.fn(),
  enqueueGithubIssue: vi.fn(),
  githubIssueUrl: (repoFullName: string, number: number) =>
    `https://github.com/${repoFullName}/issues/${number}`,
  latestTelegramSessionForWorkspace: vi.fn(),
  recordApprovalRequest: vi.fn(),
}));

vi.mock("../../../../../../lib/approval-message", () => ({
  renderApprovalMessage: vi.fn(),
}));

vi.mock("../../../../../../lib/alignment-brief", () => ({
  composeAlignmentBrief: vi.fn(),
}));

vi.mock("../../../workspaces/[workspaceId]/connectors/secret/telegram", () => ({
  sendTelegramMessage: vi.fn(),
  buildApprovalKeyboard: vi.fn(),
}));

import { POST } from "./route";
import {
  findWorkspaceByRepo,
  getConnector,
  enqueueGithubIssue,
  latestTelegramSessionForWorkspace,
  recordApprovalRequest,
} from "@agentrail/db-postgres";
import { renderApprovalMessage } from "../../../../../../lib/approval-message";
import { composeAlignmentBrief } from "../../../../../../lib/alignment-brief";
import {
  sendTelegramMessage,
  buildApprovalKeyboard,
} from "../../../workspaces/[workspaceId]/connectors/secret/telegram";

const mockFindWorkspace = vi.mocked(findWorkspaceByRepo);
const mockGetConnector = vi.mocked(getConnector);
const mockEnqueue = vi.mocked(enqueueGithubIssue);
const mockLatestSession = vi.mocked(latestTelegramSessionForWorkspace);
const mockRecord = vi.mocked(recordApprovalRequest);
const mockRender = vi.mocked(renderApprovalMessage);
const mockCompose = vi.mocked(composeAlignmentBrief);
const mockSend = vi.mocked(sendTelegramMessage);
const mockBuildKeyboard = vi.mocked(buildApprovalKeyboard);

const ORIGINAL_TOKEN_ENV = process.env["TELEGRAM_BOT_TOKEN"];
const ORIGINAL_SECRET_ENV = process.env["GITHUB_WEBHOOK_SECRET"];

function req(body: unknown, event = "issues"): NextRequest {
  return new NextRequest("http://localhost/api/v1/connectors/github/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": event },
    body: JSON.stringify(body),
  });
}

const ISSUE_PAYLOAD = {
  action: "opened",
  issue: {
    number: 42,
    title: "Add dark mode",
    body: "## Acceptance criteria\n- [ ] Toggle in settings\n",
    labels: [{ name: "ready-for-agent" }],
  },
  repository: { full_name: "acme/widgets" },
};

const BRIEF = {
  title: "Add dark mode",
  whatToBuild: "## Acceptance criteria\n- [ ] Toggle in settings\n",
  acceptanceCriteria: ["Toggle in settings"],
  taskType: "ui" as const,
  suggestedModel: { slug: "anthropic/claude-sonnet-5", displayName: "Claude Sonnet 5" },
  estimateUsd: 1.35,
  assumptions: ["an assumption"],
  repoFullName: "acme/widgets",
  issueNumber: 42,
  issueUrl: "https://github.com/acme/widgets/issues/42",
};

const TELEGRAM_SESSION = {
  id: "session-1",
  workspaceId: "ws-1",
  chatIdentityId: "chat-1",
  channel: "telegram",
  conversationKey: "-100123",
  eveSessionId: "eve-session-1",
  status: "active",
  lastActivityAt: new Date("2026-07-18T00:00:00Z"),
  createdAt: new Date("2026-07-18T00:00:00Z"),
  updatedAt: new Date("2026-07-18T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env["TELEGRAM_BOT_TOKEN"] = "test-bot-token";
  delete process.env["GITHUB_WEBHOOK_SECRET"]; // signature check off by default in these tests
  mockFindWorkspace.mockResolvedValue("ws-1");
  mockGetConnector.mockResolvedValue({
    config: { triggerLabel: "ready-for-agent" },
  } as never);
  mockCompose.mockReturnValue(BRIEF);
  mockRender.mockReturnValue("rendered alignment brief text");
  mockBuildKeyboard.mockReturnValue({ inline_keyboard: [[]] } as never);
  mockSend.mockResolvedValue({ ok: true } as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (ORIGINAL_TOKEN_ENV === undefined) delete process.env["TELEGRAM_BOT_TOKEN"];
  else process.env["TELEGRAM_BOT_TOKEN"] = ORIGINAL_TOKEN_ENV;
  if (ORIGINAL_SECRET_ENV === undefined) delete process.env["GITHUB_WEBHOOK_SECRET"];
  else process.env["GITHUB_WEBHOOK_SECRET"] = ORIGINAL_SECRET_ENV;
  vi.restoreAllMocks();
});

describe("POST /api/v1/connectors/github/webhook — pre-existing routing (regression pin)", () => {
  it("ignores a non-'issues' event without touching enqueue", async () => {
    const res = await POST(req(ISSUE_PAYLOAD, "ping"));
    expect(await res.json()).toEqual({ ignored: "ping" });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("reports matched:false when the action is not a trigger action", async () => {
    const res = await POST(req({ ...ISSUE_PAYLOAD, action: "closed" }));
    const body = await res.json();
    expect(body.matched).toBe(false);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("reports matched:false when no workspace owns the repo", async () => {
    mockFindWorkspace.mockResolvedValue(null);
    const res = await POST(req(ISSUE_PAYLOAD));
    const body = await res.json();
    expect(body).toEqual({ matched: false, reason: "no workspace owns this repo" });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("reports matched:false when the trigger label is absent", async () => {
    const res = await POST(
      req({ ...ISSUE_PAYLOAD, issue: { ...ISSUE_PAYLOAD.issue, labels: [] } })
    );
    const body = await res.json();
    expect(body).toEqual({ matched: false, reason: "trigger label not on issue" });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("passes through a not-enqueued result unchanged (byte-identical response shape)", async () => {
    mockEnqueue.mockResolvedValue({ enqueued: false, reason: "no 'Acceptance criteria' section" } as never);
    const res = await POST(req(ISSUE_PAYLOAD));
    const body = await res.json();
    expect(body).toEqual({
      matched: true,
      enqueued: 0,
      reason: "no 'Acceptance criteria' section",
    });
    expect(mockCompose).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/connectors/github/webhook — clean admit (regression pin: no alignment posting)", () => {
  it("responds with the ORIGINAL {matched,enqueued,id} shape and never touches the brief pipeline when state is 'queued'", async () => {
    mockEnqueue.mockResolvedValue({
      enqueued: true,
      id: "entry-1",
      state: "queued",
      blockedBy: [],
    } as never);

    const res = await POST(req(ISSUE_PAYLOAD));
    const body = await res.json();

    expect(body).toEqual({ matched: true, enqueued: 1, id: "entry-1" });
    expect(mockCompose).not.toHaveBeenCalled();
    expect(mockLatestSession).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("never touches the brief pipeline for a dependency/guardrail park (parkedFor absent)", async () => {
    mockEnqueue.mockResolvedValue({
      enqueued: true,
      id: "entry-1",
      state: "parked",
      blockedBy: [12],
      // no parkedFor — this is a dependency park, not the alignment hold.
    } as never);

    const res = await POST(req(ISSUE_PAYLOAD));
    const body = await res.json();

    expect(body).toEqual({ matched: true, enqueued: 1, id: "entry-1" });
    expect(mockCompose).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/connectors/github/webhook — alignment hold: park -> compose -> record -> send", () => {
  function parkedResult() {
    return {
      enqueued: true,
      id: "entry-1",
      state: "parked",
      blockedBy: [],
      parkedFor: "awaiting_alignment",
    } as never;
  }

  it("composes the brief from the issue's title/body/repo/number and the shared issueUrl builder", async () => {
    mockEnqueue.mockResolvedValue(parkedResult());
    mockLatestSession.mockResolvedValue(TELEGRAM_SESSION as never);
    mockRecord.mockResolvedValue({
      approval: { id: "approval-1", callbackToken: "cbtoken123" },
      created: true,
    } as never);

    await POST(req(ISSUE_PAYLOAD));

    expect(mockCompose).toHaveBeenCalledWith({
      title: "Add dark mode",
      body: "## Acceptance criteria\n- [ ] Toggle in settings\n",
      repoFullName: "acme/widgets",
      issueNumber: 42,
      issueUrl: "https://github.com/acme/widgets/issues/42",
    });
  });

  it("records the approval anchored to the workspace's latest Telegram session, with queueEntryId set", async () => {
    mockEnqueue.mockResolvedValue(parkedResult());
    mockLatestSession.mockResolvedValue(TELEGRAM_SESSION as never);
    mockRecord.mockResolvedValue({
      approval: { id: "approval-1", callbackToken: "cbtoken123" },
      created: true,
    } as never);

    await POST(req(ISSUE_PAYLOAD));

    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        chatIdentityId: "chat-1",
        sessionId: "session-1",
        eveSessionId: "eve-session-1",
        toolName: "alignment_brief",
        toolInput: BRIEF,
        approveOptionId: "approve",
        denyOptionId: "deny",
        queueEntryId: "entry-1",
      })
    );
  });

  it("renders + sends the brief with an Approve/Deny keyboard to the session's conversation", async () => {
    mockEnqueue.mockResolvedValue(parkedResult());
    mockLatestSession.mockResolvedValue(TELEGRAM_SESSION as never);
    mockRecord.mockResolvedValue({
      approval: { id: "approval-1", callbackToken: "cbtoken123" },
      created: true,
    } as never);

    const res = await POST(req(ISSUE_PAYLOAD));
    const body = await res.json();

    expect(mockRender).toHaveBeenCalledWith("alignment_brief", BRIEF);
    expect(mockBuildKeyboard).toHaveBeenCalledWith("cbtoken123");
    expect(mockSend).toHaveBeenCalledWith(
      "test-bot-token",
      "-100123",
      "rendered alignment brief text",
      { inline_keyboard: [[]] }
    );
    expect(body).toEqual({
      matched: true,
      enqueued: 1,
      id: "entry-1",
      alignmentBrief: "posted",
    });
  });

  it("no-session path: logs loudly, records NO approval, still responds 200 — the entry stays honestly parked", async () => {
    mockEnqueue.mockResolvedValue(parkedResult());
    mockLatestSession.mockResolvedValue(null);

    const res = await POST(req(ISSUE_PAYLOAD));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      matched: true,
      enqueued: 1,
      id: "entry-1",
      alignmentBrief: "no_session",
    });
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it("a session with no eveSessionId (never had a real Eve turn) is treated the same as no session", async () => {
    mockEnqueue.mockResolvedValue(parkedResult());
    mockLatestSession.mockResolvedValue({ ...TELEGRAM_SESSION, eveSessionId: null } as never);

    const res = await POST(req(ISSUE_PAYLOAD));
    const body = await res.json();

    expect(body.alignmentBrief).toBe("no_session");
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("send failure: still responds 200 with alignmentBrief:'send_failed' — the approval row already exists", async () => {
    mockEnqueue.mockResolvedValue(parkedResult());
    mockLatestSession.mockResolvedValue(TELEGRAM_SESSION as never);
    mockRecord.mockResolvedValue({
      approval: { id: "approval-1", callbackToken: "cbtoken123" },
      created: true,
    } as never);
    mockSend.mockResolvedValue({ ok: false, error: "boom" } as never);

    const res = await POST(req(ISSUE_PAYLOAD));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alignmentBrief).toBe("send_failed");
    expect(console.error).toHaveBeenCalled();
  });

  it("send throwing unexpectedly is caught: still responds 200 with 'send_failed'", async () => {
    mockEnqueue.mockResolvedValue(parkedResult());
    mockLatestSession.mockResolvedValue(TELEGRAM_SESSION as never);
    mockRecord.mockResolvedValue({
      approval: { id: "approval-1", callbackToken: "cbtoken123" },
      created: true,
    } as never);
    mockSend.mockRejectedValue(new Error("network down"));

    const res = await POST(req(ISSUE_PAYLOAD));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alignmentBrief).toBe("send_failed");
  });

  it("missing TELEGRAM_BOT_TOKEN: approval still recorded, send skipped, 'send_failed' reported", async () => {
    delete process.env["TELEGRAM_BOT_TOKEN"];
    mockEnqueue.mockResolvedValue(parkedResult());
    mockLatestSession.mockResolvedValue(TELEGRAM_SESSION as never);
    mockRecord.mockResolvedValue({
      approval: { id: "approval-1", callbackToken: "cbtoken123" },
      created: true,
    } as never);

    const res = await POST(req(ISSUE_PAYLOAD));
    const body = await res.json();

    expect(mockRecord).toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(body.alignmentBrief).toBe("send_failed");
  });

  it("recordApprovalRequest failure: caught, logged, 200 with 'record_failed' — entry stays parked", async () => {
    mockEnqueue.mockResolvedValue(parkedResult());
    mockLatestSession.mockResolvedValue(TELEGRAM_SESSION as never);
    mockRecord.mockRejectedValue(new Error("db down"));

    const res = await POST(req(ISSUE_PAYLOAD));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alignmentBrief).toBe("record_failed");
    expect(mockSend).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
});
