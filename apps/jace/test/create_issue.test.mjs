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
  resolveStampUrl,
  extractGoalSlug,
  checkGoalFileLeash,
  recordGoalIssueFiled,
  buildGoalFileCheckUrl,
  buildGoalFileRecordedUrl,
  GOAL_CHECK_INFRA_FAILURE_MESSAGE,
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

// --- fix round M1: prefer GitHub's canonical html_url over the input-cased
// reconstruction ------------------------------------------------------------

test("resolveStampUrl prefers ref.url (GitHub's canonical html_url) over the repo+number reconstruction", () => {
  // The CLI's printed line carries the INPUT repo casing in the `owner/repo#N`
  // token but GitHub's own canonical casing in the URL (html_url) — the url
  // must win, or a mis-cased configured repo silently never matches the
  // webhook side's exact-string lookup (redundant second confirm forever).
  const url = resolveStampUrl({
    repo: "bensigo/AGENTRAIL", // input casing, as the connector echoes it
    number: 7,
    url: "https://github.com/Bensigo/agentrail/issues/7", // GitHub's canonical html_url
  });
  assert.equal(url, "https://github.com/Bensigo/agentrail/issues/7");
});

test("resolveStampUrl falls back to the repo+number reconstruction ONLY when ref.url is absent or empty", () => {
  assert.equal(
    resolveStampUrl({ repo: "owner/repo", number: 7 }),
    "https://github.com/owner/repo/issues/7",
  );
  assert.equal(
    resolveStampUrl({ repo: "owner/repo", number: 7, url: "" }),
    "https://github.com/owner/repo/issues/7",
  );
});

test("runCreateIssue: stamps ref.url VERBATIM (the canonical html_url), not a reconstruction from the input-cased repo token", async () => {
  const transport = fakeTransport(APPROVED_RELEARN_RESPONDER, OK_STAMP_RESPONDER);
  // repo token mis-cased (input casing), URL canonical — the real M1 shape.
  const misCasedRepoStdout =
    "Created bensigo/AGENTRAIL#7 (label ready-for-agent): https://github.com/Bensigo/agentrail/issues/7\n";
  await runCreateIssue({
    execFileFn: async () => ({ stdout: misCasedRepoStdout, stderr: "" }),
    env: STAMP_ENV,
    title: "t",
    acceptanceCriteria: ["ac"],
    eveSessionId: "eve-session-1",
    toolInput: { title: "t" },
    stampTransport: transport,
  });
  const stampBody = JSON.parse(transport.calls[1].init.body);
  assert.equal(stampBody.url, "https://github.com/Bensigo/agentrail/issues/7");
});

test("runCreateIssue: an off-shape ref.url is passed through verbatim — the /published endpoint's regex guard is what refuses it (fail-safe: redundant confirm)", async () => {
  const transport = fakeTransport(APPROVED_RELEARN_RESPONDER, async () => ({
    status: 400, // what the endpoint's GITHUB_ISSUE_URL_RE guard would return
    json: async () => ({ error: "url must be a canonical GitHub issue URL" }),
  }));
  const weirdStdout =
    "Created owner/repo#7 (label ready-for-agent): https://GITHUB.com/owner/repo/issues/7/\n";
  const ref = await runCreateIssue({
    execFileFn: async () => ({ stdout: weirdStdout, stderr: "" }),
    env: STAMP_ENV,
    title: "t",
    acceptanceCriteria: ["ac"],
    eveSessionId: "eve-session-1",
    toolInput: { title: "t" },
    stampTransport: transport,
  });
  // The raw value went out (server-side guard owns the shape decision) and
  // the refused stamp never affected the tool result.
  const stampBody = JSON.parse(transport.calls[1].init.body);
  assert.equal(stampBody.url, "https://GITHUB.com/owner/repo/issues/7/");
  assert.equal(ref.number, 7);
});

// --- fix round M2: the relearn replay's status gates the stamp -------------

test("stampCreatedIssueUrl: relearn replay reports status 'pending' (a ghost/fresh row, no human approval) -> the stamp call is never attempted", async () => {
  const transport = fakeTransport(async () => ({
    status: 201, // created:true shape — a FRESH row, exactly the ghost case
    json: async () => ({ approvalId: "ghost-approval", status: "pending" }),
  }));
  await stampCreatedIssueUrl({
    eveSessionId: "eve-session-1",
    toolInput: { title: "x" },
    url: "https://github.com/a/b/issues/1",
    env: STAMP_ENV,
    transport,
  });
  assert.equal(transport.calls.length, 1, "only the relearn POST — never the stamp");
});

test("stampCreatedIssueUrl: relearn replay reports status 'denied' or a missing status -> the stamp call is never attempted", async () => {
  for (const body of [
    { approvalId: "approval-1", status: "denied" },
    { approvalId: "approval-1" }, // status absent entirely
  ]) {
    const transport = fakeTransport(async () => ({ status: 200, json: async () => body }));
    await stampCreatedIssueUrl({
      eveSessionId: "eve-session-1",
      toolInput: { title: "x" },
      url: "https://github.com/a/b/issues/1",
      env: STAMP_ENV,
      transport,
    });
    assert.equal(transport.calls.length, 1, `no stamp for replay body ${JSON.stringify(body)}`);
  }
});

// ---------------------------------------------------------------------------
// #1289 (Jace goal loop) — adversarial-review fix: the maxIssues leash was
// schema-complete but INERT at runtime because nothing in production ever
// called recordIssueFiled. These tests drive the REAL production filing
// path (runCreateIssue itself, with its actual pre-file check / post-file
// record wiring) — never a manual recordIssueFiled call — and prove the
// leash actually bites.
// ---------------------------------------------------------------------------

test("extractGoalSlug recovers the slug from a goal-stamped body", () => {
  assert.equal(
    extractGoalSlug("## Required context\nGoal: reach 80% coverage (goal:reach-80-coverage)\n"),
    "reach-80-coverage",
  );
});

test("extractGoalSlug finds the stamp regardless of which field it landed in (title vs body)", () => {
  assert.equal(extractGoalSlug("Follow-up (goal:ship-2-prs)"), "ship-2-prs");
});

test("extractGoalSlug returns null for a normal, non-goal issue (the overwhelmingly common case)", () => {
  assert.equal(extractGoalSlug("## Required context\nJust a normal issue, no goal here.\n"), null);
  assert.equal(extractGoalSlug(""), null);
  assert.equal(extractGoalSlug(undefined), null);
});

test("buildGoalFileCheckUrl / buildGoalFileRecordedUrl join the base url and the expected paths", () => {
  assert.equal(
    buildGoalFileCheckUrl("https://console.example.com"),
    "https://console.example.com/api/v1/runner/goals/file-check",
  );
  assert.equal(
    buildGoalFileRecordedUrl("https://console.example.com"),
    "https://console.example.com/api/v1/runner/goals/file-recorded",
  );
});

test("checkGoalFileLeash: config unset -> fails CLOSED (allow:false), never a silent allow", async () => {
  const result = await checkGoalFileLeash({
    eveSessionId: "eve-1",
    slug: "reach-80-coverage",
    env: {},
    transport: async () => ({ status: 200, json: async () => ({ allow: true }) }),
  });
  assert.deepEqual(result, { allow: false, reason: GOAL_CHECK_INFRA_FAILURE_MESSAGE });
});

test("checkGoalFileLeash: transport throws -> fails CLOSED", async () => {
  const result = await checkGoalFileLeash({
    eveSessionId: "eve-1",
    slug: "reach-80-coverage",
    env: STAMP_ENV,
    transport: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.deepEqual(result, { allow: false, reason: GOAL_CHECK_INFRA_FAILURE_MESSAGE });
});

test("checkGoalFileLeash: non-2xx -> fails CLOSED", async () => {
  const result = await checkGoalFileLeash({
    eveSessionId: "eve-1",
    slug: "reach-80-coverage",
    env: STAMP_ENV,
    transport: async () => ({ status: 500, json: async () => ({}) }),
  });
  assert.deepEqual(result, { allow: false, reason: GOAL_CHECK_INFRA_FAILURE_MESSAGE });
});

test("checkGoalFileLeash: malformed body (missing allow) -> fails CLOSED", async () => {
  const result = await checkGoalFileLeash({
    eveSessionId: "eve-1",
    slug: "reach-80-coverage",
    env: STAMP_ENV,
    transport: async () => ({ status: 200, json: async () => ({}) }),
  });
  assert.deepEqual(result, { allow: false, reason: GOAL_CHECK_INFRA_FAILURE_MESSAGE });
});

test("checkGoalFileLeash: an honest allow:false from the console (leash exhausted) passes the goalId + reason straight through", async () => {
  const result = await checkGoalFileLeash({
    eveSessionId: "eve-1",
    slug: "reach-80-coverage",
    env: STAMP_ENV,
    transport: async () => ({
      status: 200,
      json: async () => ({ allow: false, goalId: "goal-1", reason: "leash exhausted: issues filed 10/10" }),
    }),
  });
  assert.deepEqual(result, { allow: false, goalId: "goal-1", reason: "leash exhausted: issues filed 10/10" });
});

test("checkGoalFileLeash: allow:true passes the goalId through", async () => {
  const result = await checkGoalFileLeash({
    eveSessionId: "eve-1",
    slug: "reach-80-coverage",
    env: STAMP_ENV,
    transport: async () => ({ status: 200, json: async () => ({ allow: true, goalId: "goal-1" }) }),
  });
  assert.deepEqual(result, { allow: true, goalId: "goal-1" });
});

test("recordGoalIssueFiled: posts goalId + issueExternalId, never throws on failure (best-effort, mirrors stampCreatedIssueUrl)", async () => {
  const transport = fakeTransport(async () => ({ status: 200, json: async () => ({ ok: true }) }));
  await recordGoalIssueFiled({
    goalId: "goal-1",
    issueExternalId: "42",
    env: STAMP_ENV,
    transport,
  });
  assert.equal(transport.calls.length, 1);
  const sent = JSON.parse(transport.calls[0].init.body);
  assert.deepEqual(sent, { goalId: "goal-1", issueExternalId: "42" });
});

test("recordGoalIssueFiled: transport throws -> never throws past the caller", async () => {
  await assert.doesNotReject(
    recordGoalIssueFiled({
      goalId: "goal-1",
      issueExternalId: "42",
      env: STAMP_ENV,
      transport: async () => {
        throw new Error("ETIMEDOUT");
      },
    }),
  );
});

test("runCreateIssue: a normal, non-goal issue never touches the goal-check/goal-record transports at all", async () => {
  let checkCalled = false;
  let recordCalled = false;
  const ref = await runCreateIssue({
    execFileFn: fakeExecSuccess(),
    env: STAMP_ENV,
    title: "Add a health endpoint",
    acceptanceCriteria: ["GET /health returns 200"],
    goalCheckTransport: async () => {
      checkCalled = true;
      return { status: 200, json: async () => ({ allow: true }) };
    },
    goalRecordTransport: async () => {
      recordCalled = true;
      return { status: 200, json: async () => ({ ok: true }) };
    },
  });
  assert.equal(ref.number, 1042);
  assert.equal(checkCalled, false, "no goal stamp -> the pre-file check must never fire");
  assert.equal(recordCalled, false, "no goal stamp -> the post-file record must never fire");
});

test("runCreateIssue: a goal-stamped issue that the console ALLOWS is filed AND recorded via recordGoalIssueFiled — the wiring the adversarial review found missing", async () => {
  const checkTransport = fakeTransport(
    async (url, init) => {
      const sent = JSON.parse(init.body);
      assert.equal(sent.slug, "reach-80-coverage");
      return { status: 200, json: async () => ({ allow: true, goalId: "goal-1" }) };
    },
  );
  const recordTransport = fakeTransport(async () => ({ status: 200, json: async () => ({ ok: true }) }));

  const ref = await runCreateIssue({
    execFileFn: fakeExecSuccess(),
    env: STAMP_ENV,
    title: "File the next issue toward the coverage goal",
    requiredContext: "Goal: reach 80% coverage (goal:reach-80-coverage)",
    acceptanceCriteria: ["raise coverage in module X"],
    eveSessionId: "eve-session-1",
    stampTransport: fakeTransport(APPROVED_RELEARN_RESPONDER, OK_STAMP_RESPONDER),
    goalCheckTransport: checkTransport,
    goalRecordTransport: recordTransport,
  });

  assert.equal(ref.number, 1042, "the issue is actually filed when the check allows it");
  assert.equal(checkTransport.calls.length, 1, "the pre-file check runs exactly once");
  assert.equal(recordTransport.calls.length, 1, "the post-file record runs exactly once — THIS is the call production was missing");
  const recorded = JSON.parse(recordTransport.calls[0].init.body);
  assert.deepEqual(recorded, { goalId: "goal-1", issueExternalId: "1042" });
});

test("runCreateIssue: a goal-stamped issue the console BLOCKS (leash exhausted) is REFUSED before the CLI ever runs — no GitHub issue is created", async () => {
  let cliCalled = false;
  const guardedExec = async () => {
    cliCalled = true;
    throw new Error("must never be called once the leash is exhausted");
  };
  const checkTransport = fakeTransport(async () => ({
    status: 200,
    json: async () => ({ allow: false, goalId: "goal-1", reason: "leash exhausted: issues filed 10/10" }),
  }));
  const recordTransport = fakeTransport(async () => ({ status: 200, json: async () => ({ ok: true }) }));

  const result = await runCreateIssue({
    execFileFn: guardedExec,
    env: STAMP_ENV,
    title: "One too many",
    requiredContext: "Goal: reach 80% coverage (goal:reach-80-coverage)",
    acceptanceCriteria: ["make progress"],
    eveSessionId: "eve-session-1",
    stampTransport: fakeTransport(APPROVED_RELEARN_RESPONDER, OK_STAMP_RESPONDER),
    goalCheckTransport: checkTransport,
    goalRecordTransport: recordTransport,
  });

  assert.deepEqual(result, { blocked: true, message: "leash exhausted: issues filed 10/10" });
  assert.equal(cliCalled, false, "the CLI must never be invoked — the whole point of the pre-file gate");
  assert.equal(recordTransport.calls.length, 0, "nothing was filed, so nothing is recorded");
});

test("runCreateIssue: the goal-check itself is unreachable (infra failure) -> fails CLOSED, never files, never a silent allow", async () => {
  let cliCalled = false;
  const guardedExec = async () => {
    cliCalled = true;
    return { stdout: SUCCESS_STDOUT, stderr: "" };
  };
  const failingCheckTransport = async () => {
    throw new Error("ECONNREFUSED");
  };

  const result = await runCreateIssue({
    execFileFn: guardedExec,
    env: STAMP_ENV,
    title: "Follow-up",
    requiredContext: "Goal: reach 80% coverage (goal:reach-80-coverage)",
    acceptanceCriteria: ["make progress"],
    eveSessionId: "eve-session-1",
    stampTransport: fakeTransport(APPROVED_RELEARN_RESPONDER, OK_STAMP_RESPONDER),
    goalCheckTransport: failingCheckTransport,
  });

  assert.deepEqual(result, { blocked: true, message: GOAL_CHECK_INFRA_FAILURE_MESSAGE });
  assert.equal(cliCalled, false, "a leash check we cannot trust must never be treated as 'leash has room'");
});

test("runCreateIssue: the post-file record transport fails -> the tool result is STILL returned intact (best-effort, mirrors the stamp's own tolerance)", async () => {
  const ref = await runCreateIssue({
    execFileFn: fakeExecSuccess(),
    env: STAMP_ENV,
    title: "Follow-up",
    requiredContext: "Goal: reach 80% coverage (goal:reach-80-coverage)",
    acceptanceCriteria: ["make progress"],
    eveSessionId: "eve-session-1",
    stampTransport: fakeTransport(APPROVED_RELEARN_RESPONDER, OK_STAMP_RESPONDER),
    goalCheckTransport: async () => ({ status: 200, json: async () => ({ allow: true, goalId: "goal-1" }) }),
    goalRecordTransport: async () => {
      throw new Error("ETIMEDOUT");
    },
  });
  assert.equal(ref.number, 1042);
});

test("runCreateIssue: driving the REAL production filing path across multiple calls reaches maxIssues and blocks the next file — never a manual recordIssueFiled call, only the check/record transports the wiring itself invokes", async () => {
  const MAX_ISSUES = 3;
  // An in-memory stand-in for the goal row packages/db-postgres actually
  // owns. This test does not re-implement or re-verify the leash MATH
  // (that is goal_rules.test.ts's job, exhaustively, at the db-postgres
  // layer) — it proves the WIRING: that runCreateIssue's pre-file check and
  // post-file record are the ONLY things that ever move this counter, via
  // exactly the HTTP calls production makes.
  const fakeGoal = { id: "goal-1", issuesFiled: 0, maxIssues: MAX_ISSUES, status: "active" };

  const checkTransport = async (_url, init) => {
    const sent = JSON.parse(init.body);
    assert.equal(sent.slug, "reach-80-coverage");
    if (fakeGoal.status !== "active" || fakeGoal.issuesFiled >= fakeGoal.maxIssues) {
      return {
        status: 200,
        json: async () => ({
          allow: false,
          goalId: fakeGoal.id,
          reason: `leash exhausted: issues filed ${fakeGoal.issuesFiled}/${fakeGoal.maxIssues}`,
        }),
      };
    }
    return { status: 200, json: async () => ({ allow: true, goalId: fakeGoal.id }) };
  };
  const recordTransport = async (_url, init) => {
    const sent = JSON.parse(init.body);
    assert.equal(sent.goalId, fakeGoal.id);
    fakeGoal.issuesFiled += 1; // the ONE mutation recordIssueFiled performs in production
    if (fakeGoal.issuesFiled >= fakeGoal.maxIssues) fakeGoal.status = "leashed";
    return { status: 200, json: async () => ({ ok: true }) };
  };

  let issueNumber = 1000;
  const fakeExec = async () => {
    issueNumber += 1;
    return {
      stdout:
        `Created Bensigo/agentrail#${issueNumber} (label ready-for-agent): ` +
        `https://github.com/Bensigo/agentrail/issues/${issueNumber}\n`,
      stderr: "",
    };
  };

  for (let i = 0; i < MAX_ISSUES; i++) {
    const ref = await runCreateIssue({
      execFileFn: fakeExec,
      env: STAMP_ENV,
      title: `Follow-up ${i + 1}`,
      requiredContext: "Goal: reach 80% coverage (goal:reach-80-coverage)",
      acceptanceCriteria: ["make progress"],
      eveSessionId: "eve-session-1",
      stampTransport: fakeTransport(APPROVED_RELEARN_RESPONDER, OK_STAMP_RESPONDER),
      goalCheckTransport: checkTransport,
      goalRecordTransport: recordTransport,
    });
    assert.ok(ref.number, `issue ${i + 1} of ${MAX_ISSUES} should have been filed`);
  }

  assert.equal(
    fakeGoal.issuesFiled,
    MAX_ISSUES,
    "issuesFiled actually incremented via the REAL production path — not a manually-invoked recordIssueFiled",
  );
  assert.equal(fakeGoal.status, "leashed", "the goal transitioned to leashed at maxIssues through that real path");

  // The (maxIssues+1)-th goal-stamped attempt must be refused BEFORE the CLI.
  let cliCalledAgain = false;
  const guardedExec = async () => {
    cliCalledAgain = true;
    throw new Error("must never be called — the leash is exhausted");
  };
  const result = await runCreateIssue({
    execFileFn: guardedExec,
    env: STAMP_ENV,
    title: "One too many",
    requiredContext: "Goal: reach 80% coverage (goal:reach-80-coverage)",
    acceptanceCriteria: ["make progress"],
    eveSessionId: "eve-session-1",
    stampTransport: fakeTransport(APPROVED_RELEARN_RESPONDER, OK_STAMP_RESPONDER),
    goalCheckTransport: checkTransport,
    goalRecordTransport: recordTransport,
  });
  assert.equal(result.blocked, true);
  assert.equal(cliCalledAgain, false, "the CLI must never be invoked once the leash is exhausted");
  assert.equal(fakeGoal.issuesFiled, MAX_ISSUES, "a blocked attempt must never increment the counter further");
});
