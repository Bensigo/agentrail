import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeHostedInbound } from "../agent/lib/hosted_inbound.core.mjs";

test("normalizeHostedInbound accepts a valid minimal payload", () => {
  const out = normalizeHostedInbound({
    message: "hello jace",
    target: { chatId: 555 },
    auth: { authenticator: "agentrail", principalType: "service", principalId: "chat-identity-1" },
  });
  assert.deepEqual(out, {
    message: "hello jace",
    target: { chatId: 555 },
    auth: { authenticator: "agentrail", principalType: "service", principalId: "chat-identity-1" },
  });
});

test("normalizeHostedInbound trims the message", () => {
  const out = normalizeHostedInbound({
    message: "  spaced  ",
    target: { chatId: 1 },
    auth: {},
  });
  assert.equal(out.message, "spaced");
});

test("normalizeHostedInbound rejects a non-object payload", () => {
  assert.throws(() => normalizeHostedInbound(null), /must be a JSON object/);
  assert.throws(() => normalizeHostedInbound("nope"), /must be a JSON object/);
  assert.throws(() => normalizeHostedInbound([1, 2]), /must be a JSON object/);
  assert.throws(() => normalizeHostedInbound(undefined), /must be a JSON object/);
});

test("normalizeHostedInbound rejects a missing / blank message", () => {
  assert.throws(
    () => normalizeHostedInbound({ target: { chatId: 1 }, auth: {} }),
    /`message` is required/,
  );
  assert.throws(
    () => normalizeHostedInbound({ message: "   ", target: { chatId: 1 }, auth: {} }),
    /`message` is required/,
  );
});

test("normalizeHostedInbound rejects a non-object target", () => {
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", auth: {} }),
    /`target` must be an object/,
  );
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", target: "555", auth: {} }),
    /`target` must be an object/,
  );
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", target: [1], auth: {} }),
    /`target` must be an object/,
  );
});

test("normalizeHostedInbound rejects a target missing chatId (Eve's telegram receive hook throws without it)", () => {
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", target: {}, auth: {} }),
    /`target\.chatId` is required/,
  );
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", target: { chatId: "  " }, auth: {} }),
    /`target\.chatId` is required/,
  );
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", target: { chatId: null }, auth: {} }),
    /`target\.chatId` is required/,
  );
});

test("normalizeHostedInbound accepts a numeric or string chatId, passed through unchanged", () => {
  const numeric = normalizeHostedInbound({ message: "hi", target: { chatId: 555 }, auth: {} });
  assert.equal(numeric.target.chatId, 555);

  const stringy = normalizeHostedInbound({ message: "hi", target: { chatId: "555" }, auth: {} });
  assert.equal(stringy.target.chatId, "555");
});

test("normalizeHostedInbound keeps conversationId when present, omits when absent", () => {
  const withConvo = normalizeHostedInbound({
    message: "hi",
    target: { chatId: 1, conversationId: 42 },
    auth: {},
  });
  assert.deepEqual(withConvo.target, { chatId: 1, conversationId: 42 });

  const withoutConvo = normalizeHostedInbound({ message: "hi", target: { chatId: 1 }, auth: {} });
  assert.equal("conversationId" in withoutConvo.target, false);
});

test("normalizeHostedInbound keeps messageThreadId when present, omits when absent", () => {
  const withThread = normalizeHostedInbound({
    message: "hi",
    target: { chatId: 1, messageThreadId: 7 },
    auth: {},
  });
  assert.deepEqual(withThread.target, { chatId: 1, messageThreadId: 7 });

  const withoutThread = normalizeHostedInbound({ message: "hi", target: { chatId: 1 }, auth: {} });
  assert.equal("messageThreadId" in withoutThread.target, false);
});

test("normalizeHostedInbound drops stray target keys (minimal target, matches run_outcome.core's convention)", () => {
  const out = normalizeHostedInbound({
    message: "hi",
    target: { chatId: 1, botToken: "SECRET", somethingElse: "x" },
    auth: {},
  });
  assert.deepEqual(out.target, { chatId: 1 });
});

test("normalizeHostedInbound rejects a missing auth (auth is required, unlike run-outcome's optional auth)", () => {
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", target: { chatId: 1 } }),
    /`auth` is required/,
  );
});

test("normalizeHostedInbound rejects an explicit null auth", () => {
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", target: { chatId: 1 }, auth: null }),
    /`auth` is required/,
  );
});

test("normalizeHostedInbound rejects a non-object auth", () => {
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", target: { chatId: 1 }, auth: "chat-identity-1" }),
    /`auth`.*must be an object/,
  );
  assert.throws(
    () => normalizeHostedInbound({ message: "hi", target: { chatId: 1 }, auth: [1, 2] }),
    /`auth`.*must be an object/,
  );
});

test("normalizeHostedInbound passes auth through UNCHANGED (deep, not just present)", () => {
  const auth = {
    authenticator: "agentrail",
    principalType: "service",
    principalId: "ws-1",
    attributes: { chatIdentityId: "chat-1", workspaceId: "ws-1", channel: "telegram", conversationKey: "555" },
  };
  const out = normalizeHostedInbound({ message: "hi", target: { chatId: 1 }, auth });
  assert.deepEqual(out.auth, auth);
});
