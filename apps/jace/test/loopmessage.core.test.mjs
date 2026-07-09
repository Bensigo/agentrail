import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOOPMESSAGE_SEND_URL,
  buildSendBody,
  imessageContinuationToken,
  isActionableInbound,
  isAllowedSender,
  loopMessageSendHeaders,
  parseAllowedHandles,
  parseLoopInbound,
  verifyWebhookAuthorization,
} from "../agent/lib/loopmessage.core.mjs";

test("LOOPMESSAGE_SEND_URL is the documented Send endpoint", () => {
  assert.equal(
    LOOPMESSAGE_SEND_URL,
    "https://a.loopmessage.com/api/v1/message/send/",
  );
});

test("loopMessageSendHeaders sends the RAW api key (no Bearer prefix)", () => {
  const headers = loopMessageSendHeaders("secret-key-123");
  assert.equal(headers.Authorization, "secret-key-123");
  assert.equal(headers["Content-Type"], "application/json");
  // must NOT wrap the key in a Bearer scheme — LoopMessage rejects that
  assert.doesNotMatch(headers.Authorization, /^Bearer /);
});

test("loopMessageSendHeaders coerces a missing key to an empty string", () => {
  assert.equal(loopMessageSendHeaders(undefined).Authorization, "");
});

test("buildSendBody builds a 1:1 message with recipient + sender_name", () => {
  const body = buildSendBody({
    recipient: "+15551234567",
    text: "PR ready",
    senderName: "jace.imsg.co",
  });
  assert.deepEqual(body, {
    text: "PR ready",
    recipient: "+15551234567",
    sender_name: "jace.imsg.co",
  });
});

test("buildSendBody omits sender_name when it is blank", () => {
  const body = buildSendBody({ recipient: "+1555", text: "hi", senderName: "" });
  assert.deepEqual(body, { text: "hi", recipient: "+1555" });
  assert.equal("sender_name" in body, false);
});

test("buildSendBody addresses a group with `group` and no recipient/sender", () => {
  const body = buildSendBody({
    group: "grp_abc",
    text: "done",
    senderName: "jace.imsg.co",
    recipient: "ignored-when-group-set",
  });
  assert.deepEqual(body, { text: "done", group: "grp_abc" });
  assert.equal("recipient" in body, false);
  assert.equal("sender_name" in body, false);
});

test("buildSendBody trims recipient and coerces missing text to empty", () => {
  const body = buildSendBody({ recipient: "  +1555  " });
  assert.deepEqual(body, { text: "", recipient: "+1555" });
});

test("parseLoopInbound normalizes a 1:1 inbound message", () => {
  const parsed = parseLoopInbound({
    event: "message_inbound",
    contact: "  +15551234567 ",
    text: "  hey jace  ",
    message_id: "msg_1",
    api_version: "1.0",
  });
  assert.deepEqual(parsed, {
    event: "message_inbound",
    text: "hey jace",
    contact: "+15551234567",
    group: null,
    messageId: "msg_1",
  });
});

test("parseLoopInbound captures a group id when present", () => {
  const parsed = parseLoopInbound({
    event: "message_inbound",
    contact: "+1555",
    group: "grp_xyz",
    text: "hi all",
  });
  assert.equal(parsed.group, "grp_xyz");
  assert.equal(parsed.messageId, null);
});

test("parseLoopInbound returns null for a non-object payload", () => {
  assert.equal(parseLoopInbound(null), null);
  assert.equal(parseLoopInbound("nope"), null);
  assert.equal(parseLoopInbound([1, 2]), null);
});

test("isActionableInbound is true only for a non-empty inbound text with an address", () => {
  assert.equal(
    isActionableInbound(parseLoopInbound({
      event: "message_inbound",
      contact: "+1555",
      text: "hi",
    })),
    true,
  );
  // group-only inbound is still actionable
  assert.equal(
    isActionableInbound(parseLoopInbound({
      event: "message_inbound",
      group: "grp_1",
      text: "hi",
    })),
    true,
  );
});

test("isActionableInbound ignores non-inbound events and empty/addressless payloads", () => {
  // wrong event type (delivery receipt etc.)
  assert.equal(
    isActionableInbound(parseLoopInbound({
      event: "message_delivered",
      contact: "+1555",
      text: "hi",
    })),
    false,
  );
  // empty text
  assert.equal(
    isActionableInbound(parseLoopInbound({
      event: "message_inbound",
      contact: "+1555",
      text: "   ",
    })),
    false,
  );
  // no contact and no group
  assert.equal(
    isActionableInbound(parseLoopInbound({
      event: "message_inbound",
      text: "hi",
    })),
    false,
  );
  // null parse
  assert.equal(isActionableInbound(null), false);
});

test("parseAllowedHandles normalizes a comma list to a lowercased Set", () => {
  const set = parseAllowedHandles("  +15551234567 , Foo@Bar.com ,, grp_ABC ");
  assert.deepEqual([...set].sort(), ["+15551234567", "foo@bar.com", "grp_abc"]);
});

test("parseAllowedHandles yields an empty Set for unset/blank/non-string", () => {
  assert.equal(parseAllowedHandles("").size, 0);
  assert.equal(parseAllowedHandles("   ,  , ").size, 0);
  assert.equal(parseAllowedHandles(undefined).size, 0);
  assert.equal(parseAllowedHandles(null).size, 0);
});

test("isAllowedSender is OPEN when the allowlist is empty (unset env)", () => {
  const parsed = parseLoopInbound({
    event: "message_inbound",
    contact: "+1555",
    text: "hi",
  });
  assert.equal(isAllowedSender(parsed, parseAllowedHandles("")), true);
  assert.equal(isAllowedSender(parsed, new Set()), true);
});

test("isAllowedSender matches a 1:1 contact case-insensitively when set", () => {
  const allow = parseAllowedHandles("Foo@Bar.com, +15551234567");
  assert.equal(
    isAllowedSender(
      parseLoopInbound({ event: "message_inbound", contact: "foo@bar.COM", text: "hi" }),
      allow,
    ),
    true,
  );
  assert.equal(
    isAllowedSender(
      parseLoopInbound({ event: "message_inbound", contact: "+15559999999", text: "hi" }),
      allow,
    ),
    false,
  );
});

test("isAllowedSender gates a group message on the group id, not its members", () => {
  const allow = parseAllowedHandles("grp_team");
  // group on the list → allowed even though the contact is not listed
  assert.equal(
    isAllowedSender(
      parseLoopInbound({
        event: "message_inbound",
        contact: "+1555",
        group: "grp_TEAM",
        text: "hi",
      }),
      allow,
    ),
    true,
  );
  // group not on the list → rejected
  assert.equal(
    isAllowedSender(
      parseLoopInbound({
        event: "message_inbound",
        contact: "+1555",
        group: "grp_other",
        text: "hi",
      }),
      allow,
    ),
    false,
  );
});

test("isAllowedSender rejects a null parse", () => {
  assert.equal(isAllowedSender(null, parseAllowedHandles("+1555")), false);
});

test("imessageContinuationToken stringifies the conversation key", () => {
  assert.equal(imessageContinuationToken("+15551234567"), "+15551234567");
  assert.equal(imessageContinuationToken("grp_1"), "grp_1");
  assert.equal(imessageContinuationToken(null), "");
  assert.equal(imessageContinuationToken(undefined), "");
});

test("verifyWebhookAuthorization accepts the exact secret, rejects anything else", () => {
  // Dummy fixture only — the real webhook secret lives in .env.local (gitignored).
  const secret = "test-webhook-secret-fixture-not-a-real-value";
  assert.equal(verifyWebhookAuthorization(secret, secret), true);
  assert.equal(verifyWebhookAuthorization("wrong", secret), false);
  // length-mismatch must not throw (SHA-256 digested before compare)
  assert.equal(verifyWebhookAuthorization("short", secret), false);
  assert.equal(verifyWebhookAuthorization(secret + "x", secret), false);
});

test("verifyWebhookAuthorization FAILS CLOSED when no secret is configured", () => {
  // env unset ⇒ never accept an unauthenticated webhook
  assert.equal(verifyWebhookAuthorization("anything", ""), false);
  assert.equal(verifyWebhookAuthorization("", ""), false);
  assert.equal(verifyWebhookAuthorization("secret", undefined), false);
});

test("verifyWebhookAuthorization rejects an empty/absent received header", () => {
  assert.equal(verifyWebhookAuthorization("", "secret"), false);
  assert.equal(verifyWebhookAuthorization(undefined, "secret"), false);
});
