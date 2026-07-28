import { describe, expect, it } from "vitest";
import { decideEngagement, type ThreadInbound } from "./thread-engagement";

const NOW = new Date("2026-07-28T12:00:00Z");
const ENGAGED = { dormantSince: null, engagedSpeakerId: "U1" };

function inbound(over: Partial<ThreadInbound> = {}): ThreadInbound {
  return {
    channel: "discord",
    isDM: false,
    threadId: "T1",
    senderId: "U1",
    mentionsBot: false,
    mentionsOtherUsers: false,
    repliesToMessageId: null,
    repliesToBot: false,
    ...over,
  };
}

describe("decideEngagement", () => {
  it("always answers a DM, regardless of state", () => {
    const d = decideEngagement({
      inbound: inbound({ isDM: true, threadId: null }),
      state: { dormantSince: NOW, engagedSpeakerId: "U9" },
      now: NOW,
    });
    expect(d.turn).toBe(true);
    expect(d.nextState.dormantSince).toBeNull();
  });

  it("answers a channel message that mentions Jace and engages the sender", () => {
    const d = decideEngagement({
      inbound: inbound({ threadId: null, mentionsBot: true, senderId: "U7" }),
      state: null,
      now: NOW,
    });
    expect(d.turn).toBe(true);
    expect(d.nextState).toEqual({ dormantSince: null, engagedSpeakerId: "U7" });
  });

  it("ignores a channel message with no mention and no session", () => {
    const d = decideEngagement({ inbound: inbound({ threadId: null }), state: null, now: NOW });
    expect(d.turn).toBe(false);
  });

  it("answers an un-mentioned follow-up from the engaged speaker", () => {
    const d = decideEngagement({ inbound: inbound(), state: ENGAGED, now: NOW });
    expect(d.turn).toBe(true);
    expect(d.nextState.dormantSince).toBeNull();
  });

  it("bows out when a DIFFERENT person posts without mentioning Jace", () => {
    const d = decideEngagement({
      inbound: inbound({ senderId: "U2" }),
      state: ENGAGED,
      now: NOW,
    });
    expect(d.turn).toBe(false);
    expect(d.nextState.dormantSince).toEqual(NOW);
  });

  it("bows out when the engaged speaker @-mentions someone else", () => {
    const d = decideEngagement({
      inbound: inbound({ mentionsOtherUsers: true }),
      state: ENGAGED,
      now: NOW,
    });
    expect(d.turn).toBe(false);
    expect(d.nextState.dormantSince).toEqual(NOW);
  });

  it("bows out on a reply to a non-Jace message", () => {
    const d = decideEngagement({
      inbound: inbound({ repliesToMessageId: "M9", repliesToBot: false }),
      state: ENGAGED,
      now: NOW,
    });
    expect(d.turn).toBe(false);
    expect(d.nextState.dormantSince).toEqual(NOW);
  });

  it("still answers a reply to Jace's own message", () => {
    const d = decideEngagement({
      inbound: inbound({ repliesToMessageId: "M9", repliesToBot: true }),
      state: ENGAGED,
      now: NOW,
    });
    expect(d.turn).toBe(true);
  });

  it("mentioning Jace beats every bow-out signal", () => {
    const d = decideEngagement({
      inbound: inbound({ senderId: "U2", mentionsBot: true, mentionsOtherUsers: true }),
      state: ENGAGED,
      now: NOW,
    });
    expect(d.turn).toBe(true);
    expect(d.nextState).toEqual({ dormantSince: null, engagedSpeakerId: "U2" });
  });

  it("stays quiet on an un-mentioned message while dormant", () => {
    const d = decideEngagement({
      inbound: inbound(),
      state: { dormantSince: NOW, engagedSpeakerId: "U1" },
      now: NOW,
    });
    expect(d.turn).toBe(false);
    expect(d.nextState.dormantSince).toEqual(NOW);
  });

  it("re-engages a dormant thread on a mention, from whoever sends it", () => {
    const d = decideEngagement({
      inbound: inbound({ senderId: "U5", mentionsBot: true }),
      state: { dormantSince: NOW, engagedSpeakerId: "U1" },
      now: NOW,
    });
    expect(d.turn).toBe(true);
    expect(d.nextState).toEqual({ dormantSince: null, engagedSpeakerId: "U5" });
  });

  it("treats a thread with a session row but no engaged speaker as needing a mention", () => {
    const d = decideEngagement({
      inbound: inbound(),
      state: { dormantSince: null, engagedSpeakerId: null },
      now: NOW,
    });
    expect(d.turn).toBe(false);
    // Distinguishes "never engaged, stays quiet" from "was engaged, just bowed
    // out": a real bow-out would stamp dormantSince with `now`.
    expect(d.nextState.dormantSince).toBeNull();
  });
});
