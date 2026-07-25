import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  getConnector: vi.fn(),
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
  vi.mocked(listChatIdentitiesForWorkspace).mockResolvedValue([]);
  vi.mocked(listInvites).mockResolvedValue([]);
  vi.mocked(listWorkspaceMembers).mockResolvedValue([
    { userId: "owner-1", name: "Owner", email: "o@x.com", role: "owner", joinedAt: new Date() },
  ] as never);
  // Console chat is off by default in this test env, so hasAnyJaceReply is
  // never called (loadOnboardingData short-circuits) — nothing to mock.
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

  it("returns exactly three steps, all incomplete, for a fresh workspace", async () => {
    const res = await GET(req(), params());
    const body = await res.json();
    expect(body.steps).toEqual([
      { id: "connect-github", status: "incomplete" },
      { id: "invite-team", status: "incomplete" },
      { id: "message-jace", status: "incomplete" },
    ]);
  });

  it("never returns an attach-runner / execution step — that step was removed outright", async () => {
    const res = await GET(req(), params());
    const body = await res.json();
    expect(body.steps.map((s: { id: string }) => s.id)).not.toContain(
      "attach-runner"
    );
    expect(body).not.toHaveProperty("runner");
  });

  it("reflects a connected github connector + accepted teammate", async () => {
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
    vi.mocked(listWorkspaceMembers).mockResolvedValue([
      { userId: "owner-1", name: "Owner", email: "o@x.com", role: "owner", joinedAt: new Date() },
      { userId: "u2", name: "Teammate", email: "t@x.com", role: "member", joinedAt: new Date() },
    ] as never);

    const res = await GET(req(), params());
    const body = await res.json();
    expect(body.steps).toEqual([
      { id: "connect-github", status: "complete" },
      { id: "invite-team", status: "complete" },
      { id: "message-jace", status: "incomplete" },
    ]);
    expect(body.github.repos).toEqual(["acme/repo"]);
  });

  it("500 when the loader throws", async () => {
    vi.mocked(getConnector).mockRejectedValue(new Error("db down"));
    const res = await GET(req(), params());
    expect(res.status).toBe(500);
  });

  // -- connect-github skip ---------------------------------------------------
  describe("connect-github (skippable)", () => {
    it("is skipped when githubSkippedAt is set and nothing is connected", async () => {
      vi.mocked(getConnector).mockImplementation(async (_ws, provider) =>
        provider === "github"
          ? ({
              provider: "github",
              enabled: true,
              config: { repos: [], triggerLabel: "ready-for-agent", pollIntervalSeconds: 60, githubSkippedAt: new Date().toISOString() },
              hasSecret: false,
              updatedAt: null,
            } as never)
          : null
      );

      const res = await GET(req(), params());
      const body = await res.json();
      expect(body.github).toMatchObject({ skipped: true });
      expect(body.steps).toContainEqual({ id: "connect-github", status: "skipped" });
    });

    it("connecting after a skip outranks the stale flag — reads complete, not skipped", async () => {
      vi.mocked(getConnector).mockImplementation(async (_ws, provider) =>
        provider === "github"
          ? ({
              provider: "github",
              enabled: true,
              config: {
                repos: ["acme/repo"],
                webhookSecret: "abc123",
                triggerLabel: "ready-for-agent",
                pollIntervalSeconds: 60,
                githubSkippedAt: new Date().toISOString(),
              },
              hasSecret: false,
              updatedAt: null,
            } as never)
          : null
      );

      const res = await GET(req(), params());
      const body = await res.json();
      expect(body.github.skipped).toBe(true);
      expect(body.steps).toContainEqual({ id: "connect-github", status: "complete" });
    });
  });

  // -- invite-team skip (piggybacks on the github row) -----------------------
  describe("invite-team (skippable, flag lives on the github connector row)", () => {
    it("is skipped when inviteTeamSkippedAt is set and no teammate was reached", async () => {
      vi.mocked(getConnector).mockImplementation(async (_ws, provider) =>
        provider === "github"
          ? ({
              provider: "github",
              enabled: true,
              config: {
                repos: [],
                triggerLabel: "ready-for-agent",
                pollIntervalSeconds: 60,
                inviteTeamSkippedAt: new Date().toISOString(),
              },
              hasSecret: false,
              updatedAt: null,
            } as never)
          : null
      );

      const res = await GET(req(), params());
      const body = await res.json();
      expect(body.invites).toEqual({ count: 0, skipped: true });
      expect(body.steps).toContainEqual({ id: "invite-team", status: "skipped" });
    });

    it("reaching a teammate outranks a stale skip flag", async () => {
      vi.mocked(getConnector).mockImplementation(async (_ws, provider) =>
        provider === "github"
          ? ({
              provider: "github",
              enabled: true,
              config: {
                repos: [],
                triggerLabel: "ready-for-agent",
                pollIntervalSeconds: 60,
                inviteTeamSkippedAt: new Date().toISOString(),
              },
              hasSecret: false,
              updatedAt: null,
            } as never)
          : null
      );
      vi.mocked(listWorkspaceMembers).mockResolvedValue([
        { userId: "owner-1", name: "Owner", email: "o@x.com", role: "owner", joinedAt: new Date() },
        { userId: "u2", name: "Teammate", email: "t@x.com", role: "member", joinedAt: new Date() },
      ] as never);

      const res = await GET(req(), params());
      const body = await res.json();
      expect(body.invites).toEqual({ count: 1, skipped: true });
      expect(body.steps).toContainEqual({ id: "invite-team", status: "complete" });
    });
  });

  // -- message-jace (replaces connect-channel + say-hi-to-jace) ---------------
  describe("message-jace (spine-backed signal OR a real chat reply)", () => {
    it("connected is true once the workspace has ≥1 linked telegram chat identity, with its display name surfaced", async () => {
      vi.mocked(listChatIdentitiesForWorkspace).mockResolvedValue([
        { platform: "telegram", platformUserId: "tg-1", displayName: "Ben" },
      ] as never);

      const res = await GET(req(), params());
      const body = await res.json();
      expect(body.messageJace).toEqual({
        connected: true,
        skipped: false,
        linkedNames: ["Ben"],
        jaceReplied: false,
      });
      expect(body.steps).toContainEqual({
        id: "message-jace",
        status: "complete",
      });
    });

    it("connected stays false for identities on OTHER platforms only", async () => {
      vi.mocked(listChatIdentitiesForWorkspace).mockResolvedValue([
        { platform: "discord", platformUserId: "d-1", displayName: "Team" },
      ] as never);

      const res = await GET(req(), params());
      const body = await res.json();
      expect(body.messageJace.connected).toBe(false);
      expect(body.messageJace.linkedNames).toEqual([]);
    });

    it("linkedNames carries only telegram identities' display names, preserving a null display name, and never leaks platformUserId", async () => {
      vi.mocked(listChatIdentitiesForWorkspace).mockResolvedValue([
        { platform: "telegram", platformUserId: "tg-1", displayName: "Ada" },
        { platform: "telegram", platformUserId: "tg-2", displayName: null },
        { platform: "discord", platformUserId: "d-1", displayName: "Ignored" },
      ] as never);

      const res = await GET(req(), params());
      const body = await res.json();
      expect(body.messageJace.linkedNames).toEqual(["Ada", null]);
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
      expect(body.messageJace).toEqual({
        connected: false,
        skipped: true,
        linkedNames: [],
        jaceReplied: false,
      });
      expect(body.steps).toContainEqual({
        id: "message-jace",
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
      expect(body.messageJace).toEqual({
        connected: true,
        skipped: true,
        linkedNames: [null],
        jaceReplied: false,
      });
      expect(body.steps).toContainEqual({
        id: "message-jace",
        status: "complete",
      });
    });
  });
});
