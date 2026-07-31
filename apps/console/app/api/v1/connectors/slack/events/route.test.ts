import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "crypto";

vi.mock("@agentrail/db-postgres", () => ({
  resolveInboundChatIdentity: vi.fn(),
  enqueueChannelMessage: vi.fn(),
  getThreadEngagement: vi.fn(),
  getSlackInstallation: vi.fn(),
  revokeSlackInstallation: vi.fn(),
}));

vi.mock("../../../../../../lib/channel-dispatch", () => ({
  dispatchQueuedChannelMessages: vi.fn(),
}));

import { POST } from "./route";
import {
  resolveInboundChatIdentity,
  enqueueChannelMessage,
  getThreadEngagement,
  getSlackInstallation,
  revokeSlackInstallation,
} from "@agentrail/db-postgres";
import { dispatchQueuedChannelMessages } from "../../../../../../lib/channel-dispatch";

const mockResolve = vi.mocked(resolveInboundChatIdentity);
const mockEnqueue = vi.mocked(enqueueChannelMessage);
const mockDispatch = vi.mocked(dispatchQueuedChannelMessages);
const mockGetEngagement = vi.mocked(getThreadEngagement);
const mockGetInstallation = vi.mocked(getSlackInstallation);
const mockRevoke = vi.mocked(revokeSlackInstallation);
mockDispatch.mockResolvedValue({ processed: 0, failed: 0 });

const SIGNING_SECRET = "shhh-its-a-secret";
const ORIGINAL_SECRET_ENV = process.env["SLACK_SIGNING_SECRET"];

// The default team every test fixture uses unless it overrides `team_id`.
const DEFAULT_TEAM_ID = "T1";
const DEFAULT_BOT_USER_ID = "UBOTDEFAULT";

function installation(overrides: Partial<{
  teamId: string;
  teamName: string | null;
  botToken: string;
  botUserId: string;
  enterpriseId: string | null;
}> = {}) {
  return {
    teamId: DEFAULT_TEAM_ID,
    teamName: "Test Team",
    botToken: "xoxb-test-token",
    botUserId: DEFAULT_BOT_USER_ID,
    enterpriseId: null,
    ...overrides,
  };
}

function sign(timestamp: string, rawBody: string, secret = SIGNING_SECRET): string {
  const basestring = `v0:${timestamp}:${rawBody}`;
  return `v0=${createHmac("sha256", secret).update(basestring).digest("hex")}`;
}

// Fixed "now" for every request in this file so signatures never go stale
// mid-suite; verifySlackSignature's real clock is exercised in slack-bot.test.ts.
const NOW = Math.floor(Date.now() / 1000);

function req(rawBody: string, opts: { signature?: string; timestamp?: string } = {}): NextRequest {
  const timestamp = opts.timestamp ?? String(NOW);
  const signature = opts.signature ?? sign(timestamp, rawBody);
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

const URL_VERIFICATION_BODY = JSON.stringify({
  token: "Jhj5dZrVaK7ZwHHjRyZWjbDl",
  challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
  type: "url_verification",
});

function messageEventBody(
  overrides: { event?: Record<string, unknown>; team_id?: string } = {}
) {
  return JSON.stringify({
    token: "tok",
    team_id: overrides.team_id ?? DEFAULT_TEAM_ID,
    api_app_id: "A1",
    event: {
      type: "message",
      channel: "D0PNCRP9N",
      user: "U061F7AUR",
      text: "hello jace",
      ts: "1515449483.000078",
      channel_type: "im",
      ...(overrides.event ?? {}),
    },
    type: "event_callback",
    event_id: "Ev0PV52K21",
    event_time: 1515449483,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDispatch.mockResolvedValue({ processed: 0, failed: 0 });
  // Every test gets a resolvable installation for DEFAULT_TEAM_ID unless it
  // overrides this — mirrors prod's steady state (an installed team) so
  // tests that aren't specifically about installation resolution don't have
  // to think about it.
  mockGetInstallation.mockImplementation(async (teamId: string) =>
    teamId === DEFAULT_TEAM_ID ? installation() : null
  );
  process.env["SLACK_SIGNING_SECRET"] = SIGNING_SECRET;
});

afterEach(() => {
  if (ORIGINAL_SECRET_ENV === undefined) {
    delete process.env["SLACK_SIGNING_SECRET"];
  } else {
    process.env["SLACK_SIGNING_SECRET"] = ORIGINAL_SECRET_ENV;
  }
});

describe("POST /api/v1/connectors/slack/events — verify (fail closed)", () => {
  it("401s when SLACK_SIGNING_SECRET is unset, even with a well-formed signature header", async () => {
    delete process.env["SLACK_SIGNING_SECRET"];

    const res = await POST(req(URL_VERIFICATION_BODY));

    expect(res.status).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("401s when the signature header is missing entirely", async () => {
    const request = new NextRequest("http://localhost/api/v1/connectors/slack/events", {
      method: "POST",
      headers: { "x-slack-request-timestamp": String(NOW) },
      body: URL_VERIFICATION_BODY,
    });
    const res = await POST(request);
    expect(res.status).toBe(401);
  });

  it("401s on a tampered body", async () => {
    const timestamp = String(NOW);
    const signature = sign(timestamp, URL_VERIFICATION_BODY);
    const request = new NextRequest("http://localhost/api/v1/connectors/slack/events", {
      method: "POST",
      headers: { "x-slack-signature": signature, "x-slack-request-timestamp": timestamp },
      body: JSON.stringify({ type: "url_verification", challenge: "tampered" }),
    });
    const res = await POST(request);
    expect(res.status).toBe(401);
  });

  it("401s on a signature from the wrong signing secret", async () => {
    const timestamp = String(NOW);
    const signature = sign(timestamp, URL_VERIFICATION_BODY, "wrong-secret");

    const res = await POST(req(URL_VERIFICATION_BODY, { signature, timestamp }));

    expect(res.status).toBe(401);
  });

  it("never enqueues when verification fails", async () => {
    delete process.env["SLACK_SIGNING_SECRET"];
    const res = await POST(req(messageEventBody()));
    expect(res.status).toBe(401);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/connectors/slack/events — url_verification challenge", () => {
  it("echoes the challenge back verbatim", async () => {
    const res = await POST(req(URL_VERIFICATION_BODY));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" });
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("400s when url_verification carries no challenge string", async () => {
    const raw = JSON.stringify({ type: "url_verification" });
    const res = await POST(req(raw));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/connectors/slack/events — parse", () => {
  it("400s on malformed JSON (after signature verification passes over the raw bytes)", async () => {
    const raw = "{not json";
    const timestamp = String(NOW);
    const signature = sign(timestamp, raw);
    const res = await POST(req(raw, { signature, timestamp }));

    expect(res.status).toBe(400);
  });

  it("400s on a well-formed but shapeless body (no type)", async () => {
    const res = await POST(req(JSON.stringify({ foo: "bar" })));
    expect(res.status).toBe(400);
  });

  it("acks (200, ignored) an event_callback type with no event.type == message, e.g. a future unhandled top-level type", async () => {
    const res = await POST(req(JSON.stringify({ type: "app_rate_limited" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
  });
});

describe("POST /api/v1/connectors/slack/events — bot-loop / noise guard", () => {
  it("ignores an event carrying bot_id (this bot's own post, or another bot's)", async () => {
    const res = await POST(req(messageEventBody({ event: { bot_id: "B123" } })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("ignores an event carrying any subtype (e.g. message_changed)", async () => {
    const res = await POST(req(messageEventBody({ event: { subtype: "message_changed" } })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("ignores a non-'message' event type (e.g. app_mention, out of scope for this door)", async () => {
    const res = await POST(req(messageEventBody({ event: { type: "app_mention" } })));
    expect(res.status).toBe(200);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("ignores a message with blank text", async () => {
    const res = await POST(req(messageEventBody({ event: { text: "   " } })));
    expect(res.status).toBe(200);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  // Final whole-branch review, finding #2 (minor): a thread reply sent with
  // Slack's "Also send to channel" checkbox carries that subtype but is a
  // genuine human turn — it has the same text/user/channel/ts/thread_ts
  // shape as any other in-thread reply, so admitting it here is enough for
  // it to flow through the existing path unchanged. Every other subtype
  // (edits, deletes, joins, ...) and any bot_id stay rejected.
  it("still ignores a thread_broadcast event that ALSO carries bot_id", async () => {
    const res = await POST(
      req(messageEventBody({ event: { subtype: "thread_broadcast", bot_id: "B123" } }))
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Task 3 — fail closed on an unknown/uninstalled/revoked team. This gate
// runs BEFORE identity resolution and BEFORE the engagement gate: no
// installation means no credential to ever reply with, so the event must
// never reach `channel_inbox`.
// ---------------------------------------------------------------------------

describe("POST /api/v1/connectors/slack/events — unknown team (fail closed)", () => {
  it("ignores an event whose team_id has no installation — never resolves identity, never enqueues, never kicks the dispatcher", async () => {
    mockGetInstallation.mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await POST(req(messageEventBody({ team_id: "TUNKNOWN" })));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(mockGetInstallation).toHaveBeenCalledWith("TUNKNOWN");
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    // "ignored with a log line" — a diagnosable trace, not silent drop.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // getSlackInstallation collapses "never installed" and "revoked" to the
  // SAME `null` (see its own doc-comment) precisely so this door never has
  // to special-case revocation — this test proves the door actually honours
  // that collapse rather than assuming it.
  it("treats a revoked installation (getSlackInstallation returns null) identically to an unknown team", async () => {
    mockGetInstallation.mockResolvedValue(null);

    const res = await POST(req(messageEventBody({ team_id: "TREVOKED" })));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("ignores an event_callback with no team_id at all, without throwing", async () => {
    const raw = JSON.stringify({
      token: "tok",
      api_app_id: "A1",
      event: {
        type: "message",
        channel: "D0PNCRP9N",
        user: "U061F7AUR",
        text: "hello jace",
        ts: "1515449483.000078",
        channel_type: "im",
      },
      type: "event_callback",
      event_id: "Ev0PV52K21",
      event_time: 1515449483,
    });

    const res = await POST(req(raw));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(mockGetInstallation).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Task 3 — the cross-tenant identity fix. This is the test the whole task
// exists for: two workspaces whose Slack user ids collide (Slack ids are
// only unique WITHIN a workspace) must resolve to two DIFFERENT
// chat_identities rows, not one shared row.
// ---------------------------------------------------------------------------

describe("POST /api/v1/connectors/slack/events — team-scoped identity (cross-tenant fix)", () => {
  beforeEach(() => {
    mockGetInstallation.mockImplementation(async (teamId: string) => {
      if (teamId === "T111") return installation({ teamId: "T111", botUserId: "UBOT111" });
      if (teamId === "T222") return installation({ teamId: "T222", botUserId: "UBOT222" });
      return null;
    });
    mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });
  });

  it("two teams with the SAME Slack user id resolve to DIFFERENT identities (distinct platformUserId)", async () => {
    mockResolve.mockResolvedValueOnce({
      identity: { id: "chat-identity-team-111", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockResolve.mockResolvedValueOnce({
      identity: { id: "chat-identity-team-222", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });

    await POST(
      req(messageEventBody({ team_id: "T111", event: { user: "U999", text: "hi" } }))
    );
    await POST(
      req(messageEventBody({ team_id: "T222", event: { user: "U999", text: "hi" } }))
    );

    expect(mockResolve).toHaveBeenNthCalledWith(1, {
      platform: "slack",
      platformUserId: "T111:U999",
    });
    expect(mockResolve).toHaveBeenNthCalledWith(2, {
      platform: "slack",
      platformUserId: "T222:U999",
    });
    // Not merely "different calls" — the actual platformUserId strings must differ.
    const firstCallUserId = mockResolve.mock.calls[0]?.[0]?.platformUserId;
    const secondCallUserId = mockResolve.mock.calls[1]?.[0]?.platformUserId;
    expect(firstCallUserId).not.toBe(secondCallUserId);
  });
});

// ---------------------------------------------------------------------------
// Task 3 — mention detection is per installation now: `installation.botUserId`
// replaces the old shared `SLACK_BOT_USER_ID` env var. A message containing
// one team's bot id must never count as a mention for a DIFFERENT team's
// event.
// ---------------------------------------------------------------------------

describe("POST /api/v1/connectors/slack/events — mention detection per installation", () => {
  beforeEach(() => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });
  });

  function channelMessageBody(overrides: Record<string, unknown> = {}, team_id?: string) {
    return messageEventBody({
      team_id,
      event: {
        channel: "C123",
        channel_type: undefined,
        ts: "1700000009.000900",
        thread_ts: "1700000000.000100",
        text: "hello",
        ...overrides,
      },
    });
  }

  it("a message containing team A's bot id does NOT count as a mention when the event came from team B", async () => {
    mockGetInstallation.mockImplementation(async (teamId: string) => {
      if (teamId === "TEAM_A") return installation({ teamId: "TEAM_A", botUserId: "UBOTTEAMA" });
      if (teamId === "TEAM_B") return installation({ teamId: "TEAM_B", botUserId: "UBOTTEAMB" });
      return null;
    });
    // The dropped path never even reaches identity/enqueue unless engagement
    // admits it, so make the session dormant to prove the mention truly
    // isn't recognized (if it wrongly counted as a mention, it would enqueue
    // regardless of this dormant state).
    mockGetEngagement.mockResolvedValue({
      dormantSince: new Date("2026-07-28T12:00:00Z"),
      engagedSpeakerId: "U061F7AUR",
    });

    const res = await POST(
      req(channelMessageBody({ text: "<@UBOTTEAMA> what's the status?" }, "TEAM_B"))
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: true });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("that SAME text DOES count as a mention when the event actually came from team A", async () => {
    mockGetInstallation.mockImplementation(async (teamId: string) => {
      if (teamId === "TEAM_A") return installation({ teamId: "TEAM_A", botUserId: "UBOTTEAMA" });
      return null;
    });

    const res = await POST(
      req(channelMessageBody({ text: "<@UBOTTEAMA> what's the status?" }, "TEAM_A"))
    );

    expect(res.status).toBe(200);
    expect(mockGetEngagement).not.toHaveBeenCalled();
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ mentionsBot: true, mentionsOtherUsers: false }),
      })
    );
  });

  it("a mention of the resolved installation's bot id always enqueues, without ever looking up engagement state", async () => {
    const res = await POST(req(channelMessageBody({ text: `<@${DEFAULT_BOT_USER_ID}> status?` })));

    expect(res.status).toBe(200);
    expect(mockGetEngagement).not.toHaveBeenCalled();
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it("a DM always enqueues, without ever looking up engagement state", async () => {
    const res = await POST(req(messageEventBody({ event: { channel_type: "im", text: "hey jace" } })));

    expect(res.status).toBe(200);
    expect(mockGetEngagement).not.toHaveBeenCalled();
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it("an un-mentioned thread message enqueues when the session is engaged (latch clear)", async () => {
    mockGetEngagement.mockResolvedValue({ dormantSince: null, engagedSpeakerId: "U061F7AUR" });

    const res = await POST(req(channelMessageBody()));

    expect(mockGetEngagement).toHaveBeenCalledWith({
      channel: "slack",
      conversationKey: "T1:C123:1700000000.000100",
    });
    expect(res.status).toBe(200);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it("an un-mentioned thread message is dropped when the session is dormant (latch set) — never enqueues, never resolves identity", async () => {
    mockGetEngagement.mockResolvedValue({
      dormantSince: new Date("2026-07-28T12:00:00Z"),
      engagedSpeakerId: "U061F7AUR",
    });

    const res = await POST(req(channelMessageBody()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: true });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("an un-mentioned channel message with no session row at all is dropped — never enqueues", async () => {
    mockGetEngagement.mockResolvedValue(null);

    const res = await POST(req(channelMessageBody()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: true });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  // Final whole-branch review, finding #3 (important): `/connect` must reach
  // the dispatcher even from a thread Jace has gone quiet in (or never spoke
  // in) — the one command whose own doc-comment promises it "never leaves a
  // user with silence".
  it("admits '/connect' in a DORMANT thread — never looks up engagement state, never drops it", async () => {
    mockGetEngagement.mockResolvedValue({
      dormantSince: new Date("2026-07-28T12:00:00Z"),
      engagedSpeakerId: "U061F7AUR",
    });

    const res = await POST(req(channelMessageBody({ text: "/connect" })));

    expect(res.status).toBe(200);
    expect(mockGetEngagement).not.toHaveBeenCalled();
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it("admits '/connect' in a thread with NO session row at all (never-engaged) — never looks up engagement state, never drops it", async () => {
    mockGetEngagement.mockResolvedValue(null);

    const res = await POST(req(channelMessageBody({ text: "/connect" })));

    expect(res.status).toBe(200);
    expect(mockGetEngagement).not.toHaveBeenCalled();
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it("still drops an ORDINARY un-mentioned dormant-thread message that merely CONTAINS the word 'connect' — '/connect' recognition is exact, not substring", async () => {
    mockGetEngagement.mockResolvedValue({
      dormantSince: new Date("2026-07-28T12:00:00Z"),
      engagedSpeakerId: "U061F7AUR",
    });

    const res = await POST(req(channelMessageBody({ text: "can you connect me to support?" })));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: true });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("carries mentionsBot/mentionsOtherUsers/repliesToMessageId/repliesToBot into the payload", async () => {
    await POST(
      req(channelMessageBody({ text: `<@${DEFAULT_BOT_USER_ID}> hey <@U777> check this out` }))
    );

    expect(mockEnqueue).toHaveBeenCalledWith({
      chatIdentityId: "chat-identity-1",
      channel: "slack",
      conversationKey: "T1:C123:1700000000.000100",
      kind: "message",
      // Final whole-branch review, finding #1: senderId MUST be the SAME
      // composite platformUserId the identity resolve call above used —
      // channel-dispatch.ts's processRow looks the identity back up via
      // getChatIdentity("slack", row.senderId).
      senderId: "T1:U061F7AUR",
      providerMessageId: "C123:Ev0PV52K21",
      payload: {
        chatId: "C123",
        text: `<@${DEFAULT_BOT_USER_ID}> hey <@U777> check this out`,
        // fromId stays the RAW Slack user id — user-facing "who sent this",
        // not an identity-lookup key.
        fromId: "U061F7AUR",
        teamId: "T1",
        threadTs: "1700000000.000100",
        mentionsBot: true,
        mentionsOtherUsers: true,
        repliesToMessageId: null,
        repliesToBot: false,
      },
    });
  });

  it("mentionsOtherUsers is false when the only <@...> token is the bot's own", async () => {
    await POST(req(channelMessageBody({ text: `<@${DEFAULT_BOT_USER_ID}> status?` })));

    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ mentionsBot: true, mentionsOtherUsers: false }),
      })
    );
  });

  // Final whole-branch review, finding #1 (critical): the invariant
  // channel-dispatch.ts:1188 documents and relies on — channel_inbox's
  // (channel, senderId) MUST equal the (platform, platformUserId) the
  // chat_identities row was resolved under. Asserted directly (not just
  // incidentally via a hardcoded literal above) so this keeps failing if a
  // future change re-introduces the raw event.user.
  it("enqueues senderId byte-identical to the platformUserId resolveInboundChatIdentity was called with", async () => {
    mockGetEngagement.mockResolvedValue({ dormantSince: null, engagedSpeakerId: "U061F7AUR" });

    await POST(req(channelMessageBody({ text: "hello" })));

    const resolveArgs = mockResolve.mock.calls[0]?.[0];
    const enqueueArgs = mockEnqueue.mock.calls[0]?.[0] as unknown as { senderId: string };
    expect(resolveArgs?.platformUserId).toBeDefined();
    expect(enqueueArgs.senderId).toBe(resolveArgs?.platformUserId);
  });
});

describe("POST /api/v1/connectors/slack/events — event_callback message (a stranger DMing the app)", () => {
  it("resolves identity and enqueues, anchoring on chatIdentityId for an unbound (intro) sender", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });

    const res = await POST(req(messageEventBody()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(mockResolve).toHaveBeenCalledWith({
      platform: "slack",
      platformUserId: "T1:U061F7AUR",
    });
    expect(mockEnqueue).toHaveBeenCalledWith({
      chatIdentityId: "chat-identity-1",
      channel: "slack",
      conversationKey: "T1:D0PNCRP9N",
      kind: "message",
      senderId: "T1:U061F7AUR",
      providerMessageId: "D0PNCRP9N:Ev0PV52K21",
      payload: {
        chatId: "D0PNCRP9N",
        text: "hello jace",
        fromId: "U061F7AUR",
        teamId: "T1",
        mentionsBot: false,
        mentionsOtherUsers: false,
        repliesToMessageId: null,
        repliesToBot: false,
      },
    });
  });

  it("anchors on workspaceId (not chatIdentityId) for a bound identity", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-2", workspaceId: "ws-1" } as never,
      created: false,
      disposition: "bound",
    });
    mockEnqueue.mockResolvedValue({ id: "row-2", deduped: false });

    await POST(req(messageEventBody()));

    const enqueueArgs = mockEnqueue.mock.calls[0]?.[0];
    expect(enqueueArgs).toMatchObject({ workspaceId: "ws-1" });
    expect(enqueueArgs).not.toHaveProperty("chatIdentityId");
  });

  it("returns { ok: true, deduped: true } on a redelivered event_id, without erroring", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: false,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: null, deduped: true });

    const res = await POST(req(messageEventBody()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deduped: true });
  });

  it("kicks the dispatcher fire-and-forget after a fresh enqueue", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });

    const res = await POST(req(messageEventBody()));

    expect(res.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("never lets a dispatcher rejection surface into the route's response (fire-and-forget)", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });
    mockDispatch.mockRejectedValueOnce(new Error("drain blew up"));

    const res = await POST(req(messageEventBody()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("POST /api/v1/connectors/slack/events — thread-scoped channel conversations", () => {
  beforeEach(() => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });
    // These tests are about thread-key computation, not engagement — none of
    // these messages mention the bot, so admit them via an engaged session
    // rather than folding engagement concerns into thread-keying assertions.
    mockGetEngagement.mockResolvedValue({ dormantSince: null, engagedSpeakerId: "U061F7AUR" });
  });

  it("keys a top-level channel message on its own thread and carries threadTs", async () => {
    const res = await POST(
      req(
        messageEventBody({
          event: {
            channel: "C123",
            channel_type: undefined,
            ts: "1700000000.000100",
          },
        })
      )
    );

    expect(res.status).toBe(200);
    expect(mockEnqueue).toHaveBeenCalledWith({
      chatIdentityId: "chat-identity-1",
      channel: "slack",
      conversationKey: "T1:C123:1700000000.000100",
      kind: "message",
      senderId: "T1:U061F7AUR",
      providerMessageId: "C123:Ev0PV52K21",
      payload: {
        chatId: "C123",
        text: "hello jace",
        fromId: "U061F7AUR",
        teamId: "T1",
        threadTs: "1700000000.000100",
        mentionsBot: false,
        mentionsOtherUsers: false,
        repliesToMessageId: null,
        repliesToBot: false,
      },
    });
  });

  it("keys an in-thread reply on the thread root, not on the reply's own ts", async () => {
    const res = await POST(
      req(
        messageEventBody({
          event: {
            channel: "C123",
            channel_type: undefined,
            ts: "1700000009.000900",
            thread_ts: "1700000000.000100",
          },
        })
      )
    );

    expect(res.status).toBe(200);
    expect(mockEnqueue).toHaveBeenCalledWith({
      chatIdentityId: "chat-identity-1",
      channel: "slack",
      conversationKey: "T1:C123:1700000000.000100",
      kind: "message",
      senderId: "T1:U061F7AUR",
      providerMessageId: "C123:Ev0PV52K21",
      payload: {
        chatId: "C123",
        text: "hello jace",
        fromId: "U061F7AUR",
        teamId: "T1",
        threadTs: "1700000000.000100",
        mentionsBot: false,
        mentionsOtherUsers: false,
        repliesToMessageId: null,
        repliesToBot: false,
      },
    });
  });

  it("leaves a DM byte-unchanged in shape — channel-keyed (now team-scoped), no threadTs key at all", async () => {
    const res = await POST(req(messageEventBody()));

    expect(res.status).toBe(200);
    const arg = mockEnqueue.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    // Final whole-branch review, finding #2: team-scoped, not the bare
    // channel id — see slack-thread.ts's own doc-comment.
    expect(arg["conversationKey"]).toBe("T1:D0PNCRP9N");
    expect(arg["payload"]).not.toHaveProperty("threadTs");
  });

  // Final whole-branch review, finding #2 — the cross-tenant test the fix
  // exists for: the SAME channel id from two different teams must resolve to
  // DIFFERENT conversationKeys, so a pinned session in one workspace can
  // never be ridden into by the other.
  it("the SAME channel id from two DIFFERENT teams never collides onto the same conversationKey", async () => {
    mockGetInstallation.mockImplementation(async (teamId: string) => {
      if (teamId === "TEAM_A") return installation({ teamId: "TEAM_A", botUserId: "UBOTTEAMA" });
      if (teamId === "TEAM_B") return installation({ teamId: "TEAM_B", botUserId: "UBOTTEAMB" });
      return null;
    });

    await POST(
      req(messageEventBody({ team_id: "TEAM_A", event: { channel: "C_SHARED" } }))
    );
    await POST(
      req(messageEventBody({ team_id: "TEAM_B", event: { channel: "C_SHARED" } }))
    );

    const keyA = (mockEnqueue.mock.calls[0]?.[0] as unknown as { conversationKey: string })
      .conversationKey;
    const keyB = (mockEnqueue.mock.calls[1]?.[0] as unknown as { conversationKey: string })
      .conversationKey;
    expect(keyA).not.toBe(keyB);
  });

  // Final whole-branch review, finding #2 (minor): admit a thread_broadcast
  // reply (Slack's "Also send to channel" checkbox) exactly like any other
  // in-thread reply — same conversationKey (thread root), same threadTs.
  it("admits a subtype: 'thread_broadcast' in-thread reply and enqueues it like a normal message", async () => {
    const res = await POST(
      req(
        messageEventBody({
          event: {
            channel: "C123",
            channel_type: undefined,
            ts: "1700000009.000900",
            thread_ts: "1700000000.000100",
            subtype: "thread_broadcast",
          },
        })
      )
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockEnqueue).toHaveBeenCalledWith({
      chatIdentityId: "chat-identity-1",
      channel: "slack",
      conversationKey: "T1:C123:1700000000.000100",
      kind: "message",
      senderId: "T1:U061F7AUR",
      providerMessageId: "C123:Ev0PV52K21",
      payload: {
        chatId: "C123",
        text: "hello jace",
        fromId: "U061F7AUR",
        teamId: "T1",
        threadTs: "1700000000.000100",
        mentionsBot: false,
        mentionsOtherUsers: false,
        repliesToMessageId: null,
        repliesToBot: false,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Final whole-branch review, finding #3 — app_uninstalled must actually reach
// revokeSlackInstallation. Before this fix, every non-"message" event
// (including app_uninstalled) fell into the generic "not a message this door
// understands" ignore branch and was silently dropped; revokeSlackInstallation
// had no caller in production at all.
// ---------------------------------------------------------------------------

describe("POST /api/v1/connectors/slack/events — app_uninstalled", () => {
  function uninstallBody(team_id = DEFAULT_TEAM_ID) {
    return JSON.stringify({
      token: "tok",
      team_id,
      api_app_id: "A1",
      event: { type: "app_uninstalled" },
      type: "event_callback",
      event_id: "EvUNINSTALL1",
      event_time: 1515449483,
    });
  }

  it("revokes the installation for the uninstalling team", async () => {
    const res = await POST(req(uninstallBody("T1")));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockRevoke).toHaveBeenCalledWith("T1");
    expect(mockRevoke).toHaveBeenCalledTimes(1);
  });

  it("never enqueues, never resolves identity, never looks up an installation for an app_uninstalled event", async () => {
    await POST(req(uninstallBody("T1")));

    expect(mockGetInstallation).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("revokes by the event's OWN team_id, not whatever the default fixture team is", async () => {
    await POST(req(uninstallBody("T_SOME_OTHER_TEAM")));

    expect(mockRevoke).toHaveBeenCalledWith("T_SOME_OTHER_TEAM");
  });

  it("logs and does not call revoke when team_id is missing, without throwing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = JSON.stringify({
      token: "tok",
      api_app_id: "A1",
      event: { type: "app_uninstalled" },
      type: "event_callback",
      event_id: "EvUNINSTALL2",
      event_time: 1515449483,
    });

    const res = await POST(req(raw));

    expect(res.status).toBe(200);
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
