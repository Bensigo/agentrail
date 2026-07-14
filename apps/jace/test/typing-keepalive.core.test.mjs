// Unit tests for the Telegram typing keep-alive. Uses injected fake timers so
// the interval/cap behaviour is verified deterministically, no real time.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTypingKeepalive,
  TYPING_REFRESH_MS,
  TYPING_MAX_MS,
} from "../agent/lib/typing-keepalive.core.mjs";

function fakeTimers() {
  let nextId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    setInterval: (fn, ms) => {
      const id = nextId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timeouts.delete(id),
    // helpers
    intervals,
    timeouts,
    tickIntervals: () => intervals.forEach((e) => e.fn()),
    fireTimeouts: () => {
      // fire a snapshot; a timeout may clear itself via stop()
      [...timeouts.entries()].forEach(([id, e]) => {
        timeouts.delete(id);
        e.fn();
      });
    },
  };
}

function withCounter() {
  let n = 0;
  const fn = () => {
    n += 1;
  };
  fn.count = () => n;
  return fn;
}

test("start sends one typing action immediately", () => {
  const t = fakeTimers();
  const k = createTypingKeepalive(t);
  const typing = withCounter();
  k.start("chat-1", typing);
  assert.equal(typing.count(), 1, "immediate startTyping");
  assert.equal(t.intervals.size, 1, "one refresh interval registered");
  assert.equal(t.timeouts.size, 1, "one safety cap registered");
  assert.equal(k.activeCount(), 1);
});

test("interval refreshes the typing action until stopped", () => {
  const t = fakeTimers();
  const k = createTypingKeepalive(t);
  const typing = withCounter();
  k.start("chat-1", typing);
  t.tickIntervals(); // one refresh
  t.tickIntervals(); // another
  assert.equal(typing.count(), 3, "immediate + 2 refreshes");
});

test("stop clears interval and cap and is idempotent", () => {
  const t = fakeTimers();
  const k = createTypingKeepalive(t);
  k.start("chat-1", () => {});
  k.stop("chat-1");
  assert.equal(t.intervals.size, 0, "interval cleared");
  assert.equal(t.timeouts.size, 0, "cap cleared");
  assert.equal(k.activeCount(), 0);
  k.stop("chat-1"); // second stop must not throw
  k.stop("unknown");
});

test("restarting the same key does not leak a second loop", () => {
  const t = fakeTimers();
  const k = createTypingKeepalive(t);
  k.start("chat-1", () => {});
  k.start("chat-1", () => {});
  assert.equal(t.intervals.size, 1, "still exactly one interval");
  assert.equal(k.activeCount(), 1);
});

test("the safety cap stops the loop even with no explicit stop", () => {
  const t = fakeTimers();
  const k = createTypingKeepalive(t);
  k.start("chat-1", () => {});
  assert.equal(k.activeCount(), 1);
  t.fireTimeouts(); // simulate the maxMs cap firing (e.g. a failed turn)
  assert.equal(k.activeCount(), 0, "cap auto-stopped the loop");
  assert.equal(t.intervals.size, 0);
});

test("two conversations keep independent loops", () => {
  const t = fakeTimers();
  const k = createTypingKeepalive(t);
  const a = withCounter();
  const b = withCounter();
  k.start("chat-a", a);
  k.start("chat-b", b);
  assert.equal(k.activeCount(), 2);
  k.stop("chat-a");
  assert.equal(k.activeCount(), 1, "stopping one leaves the other");
});

test("a throwing sendTyping never propagates", () => {
  const t = fakeTimers();
  const k = createTypingKeepalive(t);
  assert.doesNotThrow(() =>
    k.start("chat-1", () => {
      throw new Error("telegram down");
    }),
  );
  assert.doesNotThrow(() => t.tickIntervals());
});

test("defaults are sane", () => {
  assert.ok(TYPING_REFRESH_MS < 5000, "refresh under Telegram's ~5s expiry");
  assert.ok(TYPING_MAX_MS >= 60000, "cap covers a genuinely slow turn");
});
