import { describe, it, expect, vi, beforeEach } from "vitest";

// Closed factory (an unlisted query fn stays undefined → loud crash), EXCEPT
// ONBOARD_EXTERNAL_ID_PREFIX which is picked from the REAL module: it is the
// single-source prefix constant (#1268 fix round), and a literal copy here
// would be exactly the drift-prone duplication the constant exists to kill.
vi.mock("@agentrail/db-postgres", async (importActual) => {
  const actual =
    await importActual<typeof import("@agentrail/db-postgres")>();
  return {
    ONBOARD_EXTERNAL_ID_PREFIX: actual.ONBOARD_EXTERNAL_ID_PREFIX,
    latestTelegramSessionForWorkspace: vi.fn(),
  };
});
vi.mock("../../../../../lib/telegram-system-message", () => ({
  sendSystemTelegramMessage: vi.fn(),
}));

import {
  onboardRepoFullName,
  buildOnboardOutcomeMessage,
  notifyOnboardOutcome,
} from "./onboard-notify";
import { latestTelegramSessionForWorkspace } from "@agentrail/db-postgres";
import { sendSystemTelegramMessage } from "../../../../../lib/telegram-system-message";

const mockLatestSession = vi.mocked(latestTelegramSessionForWorkspace);
const mockSend = vi.mocked(sendSystemTelegramMessage);

const WS = "ws-1";

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

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue({ ok: true } as never);
});

describe("onboardRepoFullName", () => {
  it("extracts the repo full name from an onboard-kind external id", () => {
    expect(onboardRepoFullName("onboard:acme/widgets")).toBe("acme/widgets");
  });

  it("returns null for an issue-kind external id (slug#n)", () => {
    expect(onboardRepoFullName("acme/widgets#42")).toBeNull();
  });

  it("returns null for an issue-kind external id (full GitHub URL)", () => {
    expect(
      onboardRepoFullName("https://github.com/acme/widgets/issues/42")
    ).toBeNull();
  });
});

describe("buildOnboardOutcomeMessage", () => {
  it("green: names the repo, says it's indexed, invites codebase questions", () => {
    const msg = buildOnboardOutcomeMessage("acme/widgets", "green");
    expect(msg).toContain("acme/widgets");
    expect(msg).toContain("indexed");
    expect(msg.toLowerCase()).toMatch(/ask|questions/);
  });

  it("escalated-to-human: honest 'didn't finish', no retry theater", () => {
    const msg = buildOnboardOutcomeMessage("acme/widgets", "escalated-to-human");
    expect(msg).toContain("acme/widgets");
    expect(msg).toMatch(/didn't finish/i);
    expect(msg).not.toMatch(/PR ready/i);
    // No retry theater: never implies another automatic attempt is coming.
    expect(msg.toLowerCase()).toContain("no more automatic retries");
  });

  it("blocked: same honest non-green copy as escalated-to-human (forward-compat)", () => {
    const msg = buildOnboardOutcomeMessage("acme/widgets", "blocked");
    expect(msg).toMatch(/didn't finish/i);
    expect(msg).not.toMatch(/PR ready/i);
  });

  it("carries no markdown — plain text only", () => {
    const msg = buildOnboardOutcomeMessage("acme/widgets", "green");
    expect(msg).not.toMatch(/[*_`[\]]/);
  });
});

describe("notifyOnboardOutcome", () => {
  it("sends into the workspace's most recently active telegram session", async () => {
    mockLatestSession.mockResolvedValue(SESSION as never);

    await notifyOnboardOutcome(WS, "acme/widgets", "green");

    expect(mockLatestSession).toHaveBeenCalledWith(WS);
    expect(mockSend).toHaveBeenCalledWith(
      "tg-chat-onboard",
      buildOnboardOutcomeMessage("acme/widgets", "green")
    );
  });

  it("does nothing (but logs) when the workspace has no telegram session bound", async () => {
    mockLatestSession.mockResolvedValue(null);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        notifyOnboardOutcome(WS, "acme/widgets", "green")
      ).resolves.toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(WS));
    } finally {
      logSpy.mockRestore();
    }
  });

  it("propagates a session-lookup failure — the caller owns the best-effort contract", async () => {
    mockLatestSession.mockRejectedValue(new Error("db blip"));

    await expect(
      notifyOnboardOutcome(WS, "acme/widgets", "green")
    ).rejects.toThrow("db blip");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("logs a TYPED send failure ({ok:false}) and still resolves", async () => {
    mockLatestSession.mockResolvedValue(SESSION as never);
    mockSend.mockResolvedValue({
      ok: false,
      error: "telegram: bot blocked by the user",
    } as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        notifyOnboardOutcome(WS, "acme/widgets", "green")
      ).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        "[runner/result] onboard-complete notice send failed:",
        "telegram: bot blocked by the user"
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does NOT log an error on a successful ({ok:true}) send", async () => {
    mockLatestSession.mockResolvedValue(SESSION as never);
    mockSend.mockResolvedValue({ ok: true } as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await notifyOnboardOutcome(WS, "acme/widgets", "green");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
