// Unit tests for the pure chat-message splitter (no Eve, no network).
//
// splitIntoChatMessages backs the Telegram channel's `message.completed`
// override (agent/channels/telegram.ts): it turns one model reply into
// several human-cadence chat bubbles on blank-line paragraph breaks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { splitIntoChatMessages } from "../agent/lib/chat-split.core.mjs";

test("empty string returns a single-element array unchanged", () => {
  assert.deepEqual(splitIntoChatMessages(""), [""]);
});

test("non-string input passes through as a single-element array", () => {
  assert.deepEqual(splitIntoChatMessages(null), [null]);
  assert.deepEqual(splitIntoChatMessages(undefined), [undefined]);
});

test("a single paragraph (no blank line) stays one message", () => {
  const text = "Sure, I can do that.";
  assert.deepEqual(splitIntoChatMessages(text), [text]);
});

test("a single paragraph is trimmed", () => {
  assert.deepEqual(splitIntoChatMessages("  Sure thing.  "), ["Sure thing."]);
});

test("two paragraphs split into two messages", () => {
  const text = "Done — PR is up.\n\nWant me to open the next issue too?";
  assert.deepEqual(splitIntoChatMessages(text), [
    "Done — PR is up.",
    "Want me to open the next issue too?",
  ]);
});

test("runs of multiple blank lines count as one separator", () => {
  const text = "First thought.\n\n\n\nSecond thought.";
  assert.deepEqual(splitIntoChatMessages(text), [
    "First thought.",
    "Second thought.",
  ]);
});

test("paragraphs within the default cap (3) are returned one-per-message", () => {
  const text = "One.\n\nTwo.\n\nThree.";
  assert.deepEqual(splitIntoChatMessages(text), ["One.", "Two.", "Three."]);
});

test("paragraphs beyond the default cap fold overflow into the last message", () => {
  const text = "One.\n\nTwo.\n\nThree.\n\nFour.";
  assert.deepEqual(splitIntoChatMessages(text), [
    "One.",
    "Two.",
    "Three.\n\nFour.",
  ]);
});

test("no content is dropped when overflow folds — rejoin recovers the original paragraphs", () => {
  const text = "One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.";
  const messages = splitIntoChatMessages(text);
  assert.equal(messages.length, 3);
  assert.equal(messages.join("\n\n"), text);
});

test("maxMessages: 1 folds everything into a single message", () => {
  const text = "One.\n\nTwo.\n\nThree.";
  assert.deepEqual(splitIntoChatMessages(text, { maxMessages: 1 }), [
    "One.\n\nTwo.\n\nThree.",
  ]);
});

test("blank-only segments between real paragraphs are dropped, not counted", () => {
  const text = "One.\n\n   \n\nTwo.";
  assert.deepEqual(splitIntoChatMessages(text), ["One.", "Two."]);
});
