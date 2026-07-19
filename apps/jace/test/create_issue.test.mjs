import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIssueBody,
  buildCreateArgv,
  parseCreateOutput,
  runCreateIssue,
  notConnectedGuidance,
  NOT_CONNECTED_MARKER,
  buildPublishedStampUrl,
  stampCreatedIssueUrl,
} from "../agent/lib/create_issue.core.mjs";

test("buildIssueBody renders the house-format sections in order", () => {
  const body = buildIssueBody({
    parent: "Runner epic",
    requiredContext: "Keep the CLI as the sole write path.",
    whatToBuild: "A health endpoint on the runner.",
    acceptanceCriteria: [
      "GET /health returns 200",
      "body is {ok:true}",
    ],
    verification: "curl the endpoint and assert status 200.",
  });

  assert.match(body, /## Parent\nRunner epic/);
  assert.match(body, /## Required context\nKeep the CLI as the sole write path\./);
  assert.match(body, /## What to build\nA health endpoint on the runner\./);
  assert.match(body, /## Acceptance criteria\n/);
  assert.match(body, /## Verification evidence\ncurl the endpoint and assert status 200\./);
});

test("buildIssueBody numbers acceptance criteria as checkboxes", () => {
  const body = buildIssueBody({
    acceptanceCriteria: ["first", "second", "third"],
  });
  assert.match(body, /- \[ \] AC1: first/);
  assert.match(body, /- \[ \] AC2: second/);
  assert.match(body, /- \[ \] AC3: third/);
});

test("buildIssueBody throws on empty acceptanceCriteria", () => {
  assert.throws(
    () => buildIssueBody({ acceptanceCriteria: [] }),
    /acceptanceCriteria must be a non-empty array/,
  );
  assert.throws(
    () => buildIssueBody({}),
    /acceptanceCriteria must be a non-empty array/,
  );
});

test("buildCreateArgv produces the exact args array", () => {
  const argv = buildCreateArgv({
    repo: "Bensigo/agentrail",
    title: "My title",
    body: "MARKDOWN BODY",
  });
  assert.deepEqual(argv, [
    "issue",
    "create",
    "--connector",
    "github",
    "--repo",
    "Bensigo/agentrail",
    "--title",
    "My title",
    "--body",
    "MARKDOWN BODY",
  ]);
});

test("buildCreateArgv omits --repo when repo is not given", () => {
  const argv = buildCreateArgv({ title: "My title", body: "MARKDOWN BODY" });
  assert.deepEqual(argv, [
    "issue",
    "create",
    "--connector",
    "github",
    "--title",
    "My title",
    "--body",
    "MARKDOWN BODY",
  ]);
});

test("buildCreateArgv omits --repo when repo is an empty string", () => {
  const argv = buildCreateArgv({ repo: "", title: "t", body: "b" });
  assert.ok(!argv.includes("--repo"));
});

test("parseCreateOutput parses the real success line", () => {
  const stdout =
    "Created Bensigo/agentrail#1042 (label ready-for-agent): https://github.com/Bensigo/agentrail/issues/1042\n";
  const parsed = parseCreateOutput(stdout);
  assert.deepEqual(parsed, {
    repo: "Bensigo/agentrail",
    number: 1042,
    label: "ready-for-agent",
    url: "https://github.com/Bensigo/agentrail/issues/1042",
  });
});

test("parseCreateOutput finds the line among surrounding noise", () => {
  const stdout =
    "some warning\nCreated owner/repo#7 (label ready-for-agent): https://x/issues/7\ntrailing\n";
  const parsed = parseCreateOutput(stdout);
  assert.equal(parsed.repo, "owner/repo");
  assert.equal(parsed.number, 7);
  assert.equal(parsed.url, "https://x/issues/7");
});

test("parseCreateOutput throws on garbage and surfaces the raw stdout", () => {
  assert.throws(
    () => parseCreateOutput("nope, nothing here"),
    /could not parse the CLI success line[\s\S]*nope, nothing here/,
  );
});

test("runCreateIssue with a fake execFileFn returns the parsed ref and calls with the right bin+argv", async () => {
  const calls = [];
  const fakeExec = async (bin, argv, opts) => {
    calls.push({ bin, argv, opts });
    return {
      stdout:
        "Created Bensigo/agentrail#1042 (label ready-for-agent): https://github.com/Bensigo/agentrail/issues/1042\n",
      stderr: "",
    };
  };

  const ref = await runCreateIssue({
    execFileFn: fakeExec,
    env: { JACE_TARGET_REPO: "Bensigo/agentrail" },
    title: "Add a health endpoint",
    parent: "Runner epic",
    acceptanceCriteria: ["GET /health returns 200"],
    verification: "curl it",
  });

  assert.deepEqual(ref, {
    repo: "Bensigo/agentrail",
    number: 1042,
    label: "ready-for-agent",
    url: "https://github.com/Bensigo/agentrail/issues/1042",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, "agentrail");
  assert.equal(calls[0].argv[0], "issue");
  assert.equal(calls[0].argv[1], "create");
  assert.deepEqual(calls[0].argv.slice(0, 6), [
    "issue",
    "create",
    "--connector",
    "github",
    "--repo",
    "Bensigo/agentrail",
  ]);
  // title and body are the last four tokens
  assert.equal(calls[0].argv[6], "--title");
  assert.equal(calls[0].argv[7], "Add a health endpoint");
  assert.equal(calls[0].argv[8], "--body");
  assert.match(calls[0].argv[9], /- \[ \] AC1: GET \/health returns 200/);
});

test("runCreateIssue honors JACE_AGENTRAIL_BIN override", async () => {
  let seenBin = null;
  const fakeExec = async (bin) => {
    seenBin = bin;
    return {
      stdout: "Created a/b#1 (label ready-for-agent): https://x/issues/1\n",
      stderr: "",
    };
  };
  await runCreateIssue({
    execFileFn: fakeExec,
    env: { JACE_TARGET_REPO: "a/b", JACE_AGENTRAIL_BIN: "/opt/agentrail" },
    title: "t",
    acceptanceCriteria: ["ac"],
  });
  assert.equal(seenBin, "/opt/agentrail");
});

test("runCreateIssue prefers explicit repo over JACE_TARGET_REPO", async () => {
  let seenRepo = null;
  const fakeExec = async (bin, argv) => {
    seenRepo = argv[argv.indexOf("--repo") + 1];
    return {
      stdout: "Created x/y#2 (label ready-for-agent): https://x/issues/2\n",
      stderr: "",
    };
  };
  await runCreateIssue({
    execFileFn: fakeExec,
    env: { JACE_TARGET_REPO: "env/repo" },
    repo: "explicit/repo",
    title: "t",
    acceptanceCriteria: ["ac"],
  });
  assert.equal(seenRepo, "explicit/repo");
});

test("runCreateIssue omits --repo when neither repo nor JACE_TARGET_REPO is set (CLI resolves it)", async () => {
  // Connecting a repo on the console must be sufficient — no manual repo
  // config required from Jace's side. The CLI resolves the repo itself.
  let seenArgv = null;
  const fakeExec = async (bin, argv) => {
    seenArgv = argv;
    return {
      stdout: "Created a/b#1 (label ready-for-agent): https://x/issues/1\n",
    };
  };
  const ref = await runCreateIssue({
    execFileFn: fakeExec,
    env: {},
    title: "t",
    acceptanceCriteria: ["ac"],
  });
  assert.ok(!seenArgv.includes("--repo"));
  assert.equal(ref.repo, "a/b");
});

test("runCreateIssue surfaces a clear error when the CLI fails", async () => {
  const failing = async () => {
    const err = new Error("exit code 1");
    err.stderr = "gh: not authenticated";
    throw err;
  };
  await assert.rejects(
    () =>
      runCreateIssue({
        execFileFn: failing,
        env: { JACE_TARGET_REPO: "a/b" },
        title: "t",
        acceptanceCriteria: ["ac"],
      }),
    /issue create` failed[\s\S]*gh: not authenticated/,
  );
});

// ---------------------------------------------------------------------------
// "Connect a repo first" graceful guidance (no separately-supplied GitHub PAT,
// no manual JACE_TARGET_REPO) — the CLI signals via NOT_CONNECTED_MARKER when
// it can resolve NEITHER a repo NOR a token for the workspace.
// ---------------------------------------------------------------------------

test("notConnectedGuidance includes the console URL when configured", () => {
  const msg = notConnectedGuidance({ JACE_CONSOLE_BASE_URL: "https://app.agentrail.dev/" });
  assert.match(msg, /connect a repo/i);
  assert.match(msg, /https:\/\/app\.agentrail\.dev/);
  assert.ok(!msg.endsWith("/"), "trailing slash from the base URL is stripped");
});

test("notConnectedGuidance still reads fine with no console URL configured", () => {
  const msg = notConnectedGuidance({});
  assert.match(msg, /connect a repo/i);
});

test("runCreateIssue returns friendly guidance instead of throwing when the CLI reports not connected", async () => {
  const failing = async () => {
    const err = new Error("exit code 3");
    err.stderr =
      `${NOT_CONNECTED_MARKER}: no GitHub repo is connected for this workspace ` +
      "(and no --repo was given). Connect a repo on the AgentRail console.";
    throw err;
  };
  const result = await runCreateIssue({
    execFileFn: failing,
    env: { JACE_CONSOLE_BASE_URL: "https://app.agentrail.dev" },
    title: "t",
    acceptanceCriteria: ["ac"],
  });
  assert.deepEqual(result, {
    connected: false,
    message: notConnectedGuidance({ JACE_CONSOLE_BASE_URL: "https://app.agentrail.dev" }),
  });
});

test("runCreateIssue does not mistake an unrelated CLI failure for not-connected", async () => {
  const failing = async () => {
    const err = new Error("exit code 1");
    err.stderr = "gh: rate limited";
    throw err;
  };
  await assert.rejects(
    () =>
      runCreateIssue({
        execFileFn: failing,
        env: {},
        title: "t",
        acceptanceCriteria: ["ac"],
      }),
    /issue create` failed[\s\S]*rate limited/,
  );
});

// ---------------------------------------------------------------------------
// Prompt-injection hardening at the write seam (issue #1124).
//
// The researcher's brief reaches Jace as a MODEL-READ tool result with no
// Jace-authored code seam before the parent drafts. The create_issue write
// path is the first place Jace code touches the blended text again, so it is
// where untrusted content must be neutralized before it lands on GitHub.
// ---------------------------------------------------------------------------

test("buildIssueBody hardens untrusted content in every field", () => {
  const body = buildIssueBody({
    // bidi override (Trojan Source) in the parent
    parent: "Runner‮ epic",
    // zero-width char + a dangerous URL scheme in required context
    requiredContext: "See​ [x](javascript:steal()) for details.",
    // unicode-tag smuggling in what-to-build
    whatToBuild: "Build it\u{E0041}\u{E0042}.",
    // a mass-ping token riding in an acceptance criterion
    acceptanceCriteria: ["ping @everyone when done"],
    // another dangerous scheme in the verification evidence
    verification: "open file:///etc/passwd",
  });

  // hidden channels are gone
  assert.ok(!/[​‮]/u.test(body), "zero-width / bidi stripped");
  assert.ok(!/[\u{E0000}-\u{E007F}]/u.test(body), "unicode tags stripped");
  // dangerous schemes are defanged, http-family would have been left alone
  assert.ok(body.includes("javascript[:]"), "javascript scheme defanged");
  assert.ok(body.includes("file[:]"), "file scheme defanged");
  // mass ping is defanged, not left live
  assert.ok(body.includes("＠everyone"), "@everyone defanged to fullwidth");
  assert.ok(!/@everyone/.test(body), "no live @everyone remains");
});

test("runCreateIssue hardens the title before it reaches argv", async () => {
  let seenTitle = null;
  const fakeExec = async (bin, argv) => {
    seenTitle = argv[argv.indexOf("--title") + 1];
    return {
      stdout: "Created a/b#1 (label ready-for-agent): https://x/issues/1\n",
      stderr: "",
    };
  };
  await runCreateIssue({
    execFileFn: fakeExec,
    env: { JACE_TARGET_REPO: "a/b" },
    // title bypasses buildIssueBody, so it must be hardened in runCreateIssue
    title: "Fix​ bug, ping @everyone",
    acceptanceCriteria: ["ac"],
  });
  assert.ok(!/​/u.test(seenTitle), "zero-width stripped from title");
  assert.ok(seenTitle.includes("＠everyone"), "@everyone defanged in title");
  assert.ok(!/@everyone/.test(seenTitle), "no live @everyone in title");
});

// ---------------------------------------------------------------------------
// #1274 PR ② — the chat-born one-confirm collapse's own write: stamp the
// real GitHub issue URL onto the create_issue approval that gated this
// call, so the label webhook's later redelivery recognizes it as already
// confirmed instead of parking for a second alignment confirm.
//
// THE SAFETY LINE this file exists to prove (mirrors
// console_gated_approval.core.test.mjs's own framing): a failed stamp —
// any transport throw (timeout/network), any non-2xx, a malformed relearn
// response, or missing session context — must NEVER affect
// runCreateIssue's own return value, and stampCreatedIssueUrl itself must
// NEVER throw.
// ---------------------------------------------------------------------------

// A fake transport that records every call and replies from a queue of
// responders — mirrors console_gated_approval.core.test.mjs's own idiom.
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

const STAMP_ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
  JACE_TARGET_REPO: "Bensigo/agentrail",
};

const SUCCESS_STDOUT =
  "Created Bensigo/agentrail#1042 (label ready-for-agent): https://github.com/Bensigo/agentrail/issues/1042\n";

function fakeExecSuccess() {
  return async () => ({ stdout: SUCCESS_STDOUT, stderr: "" });
}

const APPROVED_RELEARN_RESPONDER = async () => ({
  status: 200,
  json: async () => ({ approvalId: "approval-1", status: "approved" }),
});
const OK_STAMP_RESPONDER = async () => ({ status: 200, json: async () => ({ ok: true }) });

test("buildPublishedStampUrl joins the base url, the approvals path, the approvalId, and /published", () => {
  const url = buildPublishedStampUrl("https://console.example.com", "approval-123");
  assert.equal(
    url,
    "https://console.example.com/api/v1/runner/approvals/approval-123/published",
  );
});

test("buildPublishedStampUrl encodes an approvalId that needs it", () => {
  const url = buildPublishedStampUrl("https://console.example.com", "a b/c");
  assert.equal(
    url,
    "https://console.example.com/api/v1/runner/approvals/a%20b%2Fc/published",
  );
});

test("stampCreatedIssueUrl: relearns the approval id via a replay POST, then stamps — both calls made with the right shape", async () => {
  const transport = fakeTransport(APPROVED_RELEARN_RESPONDER, OK_STAMP_RESPONDER);

  await stampCreatedIssueUrl({
    eveSessionId: "eve-session-1",
    turnId: "turn-1",
    toolInput: { title: "x" },
    url: "https://github.com/a/b/issues/1",
    env: STAMP_ENV,
    transport,
  });

  assert.equal(transport.calls.length, 2);
  const [relearnCall, stampCall] = transport.calls;
  assert.equal(relearnCall.url, "https://console.example.com/api/v1/runner/approvals");
  const relearnBody = JSON.parse(relearnCall.init.body);
  assert.equal(relearnBody.eveSessionId, "eve-session-1");
  assert.equal(relearnBody.toolName, "create_issue");
  assert.deepEqual(relearnBody.toolInput, { title: "x" });
  assert.equal(relearnCall.init.headers.Authorization, "Bearer tok-secret-123");

  assert.equal(
    stampCall.url,
    "https://console.example.com/api/v1/runner/approvals/approval-1/published",
  );
  const stampBody = JSON.parse(stampCall.init.body);
  assert.deepEqual(stampBody, { url: "https://github.com/a/b/issues/1" });
});

test("stampCreatedIssueUrl: the relearn call THROWS (timeout/network) -> never throws, the stamp call is never attempted", async () => {
  let stampAttempted = false;
  const throwingTransport = async (url) => {
    if (url.endsWith("/published")) stampAttempted = true;
    throw new Error("ETIMEDOUT");
  };
  await assert.doesNotReject(() =>
    stampCreatedIssueUrl({
      eveSessionId: "eve-session-1",
      toolInput: { title: "x" },
      url: "https://github.com/a/b/issues/1",
      env: STAMP_ENV,
      transport: throwingTransport,
    }),
  );
  assert.equal(stampAttempted, false);
});

test("stampCreatedIssueUrl: relearn succeeds but the STAMP call itself THROWS (timeout) -> never throws", async () => {
  const transport = fakeTransport(APPROVED_RELEARN_RESPONDER, async () => {
    throw new Error("ETIMEDOUT");
  });
  await assert.doesNotReject(() =>
    stampCreatedIssueUrl({
      eveSessionId: "eve-session-1",
      toolInput: { title: "x" },
      url: "https://github.com/a/b/issues/1",
      env: STAMP_ENV,
      transport,
    }),
  );
  assert.equal(transport.calls.length, 2);
});

test("stampCreatedIssueUrl: the relearn POST returns a non-2xx -> never throws, the stamp call is never attempted", async () => {
  const transport = fakeTransport(async () => ({ status: 500, json: async () => ({}) }));
  await assert.doesNotReject(() =>
    stampCreatedIssueUrl({
      eveSessionId: "eve-session-1",
      toolInput: { title: "x" },
      url: "https://github.com/a/b/issues/1",
      env: STAMP_ENV,
      transport,
    }),
  );
  assert.equal(transport.calls.length, 1);
});

test("stampCreatedIssueUrl: the STAMP call itself returns a non-2xx (e.g. 409 conflict) -> never throws", async () => {
  const transport = fakeTransport(APPROVED_RELEARN_RESPONDER, async () => ({
    status: 409,
    json: async () => ({ error: "conflict" }),
  }));
  await assert.doesNotReject(() =>
    stampCreatedIssueUrl({
      eveSessionId: "eve-session-1",
      toolInput: { title: "x" },
      url: "https://github.com/a/b/issues/1",
      env: STAMP_ENV,
      transport,
    }),
  );
  assert.equal(transport.calls.length, 2);
});

test("stampCreatedIssueUrl: relearn POST 200 with a malformed body (no approvalId) -> never throws, the stamp call is never attempted", async () => {
  const transport = fakeTransport(async () => ({
    status: 200,
    json: async () => ({ status: "approved" }),
  }));
  await assert.doesNotReject(() =>
    stampCreatedIssueUrl({
      eveSessionId: "eve-session-1",
      toolInput: { title: "x" },
      url: "https://github.com/a/b/issues/1",
      env: STAMP_ENV,
      transport,
    }),
  );
  assert.equal(transport.calls.length, 1);
});

test("stampCreatedIssueUrl: skips entirely (transport never called at all) when eveSessionId is missing", async () => {
  const transport = fakeTransport();
  await stampCreatedIssueUrl({
    toolInput: { title: "x" },
    url: "https://github.com/a/b/issues/1",
    env: STAMP_ENV,
    transport,
  });
  assert.equal(transport.calls.length, 0);
});

test("stampCreatedIssueUrl: skips entirely when the console config is missing (JACE_CONSOLE_BASE_URL/TOKEN unset)", async () => {
  const transport = fakeTransport();
  await stampCreatedIssueUrl({
    eveSessionId: "eve-session-1",
    toolInput: { title: "x" },
    url: "https://github.com/a/b/issues/1",
    env: {},
    transport,
  });
  assert.equal(transport.calls.length, 0);
});

test("runCreateIssue: successful creation + successful stamp -> returns the parsed ref, unaffected by the stamp", async () => {
  const transport = fakeTransport(APPROVED_RELEARN_RESPONDER, OK_STAMP_RESPONDER);
  const ref = await runCreateIssue({
    execFileFn: fakeExecSuccess(),
    env: STAMP_ENV,
    title: "Add a health endpoint",
    acceptanceCriteria: ["GET /health returns 200"],
    eveSessionId: "eve-session-1",
    turnId: "turn-1",
    toolInput: {
      title: "Add a health endpoint",
      acceptanceCriteria: ["GET /health returns 200"],
    },
    stampTransport: transport,
  });
  assert.deepEqual(ref, {
    repo: "Bensigo/agentrail",
    number: 1042,
    label: "ready-for-agent",
    url: "https://github.com/Bensigo/agentrail/issues/1042",
  });
  assert.equal(transport.calls.length, 2);
});

test("runCreateIssue: the stamp transport TIMES OUT (throws) -> the tool result is still returned intact, no throw", async () => {
  const timingOutTransport = async () => {
    throw new Error("ETIMEDOUT");
  };
  const ref = await runCreateIssue({
    execFileFn: fakeExecSuccess(),
    env: STAMP_ENV,
    title: "Add a health endpoint",
    acceptanceCriteria: ["GET /health returns 200"],
    eveSessionId: "eve-session-1",
    toolInput: { title: "x" },
    stampTransport: timingOutTransport,
  });
  assert.deepEqual(ref, {
    repo: "Bensigo/agentrail",
    number: 1042,
    label: "ready-for-agent",
    url: "https://github.com/Bensigo/agentrail/issues/1042",
  });
});

test("runCreateIssue: the stamp gets a non-2xx from the console -> the tool result is still returned intact", async () => {
  const transport = fakeTransport(APPROVED_RELEARN_RESPONDER, async () => ({
    status: 409,
    json: async () => ({ error: "conflict" }),
  }));
  const ref = await runCreateIssue({
    execFileFn: fakeExecSuccess(),
    env: STAMP_ENV,
    title: "Add a health endpoint",
    acceptanceCriteria: ["GET /health returns 200"],
    eveSessionId: "eve-session-1",
    toolInput: { title: "x" },
    stampTransport: transport,
  });
  assert.equal(ref.number, 1042);
});

test("runCreateIssue: no eveSessionId at all (e.g. ctx was absent/malformed) -> the stamp is skipped, the tool result is still returned intact", async () => {
  const transport = fakeTransport();
  const ref = await runCreateIssue({
    execFileFn: fakeExecSuccess(),
    env: STAMP_ENV,
    title: "Add a health endpoint",
    acceptanceCriteria: ["GET /health returns 200"],
    stampTransport: transport,
  });
  assert.equal(ref.number, 1042);
  assert.equal(transport.calls.length, 0);
});

test("runCreateIssue: stamps the CANONICAL url reconstructed from repo+number, not the CLI's own raw printed url substring", async () => {
  // Guards the #1274 PR② URL-normalization tighten: enqueueGithubIssue's
  // confirmed-brief lookup is an EXACT STRING match, so the stamped value
  // must always be built the SAME way githubIssueUrl() builds it
  // server-side — never trusted verbatim off the CLI's own stdout, which
  // could differ in host case / trailing slash / etc.
  const transport = fakeTransport(APPROVED_RELEARN_RESPONDER, OK_STAMP_RESPONDER);
  const weirdCasingStdout =
    "Created owner/repo#7 (label ready-for-agent): https://GITHUB.com/owner/repo/issues/7/\n";
  await runCreateIssue({
    execFileFn: async () => ({ stdout: weirdCasingStdout, stderr: "" }),
    env: STAMP_ENV,
    title: "t",
    acceptanceCriteria: ["ac"],
    eveSessionId: "eve-session-1",
    toolInput: { title: "t" },
    stampTransport: transport,
  });
  const stampBody = JSON.parse(transport.calls[1].init.body);
  assert.equal(stampBody.url, "https://github.com/owner/repo/issues/7");
});
