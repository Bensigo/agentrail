// Unit tests for root's request_preview_boot core (no SDK, no live network).
// The single HTTP transport is an injected seam, and so are the poll's
// sleep/clock — mirrors console_gated_approval.core.test.mjs's POST-then-poll
// harness (fakeTransport/fakeSleep/fakeClock), applied to the boot plane
// (apps/console/app/api/v1/runner/preview-boots, B2b Task 3 / #1573) instead
// of the approvals seam.
//
// What this file exists to prove: every branch — the happy path, every POST
// degrade, every poll-terminal degrade, the TTL/MAX_POLL_ATTEMPTS backstops,
// and the backoff-before-first-GET + one-blip-retry poll mechanics — resolves
// deterministically and fast, and the function never throws.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PREVIEW_BOOTS_PATH,
  POLL_BACKOFF_MS,
  POLL_JITTER_MS,
  POLL_TTL_MS,
  MAX_POLL_ATTEMPTS,
  BLIP_RETRY_DELAY_MS,
  resolveConsoleConfig,
  buildPreviewBootUrl,
  buildPreviewBootStatusUrl,
  classifyStatus,
  degraded,
  nextBackoffDelay,
  requestPreviewBoot,
} from "../agent/lib/request_preview_boot.core.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
};

const ARGS = {
  eveSessionId: "eve-session-1",
  repo: "ada/widgets",
  prNumber: 7,
  headSha: "abc123def",
};

// A fake transport that records every call and replies from a queue of
// responders (one per call; the last responder repeats if the queue runs
// dry) — lets a single test drive POST-then-multiple-GETs deterministically.
// Mirrors console_gated_approval.core.test.mjs's own helper verbatim.
function fakeTransport(...responders) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url, init });
    const responder = responders[Math.min(i, responders.length - 1)];
    i += 1;
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

// A fake sleep that never really waits — records the requested delay so
// backoff-sequence tests can assert on it without the test taking minutes.
function fakeSleep() {
  const delays = [];
  const fn = async (ms) => {
    delays.push(ms);
  };
  fn.delays = delays;
  return fn;
}

// A fake clock: call 1 returns startMs (establishing the deadline), and every
// call after that advances by stepMs — lets a TTL test jump past the deadline
// without any real waiting.
function fakeClock(startMs, stepMs = 0) {
  let calls = 0;
  return () => {
    const t = startMs + calls * stepMs;
    calls += 1;
    return t;
  };
}

function postedBody(overrides = {}) {
  return { id: "boot-1", deduped: false, ...overrides };
}

function pollBody(overrides = {}) {
  return { status: "pending", url: null, reason: null, ...overrides };
}

// ---------------------------------------------------------------------------
// constants — pinned exactly, since they are part of the documented contract
// (B2b-ii Task 1 brief), not merely an internal implementation detail.
// ---------------------------------------------------------------------------

test("poll constants match the brief exactly", () => {
  assert.equal(PREVIEW_BOOTS_PATH, "/api/v1/runner/preview-boots");
  assert.deepEqual(POLL_BACKOFF_MS, [2000, 5000, 10000]);
  assert.equal(POLL_JITTER_MS, 250);
  assert.equal(POLL_TTL_MS, 8 * 60 * 1000);
  assert.equal(MAX_POLL_ATTEMPTS, 1000);
  assert.equal(BLIP_RETRY_DELAY_MS, 500);
});

// ---------------------------------------------------------------------------
// resolveConsoleConfig / buildPreviewBootUrl / buildPreviewBootStatusUrl
// ---------------------------------------------------------------------------

test("resolveConsoleConfig resolves + trims + de-slashes when both vars are set", () => {
  const cfg = resolveConsoleConfig({
    JACE_CONSOLE_BASE_URL: "  https://c.example.com/  ",
    JACE_CONSOLE_TOKEN: "  tok  ",
  });
  assert.deepEqual(cfg, { ok: true, baseUrl: "https://c.example.com", token: "tok" });
});

test("resolveConsoleConfig reports exactly which vars are missing", () => {
  assert.deepEqual(resolveConsoleConfig({}), {
    ok: false,
    missing: ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"],
  });
  assert.deepEqual(resolveConsoleConfig({ JACE_CONSOLE_BASE_URL: "https://c" }), {
    ok: false,
    missing: ["JACE_CONSOLE_TOKEN"],
  });
});

test("buildPreviewBootUrl joins the base url and the preview-boots path", () => {
  assert.equal(
    buildPreviewBootUrl("https://console.example.com"),
    `https://console.example.com${PREVIEW_BOOTS_PATH}`,
  );
});

test("buildPreviewBootStatusUrl joins the base url, the path, the id, and the eveSessionId query param", () => {
  assert.equal(
    buildPreviewBootStatusUrl("https://console.example.com", "boot-1", "eve-session-1"),
    `https://console.example.com${PREVIEW_BOOTS_PATH}/boot-1?eveSessionId=eve-session-1`,
  );
});

test("buildPreviewBootStatusUrl encodes an id and an eveSessionId that need it", () => {
  assert.equal(
    buildPreviewBootStatusUrl("https://console.example.com", "b/1 x", "s/1 y"),
    `https://console.example.com${PREVIEW_BOOTS_PATH}/b%2F1%20x?eveSessionId=s%2F1+y`,
  );
});

// ---------------------------------------------------------------------------
// classifyStatus — the POST status -> reason mapping
// ---------------------------------------------------------------------------

test("classifyStatus maps POST statuses per the brief: 503/403/404/409/400/2xx/other", () => {
  assert.deepEqual(classifyStatus(200), { ok: true });
  assert.deepEqual(classifyStatus(201), { ok: true });
  assert.equal(classifyStatus(503).reason, "boots_disabled");
  assert.equal(classifyStatus(403).reason, "not_enrolled");
  assert.equal(classifyStatus(404).reason, "session_or_repo");
  assert.equal(classifyStatus(409).reason, "no_workspace");
  assert.equal(classifyStatus(400).reason, "bad_request");
  assert.equal(classifyStatus(500).reason, "request_failed");
  assert.equal(classifyStatus(401).reason, "request_failed");
  assert.equal(classifyStatus(418).reason, "request_failed");
});

// ---------------------------------------------------------------------------
// nextBackoffDelay — 2s -> 5s -> 10s cap, jittered (same schedule as
// console_gated_approval's own poll)
// ---------------------------------------------------------------------------

test("nextBackoffDelay follows the 2s -> 5s -> 10s(cap) sequence, each within [base, base+250ms) jitter", () => {
  const d0 = nextBackoffDelay(0);
  const d1 = nextBackoffDelay(1);
  const d2 = nextBackoffDelay(2);
  const d5 = nextBackoffDelay(5); // beyond the sequence length — stays capped at 10s
  assert.ok(d0 >= 2000 && d0 < 2250, `attempt 0 delay ${d0} out of [2000,2250)`);
  assert.ok(d1 >= 5000 && d1 < 5250, `attempt 1 delay ${d1} out of [5000,5250)`);
  assert.ok(d2 >= 10000 && d2 < 10250, `attempt 2 delay ${d2} out of [10000,10250)`);
  assert.ok(d5 >= 10000 && d5 < 10250, `attempt 5 delay ${d5} out of [10000,10250) (cap)`);
});

// ---------------------------------------------------------------------------
// degraded()
// ---------------------------------------------------------------------------

test("degraded() carries ok:false, degraded:true, a fixed note, and any extra fields", () => {
  const result = degraded("config_missing", { missing: ["JACE_CONSOLE_BASE_URL"] });
  assert.equal(result.ok, false);
  assert.equal(result.degraded, true);
  assert.equal(result.reason, "config_missing");
  assert.equal(typeof result.note, "string");
  assert.ok(result.note.length > 0);
  assert.deepEqual(result.missing, ["JACE_CONSOLE_BASE_URL"]);
});

// ---------------------------------------------------------------------------
// requestPreviewBoot — the happy path
// ---------------------------------------------------------------------------

test("happy path: POST then poll pending x2 then ready -> {ok:true, id, url}", async () => {
  const transport = fakeTransport(
    async () => ({ status: 200, json: async () => postedBody() }), // POST
    async () => ({ status: 200, json: async () => pollBody({ status: "pending" }) }),
    async () => ({ status: 200, json: async () => pollBody({ status: "pending" }) }),
    async () => ({
      status: 200,
      json: async () => pollBody({ status: "ready", url: "https://preview.example.com/boot-1" }),
    }),
  );
  const sleep = fakeSleep();

  const result = await requestPreviewBoot({
    ...ARGS,
    env: ENV,
    transport,
    sleep,
    now: fakeClock(0, 1000),
  });

  assert.deepEqual(result, { ok: true, id: "boot-1", url: "https://preview.example.com/boot-1" });
  assert.equal(transport.calls.length, 4); // POST + 3 GETs
  assert.equal(sleep.delays.length, 3);
  assert.ok(sleep.delays[0] >= 2000 && sleep.delays[0] < 2250);
  assert.ok(sleep.delays[1] >= 5000 && sleep.delays[1] < 5250);
  assert.ok(sleep.delays[2] >= 10000 && sleep.delays[2] < 10250);

  const postCall = transport.calls[0];
  assert.equal(postCall.url, `https://console.example.com${PREVIEW_BOOTS_PATH}`);
  assert.equal(postCall.init.method, "POST");
  assert.equal(postCall.init.headers.Authorization, "Bearer tok-secret-123");
  assert.equal(postCall.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(postCall.init.body), {
    eveSessionId: "eve-session-1",
    repo: "ada/widgets",
    prNumber: 7,
    headSha: "abc123def",
  });

  const getCall = transport.calls[1];
  assert.equal(
    getCall.url,
    `https://console.example.com${PREVIEW_BOOTS_PATH}/boot-1?eveSessionId=eve-session-1`,
  );
  assert.equal(getCall.init.method, "GET");
  assert.equal(getCall.init.headers.Authorization, "Bearer tok-secret-123");
});

test("poll status ready without a usable URL -> degraded bad_body, never reports a browseable boot", async () => {
  const transport = fakeTransport(
    async () => ({ status: 200, json: async () => postedBody() }),
    async () => ({ status: 200, json: async () => pollBody({ status: "ready", url: "   " }) }),
  );
  const result = await requestPreviewBoot({
    ...ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, degraded("bad_body"));
});

// ---------------------------------------------------------------------------
// requestPreviewBoot — poll-terminal degrades
// ---------------------------------------------------------------------------

test("poll status failed -> degraded boot_failed, carrying the console's own reason", async () => {
  const transport = fakeTransport(
    async () => ({ status: 200, json: async () => postedBody() }),
    async () => ({
      status: 200,
      json: async () => pollBody({ status: "failed", reason: "npm ci exited 1" }),
    }),
  );
  const result = await requestPreviewBoot({
    ...ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, degraded("boot_failed", { reason: "npm ci exited 1" }));
});

test("poll status torn_down -> degraded boot_gone", async () => {
  const transport = fakeTransport(
    async () => ({ status: 200, json: async () => postedBody() }),
    async () => ({ status: 200, json: async () => pollBody({ status: "torn_down" }) }),
  );
  const result = await requestPreviewBoot({
    ...ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, degraded("boot_gone"));
});

test("poll 404 -> degraded boot_lost, no retry (a 404 is stable, not treated as a blip)", async () => {
  const transport = fakeTransport(
    async () => ({ status: 200, json: async () => postedBody() }),
    async () => ({ status: 404, json: async () => ({ error: "boot not found" }) }),
  );
  const result = await requestPreviewBoot({
    ...ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, degraded("boot_lost"));
  assert.equal(transport.calls.length, 2); // POST + the one 404 GET, no blip retry
});

test("TTL exceeded -> degraded boot_timeout, stopping near the TTL rather than exhausting attempts", async () => {
  const transport = fakeTransport(
    async () => ({ status: 200, json: async () => postedBody() }),
    async () => ({ status: 200, json: async () => pollBody({ status: "pending" }) }),
  );
  const sleep = fakeSleep();
  // First now() call establishes the deadline (t=0 -> deadline = 8min).
  // Advance by 6 minutes each subsequent call so the SECOND TTL check (after
  // one full pending poll) is already past the 8-minute deadline.
  const now = fakeClock(0, 6 * 60 * 1000);

  const result = await requestPreviewBoot({ ...ARGS, env: ENV, transport, sleep, now });

  assert.deepEqual(result, degraded("boot_timeout"));
  // Stopped via the TTL check itself: only the POST + exactly one GET
  // happened before the deadline tripped — proves this exited via the clock,
  // not by exhausting MAX_POLL_ATTEMPTS.
  assert.equal(transport.calls.length, 2);
});

test("a broken clock that never advances still terminates -> boot_timeout via the MAX_POLL_ATTEMPTS backstop, never an infinite loop", async () => {
  const transport = fakeTransport(
    async () => ({ status: 200, json: async () => postedBody() }),
    async () => ({ status: 200, json: async () => pollBody({ status: "pending" }) }),
  );
  const result = await requestPreviewBoot({
    ...ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: () => 0, // never advances — TTL math alone can never end this loop
  });
  assert.deepEqual(result, degraded("boot_timeout"));
});

// ---------------------------------------------------------------------------
// requestPreviewBoot — POST-time degrades (no poll attempted for any of these)
// ---------------------------------------------------------------------------

test("POST 503 -> degraded boots_disabled, no poll attempted", async () => {
  const transport = fakeTransport(async () => ({ status: 503, json: async () => ({ error: "preview boots not enabled" }) }));
  const result = await requestPreviewBoot({
    ...ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, degraded("boots_disabled"));
  assert.equal(transport.calls.length, 1);
});

test("POST 403 -> degraded not_enrolled", async () => {
  const transport = fakeTransport(async () => ({ status: 403, json: async () => ({ error: "workspace not enrolled" }) }));
  const result = await requestPreviewBoot({
    ...ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, degraded("not_enrolled"));
  assert.equal(transport.calls.length, 1);
});

test("POST 404 -> degraded session_or_repo", async () => {
  const transport = fakeTransport(async () => ({ status: 404, json: async () => ({ error: "repo not connected to this workspace" }) }));
  const result = await requestPreviewBoot({
    ...ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, degraded("session_or_repo"));
  assert.equal(transport.calls.length, 1);
});

test("POST 409 -> degraded no_workspace", async () => {
  const transport = fakeTransport(async () => ({ status: 409, json: async () => ({ error: "no workspace" }) }));
  const result = await requestPreviewBoot({
    ...ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, degraded("no_workspace"));
  assert.equal(transport.calls.length, 1);
});

test("POST 400 (console-side) -> degraded bad_request", async () => {
  const transport = fakeTransport(async () => ({ status: 400, json: async () => ({ error: "eveSessionId, repo, prNumber, and headSha are required" }) }));
  const result = await requestPreviewBoot({
    ...ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, degraded("bad_request"));
  assert.equal(transport.calls.length, 1);
});

test("blank eveSessionId/repo/headSha or a non-positive-integer prNumber -> degraded bad_request, no call at all (our own pre-validation)", async () => {
  const transport = fakeTransport(async () => ({ status: 200, json: async () => postedBody() }));
  for (const overrides of [
    { eveSessionId: "" },
    { eveSessionId: "   " },
    { repo: "" },
    { repo: "   " },
    { headSha: "" },
    { headSha: "   " },
    { prNumber: 0 },
    { prNumber: -1 },
    { prNumber: 1.5 },
    { prNumber: NaN },
  ]) {
    const result = await requestPreviewBoot({ ...ARGS, ...overrides, env: ENV, transport, sleep: fakeSleep(), now: fakeClock(0, 1000) });
    assert.deepEqual(result, degraded("bad_request"), JSON.stringify(overrides));
  }
  assert.equal(transport.calls.length, 0);
});

test("POST other non-2xx (e.g. 500 or 418) -> degraded request_failed, carrying the status", async () => {
  for (const status of [500, 418, 401]) {
    const transport = fakeTransport(async () => ({ status, json: async () => ({}) }));
    const result = await requestPreviewBoot({
      ...ARGS,
      env: ENV,
      transport,
      sleep: fakeSleep(),
      now: fakeClock(0, 1000),
    });
    assert.equal(result.reason, "request_failed", `status ${status}`);
    assert.equal(result.status, status);
  }
});

test("POST transport throws -> degraded unreachable, single attempt, no poll", async () => {
  const transport = fakeTransport(async () => {
    throw new Error("ECONNREFUSED 10.0.0.1:443");
  });
  const result = await requestPreviewBoot({
    ...ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, degraded("unreachable"));
  assert.equal(transport.calls.length, 1);
});

test("POST 200 with a non-JSON body -> degraded bad_body", async () => {
  const transport = fakeTransport(async () => ({
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  }));
  const result = await requestPreviewBoot({
    ...ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, degraded("bad_body"));
});

test("POST 200 with a body missing/malformed id -> degraded bad_body", async () => {
  for (const body of [{}, { id: 123 }, { id: "" }, { deduped: false }]) {
    const transport = fakeTransport(async () => ({ status: 200, json: async () => body }));
    const result = await requestPreviewBoot({
      ...ARGS,
      env: ENV,
      transport,
      sleep: fakeSleep(),
      now: fakeClock(0, 1000),
    });
    assert.deepEqual(result, degraded("bad_body"), JSON.stringify(body));
  }
});

test("unset config -> degraded config_missing with the missing var names, transport never called", async () => {
  const transport = fakeTransport(async () => ({ status: 200, json: async () => postedBody() }));
  const result = await requestPreviewBoot({ ...ARGS, env: {}, transport, sleep: fakeSleep(), now: fakeClock(0, 1000) });
  assert.equal(result.reason, "config_missing");
  assert.deepEqual(result.missing, ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"]);
  assert.equal(transport.calls.length, 0);
});

// ---------------------------------------------------------------------------
// requestPreviewBoot — the poll loop mechanics: backoff-before-first-GET,
// and the one-blip-retry tolerance on a transient GET throw
// ---------------------------------------------------------------------------

test("backoff happens BEFORE the first GET, and a transient GET throw gets exactly one immediate blip retry before succeeding", async () => {
  const events = [];
  let getCalls = 0;
  const transport = async (url, init) => {
    if (init.method === "POST") {
      events.push("transport:POST");
      return { status: 200, json: async () => postedBody() };
    }
    getCalls += 1;
    events.push("transport:GET");
    if (getCalls === 1) throw new Error("socket hang up — one-off blip");
    return { status: 200, json: async () => pollBody({ status: "ready", url: "https://preview.example.com/boot-1" }) };
  };
  const sleep = async (ms) => {
    events.push(`sleep:${ms}`);
  };

  const result = await requestPreviewBoot({
    ...ARGS,
    env: ENV,
    transport,
    sleep,
    now: fakeClock(0, 1000),
  });

  assert.deepEqual(result, { ok: true, id: "boot-1", url: "https://preview.example.com/boot-1" });
  assert.equal(events.length, 5);
  assert.equal(events[0], "transport:POST");
  assert.ok(events[1].startsWith("sleep:"), events[1]); // backoff BEFORE the first GET
  const firstBackoff = Number(events[1].split(":")[1]);
  assert.ok(firstBackoff >= 2000 && firstBackoff < 2250, `${firstBackoff}`);
  assert.equal(events[2], "transport:GET"); // the failing first GET
  assert.equal(events[3], "sleep:500"); // BLIP_RETRY_DELAY_MS — fixed, unjittered
  assert.equal(events[4], "transport:GET"); // the retried, recovered GET
});

test("GET throws TWICE in a row (blip retry also fails) -> this attempt yields no verdict; polling continues and can still succeed later", async () => {
  const transport = fakeTransport(
    async () => ({ status: 200, json: async () => postedBody() }), // POST
    async () => {
      throw new Error("blip 1");
    }, // GET attempt 1
    async () => {
      throw new Error("blip 1 retry"); // GET attempt 1's blip retry — also fails
    },
    async () => ({ status: 200, json: async () => pollBody({ status: "pending" }) }), // GET attempt 2
    async () => ({
      status: 200,
      json: async () => pollBody({ status: "ready", url: "https://preview.example.com/boot-1" }),
    }), // GET attempt 3
  );
  const sleep = fakeSleep();

  const result = await requestPreviewBoot({
    ...ARGS,
    env: ENV,
    transport,
    sleep,
    now: fakeClock(0, 1000),
  });

  assert.deepEqual(result, { ok: true, id: "boot-1", url: "https://preview.example.com/boot-1" });
  // POST + (GET1 throw + GET1-retry throw) + GET2(pending) + GET3(ready)
  assert.equal(transport.calls.length, 5);
  // backoff(attempt0), blip(500), backoff(attempt1), backoff(attempt2)
  assert.equal(sleep.delays.length, 4);
  assert.equal(sleep.delays[1], 500);
});

test("GET throws once, then the blip retry itself comes back 404 -> degraded boot_lost (still no second retry)", async () => {
  const transport = fakeTransport(
    async () => ({ status: 200, json: async () => postedBody() }),
    async () => {
      throw new Error("blip");
    },
    async () => ({ status: 404, json: async () => ({ error: "boot not found" }) }),
  );
  const result = await requestPreviewBoot({
    ...ARGS,
    env: ENV,
    transport,
    sleep: fakeSleep(),
    now: fakeClock(0, 1000),
  });
  assert.deepEqual(result, degraded("boot_lost"));
  assert.equal(transport.calls.length, 3); // POST + failing GET + the 404 retry, no third GET
});

// ---------------------------------------------------------------------------
// no secrets or raw transport error text in any degraded result
// ---------------------------------------------------------------------------

test("degraded results never carry free-form transport error text or the bearer token", async () => {
  const cases = [
    async () =>
      requestPreviewBoot({
        ...ARGS,
        env: ENV,
        transport: fakeTransport(async () => {
          throw new Error("SECRET-LEAK tok-secret-123");
        }),
        sleep: fakeSleep(),
        now: fakeClock(0, 1000),
      }),
    async () =>
      requestPreviewBoot({
        ...ARGS,
        env: ENV,
        transport: fakeTransport(
          async () => ({ status: 200, json: async () => postedBody() }),
          async () => {
            throw new Error("SECRET-LEAK mid-poll");
          },
          async () => {
            throw new Error("SECRET-LEAK mid-poll retry");
          },
        ),
        sleep: fakeSleep(),
        now: () => 999999999999, // past the TTL on the very next check, ends the loop fast
      }),
  ];
  for (const run of cases) {
    const result = await run();
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /SECRET-LEAK/);
    assert.doesNotMatch(serialized, /tok-secret-123/);
    assert.doesNotMatch(serialized, /console\.example\.com/);
  }
});
