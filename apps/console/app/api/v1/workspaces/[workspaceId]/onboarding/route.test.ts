import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  getConnector: vi.fn(),
  getWorkspace: vi.fn(),
  hasActiveSelfHostedRunner: vi.fn(),
  hasAnyJaceReply: vi.fn(),
  listChatIdentitiesForWorkspace: vi.fn(),
  listInvites: vi.fn(),
  listWorkspaceMembers: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  getConnector,
  getWorkspace,
  hasActiveSelfHostedRunner,
  listChatIdentitiesForWorkspace,
  listInvites,
  listWorkspaceMembers,
} from "@agentrail/db-postgres";

const WS = "ws-1";
const USER = "user-1";

function req(): NextRequest {
  return new NextRequest(`http://localhost/api/v1/workspaces/${WS}/onboarding`);
}
function params() {
  return { params: Promise.resolve({ workspaceId: WS }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "member" } as never);
  vi.mocked(getConnector).mockResolvedValue(null);
  // hostedExecution=false + no self-hosted runner = no execution path — the
  // loader derives the disjunct locally from these two reads (see
  // onboarding-data.ts for why it doesn't call workspaceHasExecutionPath).
  vi.mocked(getWorkspace).mockResolvedValue({
    id: WS,
    hostedExecution: false,
  } as never);
  vi.mocked(hasActiveSelfHostedRunner).mockResolvedValue(false);
  vi.mocked(listChatIdentitiesForWorkspace).mockResolvedValue([]);
  vi.mocked(listInvites).mockResolvedValue([]);
  vi.mocked(listWorkspaceMembers).mockResolvedValue([
    { userId: "owner-1", name: "Owner", email: "o@x.com", role: "owner", joinedAt: new Date() },
  ] as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/onboarding", () => {
  it("401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(req(), params());
    expect(res.status).toBe(401);
  });

  it("403 when not a workspace member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(req(), params());
    expect(res.status).toBe(403);
  });

  it("any member (not just admin) can read onboarding status", async () => {
    const res = await GET(req(), params());
    expect(res.status).toBe(200);
  });

  it("returns all-incomplete steps for a fresh workspace", async () => {
    const res = await GET(req(), params());
    const body = await res.json();
    expect(body.steps).toEqual([
      { id: "connect-github", status: "incomplete" },
      { id: "connect-channel", status: "incomplete" },
      // Console chat's flag is unset in this test env, so say-hi-to-jace
      // reads as skipped (never permanently-incomplete for a workspace the
      // feature hasn't rolled out to) — see onboarding-steps.ts.
      { id: "say-hi-to-jace", status: "skipped" },
      { id: "invite-team", status: "incomplete" },
      { id: "attach-runner", status: "incomplete" },
    ]);
  });

  it("reflects a connected github connector + self-hosted runner + accepted teammate (AC3 runner status)", async () => {
    vi.mocked(getConnector).mockImplementation(async (_ws, provider) => {
      if (provider === "github") {
        return {
          provider: "github",
          enabled: true,
          config: {
            repos: ["acme/repo"],
            webhookSecret: "abc123",
            triggerLabel: "ready-for-agent",
            pollIntervalSeconds: 60,
          },
          hasSecret: false,
          updatedAt: null,
        } as never;
      }
      return null;
    });
    // hostedExecution stays false so the assertion below proves the
    // SELF-HOSTED leg of the disjunct drives connected on its own.
    vi.mocked(hasActiveSelfHostedRunner).mockResolvedValue(true);
    vi.mocked(listWorkspaceMembers).mockResolvedValue([
      { userId: "owner-1", name: "Owner", email: "o@x.com", role: "owner", joinedAt: new Date() },
      { userId: "u2", name: "Teammate", email: "t@x.com", role: "member", joinedAt: new Date() },
    ] as never);

    const res = await GET(req(), params());
    const body = await res.json();
    expect(body.steps).toEqual([
      { id: "connect-github", status: "complete" },
      { id: "connect-channel", status: "incomplete" },
      { id: "say-hi-to-jace", status: "skipped" },
      { id: "invite-team", status: "complete" },
      { id: "attach-runner", status: "complete" },
    ]);
    expect(body.runner).toEqual({ connected: true, selfHosted: true });
    expect(body.github.repos).toEqual(["acme/repo"]);
  });

  it("#1268: attach-runner completes for a hosted-eligible workspace with NO self-hosted runner", async () => {
    // The exact regression #1268 closes: a runner-less (hosted) workspace
    // must read as having an execution path, but the UI signal must stay
    // honest that no self-hosted runner is actually polling.
    vi.mocked(getWorkspace).mockResolvedValue({
      id: WS,
      hostedExecution: true,
    } as never);
    vi.mocked(hasActiveSelfHostedRunner).mockResolvedValue(false);

    const res = await GET(req(), params());
    const body = await res.json();
    expect(body.steps).toContainEqual({ id: "attach-runner", status: "complete" });
    expect(body.runner).toEqual({ connected: true, selfHosted: false });
  });

  it("defensively reads no execution path when the workspace row is missing", async () => {
    vi.mocked(getWorkspace).mockResolvedValue(null as never);
    vi.mocked(hasActiveSelfHostedRunner).mockResolvedValue(false);

    const res = await GET(req(), params());
    const body = await res.json();
    expect(body.steps).toContainEqual({ id: "attach-runner", status: "incomplete" });
    expect(body.runner).toEqual({ connected: false, selfHosted: false });
  });

  it("500 when the loader throws", async () => {
    vi.mocked(getWorkspace).mockRejectedValue(new Error("db down"));
    const res = await GET(req(), params());
    expect(res.status).toBe(500);
  });

  // -- connect-channel signal (connectors-channels cutover, T5) -------------
  // `channel.connected` flips from a stored telegram secret to a spine-backed
  // signal: ≥1 linked chat identity for platform "telegram"
  // (`listChatIdentitiesForWorkspace`). `channel.chatId` is gone — the client
  // gets display names only (`linkedNames`), never `platformUserId`.
  describe("connect-channel (spine-backed signal)", () => {
    it("connected is true once the workspace has ≥1 linked telegram chat identity, with its display name surfaced", async () => {
      vi.mocked(listChatIdentitiesForWorkspace).mockResolvedValue([
        { platform: "telegram", platformUserId: "tg-1", displayName: "Ben" },
      ] as never);

      const res = await GET(req(), params());
      const body = await res.json();
      expect(body.channel).toEqual({
        connected: true,
        skipped: false,
        linkedNames: ["Ben"],
      });
      expect(body.steps).toContainEqual({
        id: "connect-channel",
        status: "complete",
      });
    });

    it("connected stays false for identities on OTHER platforms only — never derives from a stored telegram secret (hasSecret) any more", async () => {
      vi.mocked(listChatIdentitiesForWorkspace).mockResolvedValue([
        { platform: "discord", platformUserId: "d-1", displayName: "Team" },
      ] as never);
      // The OLD signal: a stored telegram credential. Proves it no longer
      // drives `connected` post-cutover.
      vi.mocked(getConnector).mockImplementation(async (_ws, provider) =>
        provider === "telegram"
          ? ({
              provider: "telegram",
              enabled: true,
              config: {},
              hasSecret: true,
              updatedAt: null,
            } as never)
          : null
      );

      const res = await GET(req(), params());
      const body = await res.json();
      expect(body.channel).toEqual({
        connected: false,
        skipped: false,
        linkedNames: [],
      });
    });

    it("linkedNames carries only telegram identities' display names (filters out other platforms), preserving a null display name, and never leaks platformUserId", async () => {
      vi.mocked(listChatIdentitiesForWorkspace).mockResolvedValue([
        { platform: "telegram", platformUserId: "tg-1", displayName: "Ada" },
        { platform: "telegram", platformUserId: "tg-2", displayName: null },
        { platform: "discord", platformUserId: "d-1", displayName: "Ignored" },
      ] as never);

      const res = await GET(req(), params());
      const body = await res.json();
      expect(body.channel.linkedNames).toEqual(["Ada", null]);
      const raw = JSON.stringify(body);
      expect(raw).not.toContain("tg-1");
      expect(raw).not.toContain("tg-2");
      expect(raw).not.toContain("platformUserId");
    });

    it("skipped still reads from the telegram connector row's channelSkippedAt — that mechanism is unchanged", async () => {
      vi.mocked(getConnector).mockImplementation(async (_ws, provider) =>
        provider === "telegram"
          ? ({
              provider: "telegram",
              enabled: true,
              config: { channelSkippedAt: new Date().toISOString() },
              hasSecret: false,
              updatedAt: null,
            } as never)
          : null
      );

      const res = await GET(req(), params());
      const body = await res.json();
      expect(body.channel).toEqual({
        connected: false,
        skipped: true,
        linkedNames: [],
      });
      expect(body.steps).toContainEqual({
        id: "connect-channel",
        status: "skipped",
      });
    });

    it("connected outranks a stale skip flag — linked AND previously-skipped reads complete, not skipped", async () => {
      vi.mocked(listChatIdentitiesForWorkspace).mockResolvedValue([
        { platform: "telegram", platformUserId: "tg-1", displayName: null },
      ] as never);
      vi.mocked(getConnector).mockImplementation(async (_ws, provider) =>
        provider === "telegram"
          ? ({
              provider: "telegram",
              enabled: true,
              config: { channelSkippedAt: new Date().toISOString() },
              hasSecret: false,
              updatedAt: null,
            } as never)
          : null
      );

      const res = await GET(req(), params());
      const body = await res.json();
      expect(body.channel).toEqual({
        connected: true,
        skipped: true,
        linkedNames: [null],
      });
      expect(body.steps).toContainEqual({
        id: "connect-channel",
        status: "complete",
      });
    });
  });
});
