import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./slack-bot", () => ({
  sendSlackChannelMessage: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getSlackInstallation: vi.fn(),
}));

import { sendSlackChannelMessage } from "./slack-bot";
import { getSlackInstallation } from "@agentrail/db-postgres";
import { sendSystemSlackMessage } from "./slack-system-message";

const mockSend = vi.mocked(sendSlackChannelMessage);
const mockGetInstallation = vi.mocked(getSlackInstallation);

const TEAM_A = "TEAM_A";
const TEAM_B = "TEAM_B";

function installation(overrides: Partial<{ teamId: string; botToken: string }> = {}) {
  return {
    teamId: overrides.teamId ?? TEAM_A,
    teamName: "Acme",
    botToken: overrides.botToken ?? `xoxb-${overrides.teamId ?? TEAM_A}-secret`,
    botUserId: "UBOT1",
    enterpriseId: null,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue({ ok: true });
  mockGetInstallation.mockImplementation(async (teamId: string) =>
    teamId === TEAM_A ? installation({ teamId: TEAM_A }) : null
  );
});

describe("sendSystemSlackMessage", () => {
  it("returns a typed failure and never touches the send when teamId is undefined", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await sendSystemSlackMessage(undefined, "C123", "hi");

    expect(result).toEqual({ ok: false, error: "No Slack team id — cannot resolve installation." });
    expect(mockGetInstallation).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns a typed failure and never touches the send when teamId is blank", async () => {
    const result = await sendSystemSlackMessage("   ", "C123", "hi");
    expect(result).toEqual({ ok: false, error: "No Slack team id — cannot resolve installation." });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns a typed failure, logs a reason, and never sends when the team has no active installation (never installed, uninstalled, or revoked)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockGetInstallation.mockResolvedValue(null);

    const result = await sendSystemSlackMessage(TEAM_A, "C123", "hi");

    expect(result).toEqual({ ok: false, error: "No active Slack installation for this team." });
    expect(mockSend).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(TEAM_A));
    warnSpy.mockRestore();
  });

  it("resolves the installation by teamId and sends with THAT team's own bot token", async () => {
    await sendSystemSlackMessage(TEAM_A, "C123", "hi");

    expect(mockGetInstallation).toHaveBeenCalledWith(TEAM_A);
    expect(mockSend).toHaveBeenCalledWith("xoxb-TEAM_A-secret", "C123", "hi", undefined);
  });

  // The cross-tenant guarantee this whole design exists for: two different
  // teams' sends resolve two DIFFERENT tokens, and neither ever sees the
  // other's.
  it("cross-tenant: team A's send uses A's token, team B's send uses B's token, never swapped", async () => {
    mockGetInstallation.mockImplementation(async (teamId: string) =>
      teamId === TEAM_A
        ? installation({ teamId: TEAM_A, botToken: "xoxb-A-secret" })
        : teamId === TEAM_B
          ? installation({ teamId: TEAM_B, botToken: "xoxb-B-secret" })
          : null
    );

    await sendSystemSlackMessage(TEAM_A, "C-A", "hello A");
    await sendSystemSlackMessage(TEAM_B, "C-B", "hello B");

    expect(mockSend).toHaveBeenNthCalledWith(1, "xoxb-A-secret", "C-A", "hello A", undefined);
    expect(mockSend).toHaveBeenNthCalledWith(2, "xoxb-B-secret", "C-B", "hello B", undefined);
    expect(mockSend).not.toHaveBeenCalledWith("xoxb-B-secret", "C-A", expect.anything(), expect.anything());
    expect(mockSend).not.toHaveBeenCalledWith("xoxb-A-secret", "C-B", expect.anything(), expect.anything());
  });

  // Final whole-branch review, finding #1: this wrapper must forward a
  // caller-supplied thread id through to sendSlackChannelMessage so the
  // console's own system sends (workspace picker, /connect, pin
  // confirmation) land in the right thread instead of posting flat.
  it("forwards a thread id through to sendSlackChannelMessage", async () => {
    await sendSystemSlackMessage(TEAM_A, "C123", "hi", "1700000000.000100");

    expect(mockSend).toHaveBeenCalledWith("xoxb-TEAM_A-secret", "C123", "hi", "1700000000.000100");
  });

  it("passes no thread id through when none is given (a DM)", async () => {
    await sendSystemSlackMessage(TEAM_A, "D0PNCRP9N", "hi");

    expect(mockSend).toHaveBeenCalledWith("xoxb-TEAM_A-secret", "D0PNCRP9N", "hi", undefined);
  });
});
