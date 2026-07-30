import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "crypto";

/**
 * FINAL WHOLE-BRANCH REVIEW — "the testing requirement" (finding #1's root
 * cause): all three review findings survived 3440 passing tests because
 * every DB call in the console suite is mocked PER TEST FILE — the events
 * route's own test file mocks `@agentrail/db-postgres` one way,
 * `channel-dispatch.test.ts` mocks it another way, and neither ever crosses
 * the seam between what one route WRITES and what the other READS. Finding
 * #1 (Slack ships 100% dead: `channel_inbox.senderId` written as the raw
 * `event.user` but read back via `getChatIdentity(row.channel, row.senderId)`
 * which only ever finds rows keyed by the COMPOSITE `platformUserId`) is
 * exactly a seam bug — no single-file mock can ever catch it, because a
 * single-file mock can't disagree with itself.
 *
 * This file exercises the REAL `POST` handler from the Slack events route
 * (`app/api/v1/connectors/slack/events/route.ts`) and the REAL
 * `dispatchQueuedChannelMessages` / `processRow` from `channel-dispatch.ts`
 * — both unmocked — against ONE shared in-memory fake standing in for
 * `chat_identities` and `channel_inbox`. Both modules import
 * `@agentrail/db-postgres`; mocking that package ONCE, here, with fakes that
 * close over the SAME maps, is what lets a disagreement between the two real
 * call sites actually surface as a test failure — which no per-file mock
 * arrangement can do.
 *
 * `resolveConversationWorkspace` is stubbed to throw a distinctive sentinel
 * error the moment `processRow` reaches it — `processRow` only ever gets
 * there AFTER `getChatIdentity` has found a row, so seeing the sentinel in
 * `failChannelMessage`'s reason IS the proof the identity lookup succeeded.
 * Seeing "no chat identity" instead (channel-dispatch.ts's own invariant
 * message, channel-dispatch.ts:1188) is exactly the ships-100%-dead failure
 * this test exists to catch.
 */

const REACHED_WORKSPACE_RESOLUTION = "SEAM_TEST_REACHED_WORKSPACE_RESOLUTION";

const fake = vi.hoisted(() => {
  const identities = new Map<
    string,
    { id: string; platform: string; platformUserId: string; workspaceId: string | null }
  >();
  const installations = new Map<
    string,
    { teamId: string; teamName: string | null; botToken: string; botUserId: string; enterpriseId: string | null; revokedAt: Date | null }
  >();
  const queue: Array<{
    id: string;
    workspaceId: string | null;
    chatIdentityId: string | null;
    channel: string;
    conversationKey: string;
    kind: string;
    senderId: string;
    senderDisplay: string;
    providerMessageId: string;
    payload: Record<string, unknown>;
  }> = [];
  const engagement = new Map<string, { dormantSince: Date | null; engagedSpeakerId: string | null }>();
  const failures: Array<{ id: string; reason: string }> = [];
  let nextId = 1;

  return { identities, installations, queue, engagement, failures, nextId: () => String(nextId++) };
});

vi.mock("@agentrail/db-postgres", () => {
  const identityKey = (platform: string, platformUserId: string) => `${platform}::${platformUserId}`;
  const engagementKey = (channel: string, conversationKey: string) => `${channel}::${conversationKey}`;

  return {
    db: {},

    // --- identity (shared with the "real" seam) ---------------------------
    resolveInboundChatIdentity: vi.fn(
      async (input: { platform: string; platformUserId: string; displayName?: string | null }) => {
        const key = identityKey(input.platform, input.platformUserId);
        let row = fake.identities.get(key);
        let created = false;
        if (!row) {
          row = {
            id: `identity-${fake.nextId()}`,
            platform: input.platform,
            platformUserId: input.platformUserId,
            workspaceId: null,
          };
          fake.identities.set(key, row);
          created = true;
        }
        return { identity: row, created, disposition: row.workspaceId ? "bound" : "intro" };
      }
    ),
    getChatIdentity: vi.fn(async (platform: string, platformUserId: string) => {
      return fake.identities.get(identityKey(platform, platformUserId)) ?? null;
    }),

    // --- slack installation -------------------------------------------------
    getSlackInstallation: vi.fn(async (teamId: string) => {
      const row = fake.installations.get(teamId);
      if (!row || row.revokedAt) return null;
      return {
        teamId: row.teamId,
        teamName: row.teamName,
        botToken: row.botToken,
        botUserId: row.botUserId,
        enterpriseId: row.enterpriseId,
      };
    }),
    revokeSlackInstallation: vi.fn(async (teamId: string) => {
      const row = fake.installations.get(teamId);
      if (row) row.revokedAt = new Date();
    }),

    // --- channel_inbox enqueue/claim (shared with the "real" seam) --------
    enqueueChannelMessage: vi.fn(
      async (input: {
        workspaceId?: string;
        chatIdentityId?: string;
        channel: string;
        conversationKey: string;
        kind?: string;
        senderId?: string;
        senderDisplay?: string;
        providerMessageId: string;
        payload: Record<string, unknown>;
      }) => {
        const id = `row-${fake.nextId()}`;
        fake.queue.push({
          id,
          workspaceId: input.workspaceId ?? null,
          chatIdentityId: input.chatIdentityId ?? null,
          channel: input.channel,
          conversationKey: input.conversationKey,
          kind: input.kind ?? "message",
          senderId: input.senderId ?? "",
          senderDisplay: input.senderDisplay ?? "",
          providerMessageId: input.providerMessageId,
          payload: input.payload,
        });
        return { id, deduped: false };
      }
    ),
    reclaimStaleChannelMessages: vi.fn(async () => undefined),
    claimNextChannelMessage: vi.fn(async () => {
      const row = fake.queue.shift();
      if (!row) return null;
      return {
        id: row.id,
        // processRow only reads workspaceId for the "console" fast path and
        // downstream turn machinery, neither of which this test reaches.
        workspaceId: row.workspaceId as unknown as string,
        channel: row.channel,
        conversationKey: row.conversationKey,
        kind: row.kind,
        senderId: row.senderId,
        senderDisplay: row.senderDisplay,
        providerMessageId: row.providerMessageId,
        payload: row.payload,
        state: "processing",
        attempts: 0,
        createdAt: new Date(),
      };
    }),
    completeChannelMessage: vi.fn(async () => undefined),
    failChannelMessage: vi.fn(async (id: string, reason: string) => {
      fake.failures.push({ id, reason });
    }),
    stampChannelInboxWorkspace: vi.fn().mockResolvedValue(undefined),

    // --- thread engagement (shared) -----------------------------------------
    getThreadEngagement: vi.fn(async (args: { channel: string; conversationKey: string }) => {
      return fake.engagement.get(engagementKey(args.channel, args.conversationKey)) ?? null;
    }),
    setThreadEngagement: vi.fn(async (args: {
      channel: string;
      conversationKey: string;
      dormantSince: Date | null;
      engagedSpeakerId: string | null;
    }) => {
      fake.engagement.set(engagementKey(args.channel, args.conversationKey), {
        dormantSince: args.dormantSince,
        engagedSpeakerId: args.engagedSpeakerId,
      });
    }),

    // --- everything past the identity check: deliberately a dead end -------
    // The sentinel throw is the proof processRow got PAST getChatIdentity —
    // it is the very next DB call processRow makes.
    resolveConversationWorkspace: vi.fn(async () => {
      throw new Error(REACHED_WORKSPACE_RESOLUTION);
    }),
    pinConversationWorkspace: vi.fn(),
    getOrCreateIntroJaceSession: vi.fn(),
    getOrCreateJaceSession: vi.fn(),
    bindEveSession: vi.fn(),
    latestRunForIssue: vi.fn(),
    listWorkspacesForChatIdentity: vi.fn(),
    setChatIdentityLinkToken: vi.fn(),
    repinConversationWorkspace: vi.fn(),
    recordGuardrailEvent: vi.fn(),
    appendJaceMessage: vi.fn(),
  };
});

// channel-dispatch.ts imports these directly; stub the network-performing
// pieces exactly like channel-dispatch.test.ts does, so loading the REAL
// module has no side effects this test doesn't control.
vi.mock("./telegram-system-message", async () => {
  const actual = await vi.importActual<typeof import("./telegram-system-message")>(
    "./telegram-system-message"
  );
  return { ...actual, sendSystemTelegramMessage: vi.fn() };
});
vi.mock("./discord-system-message", () => ({ sendSystemDiscordMessage: vi.fn() }));
vi.mock("./slack-system-message", () => ({ sendSystemSlackMessage: vi.fn() }));
vi.mock("./discord-bot", () => ({ createDiscordThreadFromMessage: vi.fn() }));

import { POST } from "../app/api/v1/connectors/slack/events/route";
import { dispatchQueuedChannelMessages } from "./channel-dispatch";
import { failChannelMessage } from "@agentrail/db-postgres";

const mockFailChannelMessage = vi.mocked(failChannelMessage);

const SIGNING_SECRET = "seam-test-secret";

function req(rawBody: string): NextRequest {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const basestring = `v0:${timestamp}:${rawBody}`;
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(basestring).digest("hex")}`;
  return new NextRequest("http://localhost/api/v1/connectors/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
    body: rawBody,
  });
}

function messageEventBody(teamId: string, user: string, channel = "D0PNCRP9N") {
  return JSON.stringify({
    token: "tok",
    team_id: teamId,
    api_app_id: "A1",
    event: {
      type: "message",
      channel,
      user,
      text: "hello jace",
      ts: "1700000000.000100",
      channel_type: "im",
    },
    type: "event_callback",
    event_id: `Ev-${teamId}-${user}-${Math.random()}`,
    event_time: 1515449483,
  });
}

beforeEach(() => {
  fake.identities.clear();
  fake.installations.clear();
  fake.queue.length = 0;
  fake.engagement.clear();
  fake.failures.length = 0;
  vi.clearAllMocks();
  process.env["SLACK_SIGNING_SECRET"] = SIGNING_SECRET;
  fake.installations.set("T1", {
    teamId: "T1",
    teamName: "Team One",
    botToken: "xoxb-fake",
    botUserId: "UBOT1",
    enterpriseId: null,
    revokedAt: null,
  });
});

describe("Slack identity seam — real events-route enqueue + real processRow lookup, shared fake store", () => {
  it("a message the events route enqueues is found by processRow's identity lookup (the seam holds)", async () => {
    // The route's own fire-and-forget kick (`void dispatchQueuedChannelMessages()`)
    // is REAL here (unmocked), so it may already be draining the row by the
    // time `POST` resolves — asserting on `fake.queue`'s length right after
    // `POST` would be a race. `dispatchQueuedChannelMessages`'s own in-flight
    // latch (see channel-dispatch.ts) means this explicit call either starts
    // the drain or joins the one already running; either way, by the time it
    // resolves the row has been through `processRow` exactly once.
    const res = await POST(req(messageEventBody("T1", "U061F7AUR")));
    expect(res.status).toBe(200);

    await dispatchQueuedChannelMessages();

    // The identity lookup succeeded (processRow reached resolveConversationWorkspace,
    // proven by the sentinel) — NOT the "no chat identity" dead-letter the
    // ships-100%-dead bug produces.
    expect(mockFailChannelMessage).toHaveBeenCalledTimes(1);
    const [, reason] = mockFailChannelMessage.mock.calls[0]!;
    expect(reason).toContain(REACHED_WORKSPACE_RESOLUTION);
    expect(reason).not.toContain("no chat identity");
  });

  it("two different teams with the SAME Slack user id each get their own identity, and each is found by their own row", async () => {
    fake.installations.set("T2", {
      teamId: "T2",
      teamName: "Team Two",
      botToken: "xoxb-fake-2",
      botUserId: "UBOT2",
      enterpriseId: null,
      revokedAt: null,
    });

    // Sequential + awaited (not Promise.all) so each POST's own enqueue has
    // definitely landed before the next one starts — see the previous test's
    // comment on why asserting queue length here would be a race against the
    // real, unmocked fire-and-forget kick.
    await POST(req(messageEventBody("T1", "U999")));
    await POST(req(messageEventBody("T2", "U999")));

    await dispatchQueuedChannelMessages();

    expect(mockFailChannelMessage).toHaveBeenCalledTimes(2);
    for (const [, reason] of mockFailChannelMessage.mock.calls) {
      expect(reason).toContain(REACHED_WORKSPACE_RESOLUTION);
      expect(reason).not.toContain("no chat identity");
    }
    // And the two identities really are distinct rows, not one collided row.
    expect(fake.identities.size).toBe(2);
  });
});
