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
  // #1338 PR② — postAlignmentBrief now calls these two BEFORE composing.
  // parseAcceptanceCriteriaForBrief has a real, trivial implementation here
  // (not vi.fn()) since it's pure and several tests pass bodies through it;
  // resolveModelSelectionForBrief defaults to "flag off" (undefined) so
  // every existing assertion here — which predates #1338 and expects
  // composeAlignmentBrief's call args to have NO modelSelection key at all —
  // stays valid unchanged. See the dedicated "#1338 PR② model selection"
  // describe block below for the flag-on behavior.
  parseAcceptanceCriteriaForBrief: vi.fn((body: string) => {
    const match = /## Acceptance criteria\n([\s\S]*)/.exec(body);
    if (!match) return [];
    return match[1]!
      .split("\n")
      .map((line) => /^- \[[ x]\]\s*(.+)$/.exec(line.trim())?.[1])
      .filter((s): s is string => !!s);
  }),
  resolveModelSelectionForBrief: vi.fn().mockResolvedValue(undefined),
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
import { composeAlignmentBrief, resolveModelSelectionForBrief } from "./alignment-brief";
import { renderApprovalMessage } from "./approval-message";
import {
  sendTelegramMessage,
  buildApprovalKeyboard,
} from "../app/api/v1/workspaces/[workspaceId]/connectors/secret/telegram";

const mockFindCandidates = vi.mocked(findAlignmentBriefCandidates);
const mockLatestSession = vi.mocked(latestTelegramSessionForWorkspace);
const mockRecord = vi.mocked(recordApprovalRequest);
const mockCompose = vi.mocked(composeAlignmentBrief);
const mockResolveModelSelection = vi.mocked(resolveModelSelectionForBrief);
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
  it("passes the caller's workspaceId AND limit through to findAlignmentBriefCandidates unchanged (I2: the sweep is workspace-scoped, never global)", async () => {
    mockFindCandidates.mockResolvedValue([]);
    await reconcileAlignmentBriefs("ws-1", 5);
    expect(mockFindCandidates).toHaveBeenCalledWith("ws-1", 5);

    await reconcileAlignmentBriefs("ws-other", 1);
    expect(mockFindCandidates).toHaveBeenCalledWith("ws-other", 1);
  });

  it("returns an empty outcome list when there are no candidates", async () => {
    mockFindCandidates.mockResolvedValue([]);
    const outcomes = await reconcileAlignmentBriefs("ws-1", 5);
    expect(outcomes).toEqual([]);
    expect(mockLatestSession).not.toHaveBeenCalled();
  });

  it("processes every candidate returned, in order, deriving repoFullName/number for a github source", async () => {
    mockFindCandidates.mockResolvedValue([
      candidate({ id: "q-1", source: "github", externalId: "acme/widgets#7" }),
    ]);
    mockLatestSession.mockResolvedValue(null);

    const outcomes = await reconcileAlignmentBriefs("ws-1", 5);

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

    await reconcileAlignmentBriefs("ws-1", 5);

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

    const outcomes = await reconcileAlignmentBriefs("ws-1", 5);

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

    const outcomes = await reconcileAlignmentBriefs("ws-1", 5);

    expect(outcomes).toEqual([
      { id: "q-a", outcome: "compose_failed" },
      { id: "q-b", outcome: "no_session" },
    ]);
  });

  it("logs a per-entry outcome line for observability", async () => {
    mockFindCandidates.mockResolvedValue([candidate({ id: "q-1" })]);
    await reconcileAlignmentBriefs("ws-1", 5);
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

describe("postAlignmentBrief: created-gate on the send (#1274 PR③ fix round, I1)", () => {
  const SESSION = {
    id: "s-1",
    workspaceId: "ws-1",
    chatIdentityId: "c-1",
    channel: "telegram",
    conversationKey: "-100",
    eveSessionId: "eve-1",
  };

  it("sends ONLY when recordApprovalRequest created the row: two sequential calls for the same entry -> the second (created:false) sends nothing, exactly one send total", async () => {
    // Two CONCURRENT triggers (webhook + result route) can both pass the
    // sweep's NOT-EXISTS check and both reach record; onConflictDoNothing
    // converges them on ONE row — this gate makes exactly one of them the
    // sender. Sequential calls with created:true then created:false model
    // the exact record-level outcome that race produces.
    mockLatestSession.mockResolvedValue(SESSION as never);
    mockRecord
      .mockResolvedValueOnce({
        approval: { id: "a-1", callbackToken: "tok" },
        created: true,
      } as never)
      .mockResolvedValueOnce({
        approval: { id: "a-1", callbackToken: "tok" },
        created: false, // the racer/replay: converged on the existing row
      } as never);

    const first = await postAlignmentBrief({
      workspaceId: "ws-1",
      queueEntryId: "q-1",
      title: "t",
      body: "b",
    });
    const second = await postAlignmentBrief({
      workspaceId: "ws-1",
      queueEntryId: "q-1",
      title: "t",
      body: "b",
    });

    expect(first).toBe("posted");
    expect(second).toBe("posted"); // the brief IS recorded; the creator owned the send
    expect(mockSend).toHaveBeenCalledTimes(1); // exactly one Telegram message, ever
  });

  it("created:false short-circuits BEFORE the token check — a missing TELEGRAM_BOT_TOKEN can no longer misreport a converged replay as send_failed", async () => {
    delete process.env["TELEGRAM_BOT_TOKEN"];
    mockLatestSession.mockResolvedValue(SESSION as never);
    mockRecord.mockResolvedValue({
      approval: { id: "a-1", callbackToken: "tok" },
      created: false,
    } as never);

    const outcome = await postAlignmentBrief({
      workspaceId: "ws-1",
      queueEntryId: "q-1",
      title: "t",
      body: "b",
    });

    expect(outcome).toBe("posted");
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("postAlignmentBrief: model-selection wiring (#1338 PR②)", () => {
  it("calls resolveModelSelectionForBrief with the classification-shaped input and the workspaceId, BEFORE composeAlignmentBrief", async () => {
    await postAlignmentBrief({
      workspaceId: "ws-1",
      queueEntryId: "q-1",
      title: "t",
      body: "## Acceptance criteria\n- [ ] a\n",
    });

    expect(mockResolveModelSelection).toHaveBeenCalledWith(
      { title: "t", whatToBuild: "## Acceptance criteria\n- [ ] a\n", acceptanceCriteria: ["a"] },
      "ws-1"
    );
  });

  it("flag off (the default mock): composeAlignmentBrief is called with NO modelSelection key at all — byte-identical to pre-#1338", async () => {
    await postAlignmentBrief({ workspaceId: "ws-1", queueEntryId: "q-1", title: "t", body: "b" });

    const callArgs = mockCompose.mock.calls[0]?.[0];
    expect(callArgs).not.toHaveProperty("modelSelection");
  });

  it("flag on (resolveModelSelectionForBrief resolves a selection): composeAlignmentBrief receives it as modelSelection", async () => {
    const selection = {
      model: { slug: "anthropic/claude-opus-4.8", displayName: "Claude Opus 4.8", inUsdPerMTok: 5, outUsdPerMTok: 25 },
      reasonText: "Claude Opus 4.8 — best success rate for refactor (7 runs)",
    };
    mockResolveModelSelection.mockResolvedValueOnce(selection);

    await postAlignmentBrief({ workspaceId: "ws-1", queueEntryId: "q-1", title: "t", body: "b" });

    expect(mockCompose).toHaveBeenCalledWith(
      expect.objectContaining({ modelSelection: selection })
    );
  });
});
