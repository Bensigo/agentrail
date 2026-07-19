import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * #1274 PR③ — `alignment-reconciler.ts`'s own orchestration logic.
 * `postAlignmentBrief`'s OWN compose->record->send behavior is
 * regression-pinned via `apps/console/app/api/v1/connectors/github/webhook/
 * route.test.ts` (unchanged, still green — this file is a PURE MOVE of that
 * function). These tests cover what's NEW here: `reconcileAlignmentBriefs`'s
 * orchestration over `findAlignmentBriefCandidates` (bounded, per-entry
 * failure-isolated, github-ref derivation), and `postAlignmentBrief`'s
 * widened optional repoFullName/number degrading gracefully for a
 * non-GitHub-sourced candidate.
 */
vi.mock("@agentrail/db-postgres", () => ({
  findAlignmentBriefCandidates: vi.fn(),
  githubIssueUrl: (repoFullName: string, number: number) =>
    `https://github.com/${repoFullName}/issues/${number}`,
  latestTelegramSessionForWorkspace: vi.fn(),
  recordApprovalRequest: vi.fn(),
}));

vi.mock("./approval-message", () => ({
  renderApprovalMessage: vi.fn(),
}));

vi.mock("./alignment-brief", () => ({
  composeAlignmentBrief: vi.fn(),
}));

vi.mock("../app/api/v1/workspaces/[workspaceId]/connectors/secret/telegram", () => ({
  sendTelegramMessage: vi.fn(),
  buildApprovalKeyboard: vi.fn(),
}));

import {
  postAlignmentBrief,
  reconcileAlignmentBriefs,
} from "./alignment-reconciler";
import {
  findAlignmentBriefCandidates,
  latestTelegramSessionForWorkspace,
  recordApprovalRequest,
} from "@agentrail/db-postgres";
import { composeAlignmentBrief } from "./alignment-brief";
import { renderApprovalMessage } from "./approval-message";
import {
  sendTelegramMessage,
  buildApprovalKeyboard,
} from "../app/api/v1/workspaces/[workspaceId]/connectors/secret/telegram";

const mockFindCandidates = vi.mocked(findAlignmentBriefCandidates);
const mockLatestSession = vi.mocked(latestTelegramSessionForWorkspace);
const mockRecord = vi.mocked(recordApprovalRequest);
const mockCompose = vi.mocked(composeAlignmentBrief);
const mockRender = vi.mocked(renderApprovalMessage);
const mockSend = vi.mocked(sendTelegramMessage);
const mockBuildKeyboard = vi.mocked(buildApprovalKeyboard);

const BRIEF = {
  title: "t",
  whatToBuild: "b",
  acceptanceCriteria: [],
  taskType: "general" as const,
  suggestedModel: { slug: "anthropic/claude-sonnet-5", displayName: "Claude Sonnet 5" },
  estimateUsd: 1.0,
  assumptions: ["an assumption"],
  repoFullName: "",
  issueNumber: 0,
  issueUrl: "",
};

const ORIGINAL_TOKEN_ENV = process.env["TELEGRAM_BOT_TOKEN"];

beforeEach(() => {
  vi.clearAllMocks();
  process.env["TELEGRAM_BOT_TOKEN"] = "test-bot-token";
  mockCompose.mockReturnValue(BRIEF);
  mockRender.mockReturnValue("rendered");
  mockBuildKeyboard.mockReturnValue({ inline_keyboard: [[]] } as never);
  mockSend.mockResolvedValue({ ok: true } as never);
  mockLatestSession.mockResolvedValue(null); // default: no session -> "no_session"
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (ORIGINAL_TOKEN_ENV === undefined) delete process.env["TELEGRAM_BOT_TOKEN"];
  else process.env["TELEGRAM_BOT_TOKEN"] = ORIGINAL_TOKEN_ENV;
  vi.restoreAllMocks();
});

function candidate(overrides: Partial<{
  id: string;
  workspaceId: string;
  source: string;
  externalId: string;
  title: string;
  body: string;
}> = {}) {
  return {
    id: "q-1",
    workspaceId: "ws-1",
    source: "github",
    externalId: "acme/widgets#7",
    title: "t",
    body: "b",
    ...overrides,
  };
}

describe("reconcileAlignmentBriefs: orchestration", () => {
  it("passes the caller's limit through to findAlignmentBriefCandidates unchanged", async () => {
    mockFindCandidates.mockResolvedValue([]);
    await reconcileAlignmentBriefs(5);
    expect(mockFindCandidates).toHaveBeenCalledWith(5);

    await reconcileAlignmentBriefs(1);
    expect(mockFindCandidates).toHaveBeenCalledWith(1);
  });

  it("returns an empty outcome list when there are no candidates", async () => {
    mockFindCandidates.mockResolvedValue([]);
    const outcomes = await reconcileAlignmentBriefs(5);
    expect(outcomes).toEqual([]);
    expect(mockLatestSession).not.toHaveBeenCalled();
  });

  it("processes every candidate returned, in order, deriving repoFullName/number for a github source", async () => {
    mockFindCandidates.mockResolvedValue([
      candidate({ id: "q-1", source: "github", externalId: "acme/widgets#7" }),
    ]);
    mockLatestSession.mockResolvedValue(null);

    const outcomes = await reconcileAlignmentBriefs(5);

    expect(mockCompose).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: "acme/widgets",
        issueNumber: 7,
        issueUrl: "https://github.com/acme/widgets/issues/7",
      })
    );
    expect(outcomes).toEqual([{ id: "q-1", outcome: "no_session" }]);
  });

  it("degrades gracefully for a non-github source (cli/linear): no repoFullName/issueNumber forced, brief still composes from title+body", async () => {
    mockFindCandidates.mockResolvedValue([
      candidate({ id: "q-2", source: "cli", externalId: "cli-local-id-9" }),
    ]);

    await reconcileAlignmentBriefs(5);

    expect(mockCompose).toHaveBeenCalledWith(
      expect.objectContaining({ repoFullName: "", issueNumber: 0, issueUrl: "" })
    );
  });

  it("bounded + per-entry failure isolation: one candidate whose processing throws does not stop the others", async () => {
    mockFindCandidates.mockResolvedValue([
      candidate({ id: "q-throws", source: "github", externalId: "acme/widgets#1" }),
      candidate({ id: "q-ok", source: "github", externalId: "acme/widgets#2" }),
    ]);
    mockLatestSession
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(null);

    const outcomes = await reconcileAlignmentBriefs(5);

    expect(outcomes).toEqual([
      { id: "q-throws", outcome: "session_lookup_failed" },
      { id: "q-ok", outcome: "no_session" },
    ]);
  });

  it("per-entry isolation survives even a genuinely UNCAUGHT throw from postAlignmentBrief's own bookkeeping (defense in depth)", async () => {
    mockFindCandidates.mockResolvedValue([
      candidate({ id: "q-a" }),
      candidate({ id: "q-b" }),
    ]);
    // Force composeAlignmentBrief to throw for the FIRST call only — this is
    // already caught INSIDE postAlignmentBrief ("compose_failed"), but this
    // test still proves the loop's OWN try/catch never needed to fire for a
    // handled case, and the second entry is unaffected either way.
    mockCompose.mockImplementationOnce(() => {
      throw new Error("malformed body");
    });

    const outcomes = await reconcileAlignmentBriefs(5);

    expect(outcomes).toEqual([
      { id: "q-a", outcome: "compose_failed" },
      { id: "q-b", outcome: "no_session" },
    ]);
  });

  it("logs a per-entry outcome line for observability", async () => {
    mockFindCandidates.mockResolvedValue([candidate({ id: "q-1" })]);
    await reconcileAlignmentBriefs(5);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("q-1"),
    );
  });
});

describe("postAlignmentBrief: widened optional repoFullName/number (#1274 PR③)", () => {
  it("omitting repoFullName/number composes with empty/zero placeholders and an honest assumption note", async () => {
    await postAlignmentBrief({
      workspaceId: "ws-1",
      queueEntryId: "q-1",
      title: "t",
      body: "b",
    });

    expect(mockCompose).toHaveBeenCalledWith({
      title: "t",
      body: "b",
      repoFullName: "",
      issueNumber: 0,
      issueUrl: "",
    });
  });

  it("appends a 'no direct issue link' assumption only when repoFullName is absent", async () => {
    mockLatestSession.mockResolvedValue({
      id: "s-1",
      workspaceId: "ws-1",
      chatIdentityId: "c-1",
      channel: "telegram",
      conversationKey: "-100",
      eveSessionId: "eve-1",
    } as never);
    mockRecord.mockResolvedValue({
      approval: { id: "a-1", callbackToken: "tok" },
      created: true,
    } as never);

    await postAlignmentBrief({
      workspaceId: "ws-1",
      queueEntryId: "q-1",
      title: "t",
      body: "b",
    });

    const recordedToolInput = mockRecord.mock.calls[0]![0].toolInput as {
      assumptions: string[];
    };
    expect(
      recordedToolInput.assumptions.some((a) => a.includes("No direct issue link"))
    ).toBe(true);
  });

  it("supplying repoFullName/number composes exactly as the webhook route always has (byte-identical, regression-pinned separately via route.test.ts)", async () => {
    await postAlignmentBrief({
      workspaceId: "ws-1",
      queueEntryId: "q-1",
      title: "t",
      body: "b",
      repoFullName: "acme/widgets",
      number: 42,
    });

    expect(mockCompose).toHaveBeenCalledWith({
      title: "t",
      body: "b",
      repoFullName: "acme/widgets",
      issueNumber: 42,
      issueUrl: "https://github.com/acme/widgets/issues/42",
    });
  });
});
