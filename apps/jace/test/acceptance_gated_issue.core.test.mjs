import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAcceptanceGatedIssueArgv,
  isExactAcceptanceGatedIssueInput,
  parseAcceptanceGatedIssueReceipt,
  runAcceptanceGatedIssue,
  runCreateIssueApproval,
} from "../agent/lib/acceptance_gated_issue.core.mjs";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const RECORD_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const CYCLE_ID = "44444444-4444-4444-8444-444444444444";
const BINDING_ID = "55555555-5555-4555-8555-555555555555";
const APPROVAL_ID = "66666666-6666-4666-8666-666666666666";
const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.test",
  JACE_CONSOLE_TOKEN: "console-secret",
};
const TITLE = "Correct failed Acceptance Record criteria";
const BODY = "## Correction packet\n\nThe server rendered this exact body.";
const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function request(status = "draft") {
  return {
    id: REQUEST_ID,
    status,
    workspaceId: WORKSPACE_ID,
    recordId: RECORD_ID,
    repo: "Acme/Widgets",
    repoNormalized: "acme/widgets",
    prNumber: 41,
    headSha: "a".repeat(40),
    headCycleId: CYCLE_ID,
    authorityGeneration: 3,
    bindingId: BINDING_ID,
    acceptanceContract: {
      id: "77777777-7777-4777-8777-777777777777",
      version: 2,
      sha256: "b".repeat(64),
    },
    criterionOutcomeBundle: {
      id: "88888888-8888-4888-8888-888888888888",
      eventId: "99999999-9999-4999-8999-999999999999",
      sha256: "c".repeat(64),
      postedAttestationEventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
    packets: [
      { packetId: "ac-1", sha256: "d".repeat(64) },
      { packetId: "ac-2", sha256: "e".repeat(64) },
    ],
    packetSetSha256: "f".repeat(64),
    correctionPacketPayloadSetSha256: "1".repeat(64),
    requestIdentitySha256: "2".repeat(64),
    title: TITLE,
    titleSha256: sha(TITLE),
    body: BODY,
    bodySha256: sha(BODY),
  };
}

function receipt(repo = "acme/widgets") {
  return {
    kind: "github_201",
    httpStatus: 201,
    githubIssueId: "9001",
    githubIssueNumber: 73,
    githubApiUrl: `https://api.github.com/repos/${repo}/issues/73`,
    githubIssueUrl: `https://github.com/${repo}/issues/73`,
    githubRequestId: "ABC1:1234",
    responseTitleSha256: sha(TITLE),
    responseBodySha256: sha(BODY),
    state: "open",
  };
}

function response(status, body) {
  return { status, json: async () => body };
}

function custodyTransport({ reserveStatus = 201, publishStatus = 201 } = {}) {
  const calls = [];
  const transport = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith("/api/v1/runner/acceptance-gated-github-issue-requests")) {
      return response(201, { kind: "ready", request: { id: REQUEST_ID, status: "draft" } });
    }
    if (url.endsWith(`/${REQUEST_ID}`)) {
      return response(200, { kind: "ready", request: request("draft") });
    }
    if (url.endsWith("/api/v1/runner/approvals")) {
      return response(200, { approvalId: APPROVAL_ID, status: "approved" });
    }
    if (url.endsWith(`/${REQUEST_ID}/reserve`)) {
      return response(reserveStatus, reserveStatus === 201
        ? { kind: "reserved", request: request("reserved") }
        : { kind: "already_reserved" });
    }
    if (url.endsWith(`/${REQUEST_ID}/published`)) {
      return response(publishStatus, publishStatus === 201
        ? { kind: "published", issue: { status: "published" } }
        : { kind: "conflict" });
    }
    if (url.endsWith(`/${REQUEST_ID}/reconciliation`)) {
      return response(201, { kind: "recorded" });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  transport.calls = calls;
  return transport;
}

test("correction input is exactly one Acceptance recordId", () => {
  assert.equal(isExactAcceptanceGatedIssueInput({ recordId: RECORD_ID }), true);
  assert.equal(isExactAcceptanceGatedIssueInput({ recordId: RECORD_ID, title: "model draft" }), false);
  assert.equal(isExactAcceptanceGatedIssueInput({ title: "ordinary" }), false);
});

test("ordinary create_issue approval remains byte-compatible pass-through", async () => {
  const ctx = { toolInput: { title: "Ordinary", acceptanceCriteria: ["AC1"] } };
  let approvedContext;
  const result = await runCreateIssueApproval({
    ctx,
    env: ENV,
    transport: async () => { throw new Error("ordinary mode must not mint"); },
    approve: async (value) => {
      approvedContext = value;
      return { type: "approved", reason: "test" };
    },
  });
  assert.deepEqual(result, { type: "approved", reason: "test" });
  assert.equal(approvedContext, ctx);
});

test("correction approval mints first and gives the approval seam only the opaque request id", async () => {
  const calls = [];
  let approvalContext;
  const result = await runCreateIssueApproval({
    ctx: {
      toolInput: { recordId: RECORD_ID },
      session: { id: "eve-session-1", turn: { id: "turn-1" } },
      toolName: "create_issue",
    },
    env: ENV,
    transport: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return response(201, { kind: "ready", request: { id: REQUEST_ID, status: "draft" } });
    },
    approve: async (ctx) => {
      approvalContext = ctx;
      return { type: "approved", reason: "test" };
    },
  });
  assert.equal(result.type, "approved");
  assert.deepEqual(calls[0].body, { eveSessionId: "eve-session-1", recordId: RECORD_ID });
  assert.deepEqual(approvalContext.toolInput, { acceptanceGatedIssueRequestId: REQUEST_ID });
  assert.equal("recordId" in approvalContext.toolInput, false);
  assert.equal("title" in approvalContext.toolInput, false);
  assert.equal("repo" in approvalContext.toolInput, false);
});

test("reserved correction uses only the server draft, writes once without a label, then attests", async () => {
  const transport = custodyTransport();
  const execCalls = [];
  const result = await runAcceptanceGatedIssue({
    env: ENV,
    recordId: RECORD_ID,
    eveSessionId: "eve-session-1",
    turnId: "turn-1",
    transport,
    execFileFn: async (bin, argv) => {
      execCalls.push({ bin, argv });
      return { stdout: `AGENTRAIL_GATED_ISSUE_RECEIPT ${JSON.stringify(receipt())}\n` };
    },
  });
  assert.equal(execCalls.length, 1);
  assert.deepEqual(execCalls[0], {
    bin: "agentrail",
    argv: buildAcceptanceGatedIssueArgv({ repo: "acme/widgets", title: TITLE, body: BODY }),
  });
  assert.ok(execCalls[0].argv.includes("--unlabeled"));
  assert.ok(!execCalls[0].argv.includes("ready-for-agent"));
  const approval = transport.calls.find((call) => call.url.endsWith("/approvals"));
  assert.deepEqual(approval.body.toolInput, { acceptanceGatedIssueRequestId: REQUEST_ID });
  const reserveIndex = transport.calls.findIndex((call) => call.url.endsWith("/reserve"));
  const publishIndex = transport.calls.findIndex((call) => call.url.endsWith("/published"));
  assert.ok(reserveIndex >= 0 && publishIndex > reserveIndex);
  assert.deepEqual(result, {
    repo: "acme/widgets",
    number: 73,
    url: "https://github.com/acme/widgets/issues/73",
    requestId: REQUEST_ID,
    approvalId: APPROVAL_ID,
    attested: true,
  });
});

test("no CLI runs when durable reservation is already held", async () => {
  const transport = custodyTransport({ reserveStatus: 409 });
  let cliCalls = 0;
  const result = await runAcceptanceGatedIssue({
    env: ENV,
    recordId: RECORD_ID,
    eveSessionId: "eve-session-1",
    turnId: "turn-1",
    transport,
    execFileFn: async () => { cliCalls += 1; },
  });
  assert.equal(cliCalls, 0);
  assert.equal(result.blocked, true);
});

test("an indeterminate CLI result is durably reconciled and cannot report success", async () => {
  const transport = custodyTransport();
  const result = await runAcceptanceGatedIssue({
    env: ENV,
    recordId: RECORD_ID,
    eveSessionId: "eve-session-1",
    turnId: "turn-1",
    transport,
    execFileFn: async () => { throw new Error("connection ended after POST"); },
  });
  assert.equal(result.blocked, true);
  assert.equal(result.unattested, true);
  assert.equal(result.state, "manual_reconciliation");
  assert.equal(result.reason, "external_write_indeterminate");
  const reconciliation = transport.calls.find((call) => call.url.endsWith("/reconciliation"));
  assert.equal(reconciliation.body.reason, "external_write_indeterminate");
  assert.equal(transport.calls.some((call) => call.url.endsWith("/published")), false);
});

test("wrong-repository receipt is refused and placed in manual reconciliation", async () => {
  const transport = custodyTransport();
  const result = await runAcceptanceGatedIssue({
    env: ENV,
    recordId: RECORD_ID,
    eveSessionId: "eve-session-1",
    turnId: "turn-1",
    transport,
    execFileFn: async () => ({
      stdout: `AGENTRAIL_GATED_ISSUE_RECEIPT ${JSON.stringify(receipt("other/repo"))}\n`,
    }),
  });
  assert.equal(result.reason, "external_issue_wrong_repo");
  const reconciliation = transport.calls.find((call) => call.url.endsWith("/reconciliation"));
  assert.equal(reconciliation.body.observedIssueUrl, "https://github.com/other/repo/issues/73");
  assert.equal(transport.calls.some((call) => call.url.endsWith("/published")), false);
});

test("receipt parser binds response title/body digests and canonical issue URL", () => {
  const parsed = parseAcceptanceGatedIssueReceipt(
    `noise\nAGENTRAIL_GATED_ISSUE_RECEIPT ${JSON.stringify(receipt("Acme/Widgets"))}\n`,
    request("reserved"),
  );
  assert.equal(parsed.canonical.repo, "acme/widgets");
  assert.equal(parsed.canonical.url, "https://github.com/acme/widgets/issues/73");
  assert.equal(parseAcceptanceGatedIssueReceipt(
    `AGENTRAIL_GATED_ISSUE_RECEIPT ${JSON.stringify({
      ...receipt(), responseBodySha256: "0".repeat(64),
    })}`,
    request("reserved"),
  ), null);
});
