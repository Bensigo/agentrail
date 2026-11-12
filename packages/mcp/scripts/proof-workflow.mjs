/** Local integrated protocol proof. Never run against a production database. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import {
  mkdir,
  writeFile,
  readFile,
  mkdtemp,
  chmod,
  rename,
  rm,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const requireDb = createRequire(
  new URL("../../db-postgres/package.json", import.meta.url),
);
const postgres = requireDb("postgres");
const base = process.env.PROOF_BASE_URL || "http://127.0.0.1:3310";
const database = process.env.DATABASE_URL;
assert(
  database &&
    new URL(database).hostname === "127.0.0.1" &&
    /_(proof|split)$/.test(new URL(database).pathname),
  "Dedicated local proof database required",
);
assert.equal(new URL(base).hostname, "127.0.0.1");
const sql = postgres(database, { max: 4 });
const workspaceId = randomUUID(),
  foreignWorkspaceId = randomUUID(),
  repositoryId = randomUUID();
const ownerId = randomUUID(),
  token = randomBytes(32).toString("hex"),
  key = `ar_${randomBytes(32).toString("hex")}`;
const foreignKey = `ar_${randomBytes(32).toString("hex")}`,
  otherKey = `ar_${randomBytes(32).toString("hex")}`;
const keyHash = (value) => createHash("sha256").update(value).digest("hex");
const fixture = await mkdtemp(resolve(tmpdir(), "agentrail-workflow-proof-"));
const target = resolve(fixture, "project");
const releaseCheckout = resolve(fixture, "release");
const bin = resolve(fixture, "bin");
await mkdir(target);
await mkdir(bin);
let deployedCommit = "0".repeat(40);
let smokePasses = true;
let observations = 0;
const preview = createServer((req, res) => {
  observations++;
  res.setHeader("content-type", "application/json");
  if (req.url === "/version")
    return res.end(JSON.stringify({ commitSha: deployedCommit }));
  res.statusCode = smokePasses ? 200 : 503;
  res.end(JSON.stringify({ playerCanJoin: smokePasses }));
});
const git = (...args) =>
  execFileSync("git", ["-C", target, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
git("init", "-b", "proof/workflow");
git("config", "user.name", "AgentRail proof");
git("config", "user.email", "proof@example.invalid");
git("remote", "add", "origin", "https://github.com/Bensigo/agentrail.git");
await mkdir(resolve(target, ".agentrail"));
await writeFile(resolve(target, "sample.js"), "export const value = 42;\n");
await writeFile(
  resolve(target, ".agentrail/config.json"),
  JSON.stringify({
    workflow: {
      release: { verify: [process.execPath, "verify-release.mjs"] },
      checks: {
        syntax: [process.execPath, "--check", "sample.js"],
        once: [
          process.execPath,
          "-e",
          "require('fs').appendFileSync('executions','1')",
        ],
        slow: [process.execPath, "-e", "setTimeout(()=>process.exit(1),1500)"],
        gitFailure: [
          process.execPath,
          "-e",
          "require('fs').renameSync('.git','.git-held')",
        ],
      },
    },
  }),
);
await writeFile(
  resolve(target, "verify-release.mjs"),
  `
const url = process.env.PROOF_PREVIEW;
const version = await fetch(new URL("/version", url));
const behavior = await fetch(new URL("/join", url));
if (!version.ok || !behavior.ok || !(await behavior.json()).playerCanJoin) process.exit(1);
console.log(JSON.stringify({ url, commitSha: (await version.json()).commitSha }));
`,
);
git("add", ".");
git("commit", "-m", "Proof fixture");
const releaseCommit = git("rev-parse", "HEAD");
const reviewedHead = "a".repeat(40);
git("worktree", "add", "--detach", releaseCheckout, releaseCommit);
await writeFile(
  resolve(bin, "gh"),
  `#!/usr/bin/env node
const [resource, action, url] = process.argv.slice(2);
if (resource !== "pr" || action !== "view" || url !== "https://github.com/Bensigo/agentrail/pull/12") process.exit(1);
console.log(JSON.stringify({ state: "MERGED", headRefOid: "${reviewedHead}", mergeCommit: { oid: "${releaseCommit}" } }));
`,
  { mode: 0o700 },
);
await new Promise((resolve, reject) =>
  preview.once("error", reject).listen(0, "127.0.0.1", resolve),
);
const previewUrl = `http://127.0.0.1:${preview.address().port}/`;
const clients = [];
async function client(name, secret = key, verifierKey) {
  const c = new Client({ name, version: "1.0.0" });
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve("packages/mcp/dist/index.js")],
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        PROOF_PREVIEW: previewUrl,
        AGENTRAIL_TARGET: target,
        AGENTRAIL_WORKFLOW_BASE_URL: base,
        AGENTRAIL_WORKFLOW_API_KEY: secret,
        ...(verifierKey
          ? { AGENTRAIL_WORKFLOW_RELEASE_API_KEY: verifierKey }
          : {}),
      },
      stderr: "pipe",
    }),
  );
  clients.push(c);
  return c;
}
const tool = (client, name, args = {}) =>
  client.callTool({ name, arguments: args });
const payload = (result) => {
  assert(!result.isError, JSON.stringify(result));
  return result.structuredContent || JSON.parse(result.content[0].text);
};
let state;
try {
  await sql`INSERT INTO users (id, name, email) VALUES (${ownerId}, 'Workflow owner', ${`${ownerId}@example.invalid`})`;
  await sql`INSERT INTO sessions (session_token, user_id, expires) VALUES (${token}, ${ownerId}, ${new Date(Date.now() + 86400000)})`;
  await sql`INSERT INTO workspaces (id, name, slug) VALUES (${workspaceId}, 'AgentRail workflow proof', ${`proof-${workspaceId}`}), (${foreignWorkspaceId}, 'Foreign workspace', ${`proof-${foreignWorkspaceId}`})`;
  await sql`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (${workspaceId}, ${ownerId}, 'owner')`;
  await sql`INSERT INTO repositories (id, workspace_id, name, url) VALUES (${repositoryId}, ${workspaceId}, 'Bensigo/agentrail', 'https://github.com/Bensigo/agentrail')`;
  await sql`INSERT INTO api_keys (workspace_id, name, key_prefix, key_hash, kind) VALUES (${workspaceId}, 'proof', 'ar_proof', ${keyHash(key)}, 'workflow_mcp'), (${foreignWorkspaceId}, 'foreign proof', 'ar_foreign', ${keyHash(foreignKey)}, 'workflow_mcp'), (${workspaceId}, 'other credential', 'ar_other', ${keyHash(otherKey)}, 'workflow_mcp')`;
  const a = await client("independent-mcp-client-a"),
    b = await client("independent-mcp-client-b");
  const names = (await a.listTools()).tools.map((t) => t.name);
  assert(names.includes("workflow_start") && names.includes("context_search"));
  assert(
    !names.some((n) => n.startsWith("jace_") || n.startsWith("acceptance_")),
  );
  assert.equal(
    payload(await tool(a, "workflow_repositories")).repositories[0].id,
    repositoryId,
  );
  const start = {
    taskKey: randomUUID(),
    title: "Separate AgentRail workflow from Jace",
    agent: "MCP client A",
    repositoryId,
    branch: "proof/workflow",
  };
  const first = payload(await tool(a, "workflow_start", start)).task;
  assert.equal(
    payload(await tool(a, "workflow_start", start)).task.id,
    first.id,
  );
  assert(
    (await tool(a, "workflow_start", { ...start, title: "Conflicting retry" }))
      .isError,
  );
  const taskId = first.id;
  const progress = {
    taskId,
    eventKey: "implementation",
    expectedRevision: 0,
    phase: "implementing",
    summary: "Repository separation is under implementation.",
  };
  assert.equal(
    payload(await tool(a, "workflow_update", progress)).task.revision,
    1,
  );
  assert.equal(
    payload(await tool(a, "workflow_update", progress)).replayed,
    true,
  );
  assert(
    (await tool(a, "workflow_update", { ...progress, eventKey: "stale" }))
      .isError,
  );
  const check = payload(
    await tool(a, "workflow_check", {
      taskId,
      eventKey: "syntax",
      expectedRevision: 1,
      check: "syntax",
    }),
  );
  assert.equal(check.check.exitCode, 0);
  assert.equal(check.check.commitSha, git("rev-parse", "HEAD"));
  let revision = check.task.revision;
  const once = {
    taskId,
    eventKey: "one-execution",
    expectedRevision: revision,
    check: "once",
  };
  const onceResult = payload(await tool(a, "workflow_check", once));
  assert.equal(onceResult.check.dirty, true);
  payload(await tool(b, "workflow_check", once));
  assert.equal(await readFile(resolve(target, "executions"), "utf8"), "1");
  revision = payload(await tool(a, "workflow_get", { taskId })).task.revision;
  // A running check holds ordinary reports until its receipt has been retained.
  const running = tool(a, "workflow_check", {
    taskId,
    eventKey: "slow",
    expectedRevision: revision,
    check: "slow",
  });
  let held;
  for (let n = 0; n < 40; n++) {
    held = payload(await tool(b, "workflow_get", { taskId }));
    if (held.task.active_check_key) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(held.task.active_check_key);
  const forged = await fetch(`${base}/api/v1/workflow/tasks/${taskId}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${otherKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      eventKey: `check:${keyHash(held.task.active_check_key)}:finish`,
      expectedRevision: held.task.revision,
      phase: "testing",
      summary: "A different credential cannot finish this reservation.",
      check: {
        name: "slow",
        passed: true,
        exitCode: 0,
        outputSha256: "0".repeat(64),
        commitSha: git("rev-parse", "HEAD"),
        dirty: false,
      },
    }),
  });
  assert.equal(forged.status, 409);
  assert(
    (
      await tool(b, "workflow_update", {
        taskId,
        eventKey: "premature-finish",
        expectedRevision: held.task.revision,
        phase: "needs_review",
        summary: "Must not advance during a running check.",
      })
    ).isError,
  );
  const failed = payload(await running);
  assert.equal(failed.check.passed, false);
  assert.equal(failed.task.phase, "blocked");
  revision = failed.task.revision;
  const gitFailure = payload(
    await tool(a, "workflow_check", {
      taskId,
      eventKey: "git-failure",
      expectedRevision: revision,
      check: "gitFailure",
    }),
  );
  assert.equal(gitFailure.check.passed, false);
  assert.equal(gitFailure.check.dirty, true);
  assert.equal(gitFailure.task.active_check_key, null);
  await rename(resolve(target, ".git-held"), resolve(target, ".git"));
  revision = gitFailure.task.revision;
  git("checkout", "-b", "wrong/branch");
  assert(
    (
      await tool(a, "workflow_check", {
        taskId,
        eventKey: "wrong-checkout",
        expectedRevision: revision,
        check: "syntax",
      })
    ).isError,
  );
  git("checkout", "proof/workflow");
  assert.equal(
    payload(await tool(a, "workflow_get", { taskId })).task.revision,
    revision,
  );
  const foreign = await client("foreign-workspace", foreignKey);
  assert((await tool(foreign, "workflow_get", { taskId })).isError);
  assert(
    (await tool(foreign, "workflow_start", { ...start, taskKey: randomUUID() }))
      .isError,
  );
  const bTask = payload(
    await tool(b, "workflow_start", {
      ...start,
      taskKey: randomUUID(),
      title: "Second MCP client can use the same workflow",
      agent: "MCP client B",
    }),
  ).task;
  assert.equal(bTask.agent, "MCP client B");
  const ready = payload(
    await tool(a, "workflow_update", {
      taskId,
      eventKey: "handoff",
      expectedRevision: revision,
      phase: "needs_review",
      summary:
        "Review the split, check receipts and remaining deployment cutover.",
    }),
  ).task;
  const cookie = `authjs.session-token=${token}`;
  const updateUrl = `${base}/api/v1/workflow/tasks/${taskId}?workspaceId=${workspaceId}`;
  const decisionBody = {
    eventKey: "human-complete",
    expectedRevision: ready.revision,
    decision: "complete",
  };
  assert.equal(
    (
      await fetch(updateUrl, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          origin: "https://foreign.invalid",
        },
        body: JSON.stringify(decisionBody),
      })
    ).status,
    403,
  );
  const complete = await fetch(updateUrl, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: JSON.stringify(decisionBody),
  });
  assert.equal(complete.status, 200);
  const closed = (await complete.json()).task;
  assert(
    (
      await tool(a, "workflow_update", {
        taskId,
        eventKey: "agent-reopen",
        expectedRevision: closed.revision,
        phase: "implementing",
        summary: "Cannot reopen a human-closed task.",
      })
    ).isError,
  );
  const reopen = await fetch(updateUrl, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: JSON.stringify({
      eventKey: "human-reopen",
      expectedRevision: closed.revision,
      decision: "reopen",
    }),
  });
  assert.equal(reopen.status, 200);
  revision = (await reopen.json()).task.revision;
  payload(
    await tool(a, "workflow_update", {
      taskId,
      eventKey: "review-again",
      expectedRevision: revision,
      phase: "needs_review",
      summary:
        "MCP roundtrip, configured checks, conflict protection and human-decision boundaries passed locally.",
    }),
  );
  const readback = payload(await tool(b, "workflow_get", { taskId }));
  assert(
    readback.events.some(
      (e) => e.kind === "human_decision" && e.payload.actorId === ownerId,
    ),
  );
  // Follow one feature through the actual MCP tools, Console routes, and database.
  const prompt = await a.getPrompt({
    name: "agentrail_work",
    arguments: { request: "Make invites faster" },
  });
  assert.match(prompt.messages[0].content.text, /Make invites faster/);
  let delivery = payload(
    await tool(a, "workflow_start", {
      ...start,
      taskKey: randomUUID(),
      title: "Make invites faster",
      delivery: {
        kind: "feature",
        endpoint: "review",
        brief: "An invited player joins a match.",
      },
    }),
  ).task;
  assert.equal(delivery.delivery.stage, "shaping");
  const deliveryId = delivery.id;
  const verifierResponse = await fetch(
    `${base}/api/v1/workflow/keys?workspaceId=${workspaceId}&purpose=release`,
    {
      method: "POST",
      headers: { cookie, origin: base },
    },
  );
  assert.equal(verifierResponse.status, 201);
  const verifierKey = (await verifierResponse.json()).secret;
  const verifier = await client("operator-release-verifier", key, verifierKey);
  const update = (checkpoint, extra = {}, client = b) =>
    tool(client, "workflow_update", {
      taskId: deliveryId,
      expectedRevision: delivery.revision,
      eventKey: randomUUID(),
      phase: "reviewing",
      summary: "Recorded delivery progress.",
      checkpoint,
      ...extra,
    });
  const prUrl = "https://github.com/Bensigo/agentrail/pull/12";
  assert(
    (await update({ step: "review", headSha: reviewedHead }, { prUrl }))
      .isError,
  );
  assert(
    (
      await update({
        step: "ready",
        planPath: "docs/prd/invite.md",
        issueUrl: "https://github.com/foreign/project/issues/1",
        criteria: ["Invited player can join"],
      })
    ).isError,
  );
  delivery = payload(
    await update({
      step: "ready",
      planPath: "docs/prd/invite.md",
      issueUrl: "https://github.com/Bensigo/agentrail/issues/1",
      criteria: ["Invited player can join"],
    }),
  ).task;
  assert.equal(delivery.delivery.stage, "building");
  delivery = payload(
    await update({ step: "review", headSha: "b".repeat(40) }, { prUrl }),
  ).task;
  assert.equal(delivery.phase, "needs_review");
  delivery = payload(await update({ step: "ship" })).task;
  assert.equal(delivery.delivery.endpoint, "release");
  delivery = payload(
    await update({
      step: "release",
      commitSha: releaseCommit,
      targetUrl: previewUrl,
    }),
  ).task;
  const verify = (eventKey = randomUUID()) => ({
    taskId: deliveryId,
    expectedRevision: delivery.revision,
    eventKey,
    worktree: releaseCheckout,
  });
  assert((await tool(verifier, "workflow_verify_release", verify())).isError);
  assert.equal(observations, 0);
  delivery = payload(await update({ step: "rework" })).task;
  delivery = payload(
    await update({ step: "review", headSha: reviewedHead }),
  ).task;
  delivery = payload(
    await update({
      step: "release",
      commitSha: releaseCommit,
      targetUrl: previewUrl,
    }),
  ).task;

  const attemptRaw = (bearer, fields) =>
    fetch(`${base}/api/v1/workflow/tasks/${deliveryId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventKey: randomUUID(),
        expectedRevision: delivery.revision,
        phase: "testing",
        summary: "Rejected credential scope",
        ...fields,
      }),
    });
  assert.equal(
    (
      await attemptRaw(key, {
        checkReservation: { name: "agentrail:release-verification" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await attemptRaw(key, {
        check: {
          name: "agentrail:release-verification",
          passed: true,
          exitCode: 0,
          dirty: false,
          commitSha: releaseCommit,
          outputSha256: "0".repeat(64),
          releaseUrl: previewUrl,
        },
      })
    ).status,
    403,
  );
  assert.equal((await attemptRaw(verifierKey, {})).status, 403);
  assert((await tool(a, "workflow_verify_release", verify())).isError);

  const mismatch = payload(
    await tool(verifier, "workflow_verify_release", verify()),
  );
  assert.equal(mismatch.check.passed, false);
  assert.equal(mismatch.task.delivery.stage, "releasing");
  assert.equal(mismatch.task.active_check_key, null);
  delivery = mismatch.task;
  deployedCommit = releaseCommit;
  delivery = payload(await update({ step: "rework" })).task;
  delivery = payload(
    await update({ step: "review", headSha: reviewedHead }),
  ).task;
  delivery = payload(
    await update({
      step: "release",
      commitSha: releaseCommit,
      targetUrl: new URL("/different", previewUrl).href,
    }),
  ).task;
  const wrongTarget = payload(
    await tool(verifier, "workflow_verify_release", verify()),
  );
  assert.equal(wrongTarget.check.passed, false);
  delivery = wrongTarget.task;
  delivery = payload(await update({ step: "rework" })).task;
  delivery = payload(
    await update({ step: "review", headSha: reviewedHead }),
  ).task;
  delivery = payload(
    await update({
      step: "release",
      commitSha: releaseCommit,
      targetUrl: previewUrl,
    }),
  ).task;
  smokePasses = false;
  const broken = payload(
    await tool(verifier, "workflow_verify_release", verify()),
  );
  assert.equal(broken.check.passed, false);
  delivery = broken.task;
  delivery = payload(
    await update(undefined, {
      phase: "needs_review",
      summary: "An agent report cannot verify the release.",
    }),
  ).task;
  assert.equal(delivery.delivery.stage, "releasing");
  const premature = await fetch(
    `${base}/api/v1/workflow/tasks/${deliveryId}?workspaceId=${workspaceId}`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: base },
      body: JSON.stringify({
        decision: "complete",
        eventKey: "premature",
        expectedRevision: delivery.revision,
      }),
    },
  );
  assert.equal(premature.status, 409);

  smokePasses = true;
  const pass = verify();
  const verified = payload(
    await tool(verifier, "workflow_verify_release", pass),
  );
  assert.equal(verified.task.delivery.stage, "verified");
  assert.equal(verified.task.delivery.release.commitSha, releaseCommit);
  assert.equal(verified.task.delivery.release.url, previewUrl);
  const afterPass = observations;
  assert.equal(
    payload(await tool(verifier, "workflow_verify_release", pass)).replayed,
    true,
  );
  assert.equal(observations, afterPass);
  delivery = verified.task;
  delivery = payload(
    await update({
      step: "follow_up",
      issueUrl: "https://github.com/Bensigo/agentrail/issues/2",
    }),
  ).task;
  assert.equal(delivery.delivery.stage, "verified");
  const display = await fetch(
    `${base}/dashboard/${workspaceId}/work/${deliveryId}`,
    { headers: { cookie } },
  );
  assert.equal(display.status, 200);
  assert.match(await display.text(), /Configured live check passed/);

  const pickup = payload(
    await tool(b, "workflow_start", {
      ...start,
      taskKey: randomUUID(),
      title: "Pick up a pull request",
      delivery: {
        kind: "pr",
        endpoint: "review",
        brief: "Finish review",
        prUrl,
      },
    }),
  ).task;
  assert.equal(pickup.delivery.stage, "review");
  assert.equal(pickup.pr_url, prUrl);
  const fix = payload(
    await tool(b, "workflow_start", {
      ...start,
      taskKey: randomUUID(),
      title: "Fix an invite",
      delivery: {
        kind: "fix",
        endpoint: "review",
        brief: "Fix overflow on the invite screen",
      },
    }),
  ).task;
  assert.equal(fix.delivery.stage, "building");
  const telemetry = {
    context: {
      summary:
        "Protocol fixture source context; sample telemetry for verification.",
      sources: ["sample.js"],
      tokens: 128,
      windowTokens: 4096,
    },
    usage: { inputTokens: 256, outputTokens: 64, costUsd: 0 },
  };
  const reported = payload(
    await tool(a, "workflow_update", {
      taskId,
      eventKey: "office-telemetry",
      expectedRevision: readback.task.revision,
      phase: "reviewing",
      summary: "Verify optional Office snapshots.",
      ...telemetry,
    }),
  );
  const officeResponse = await fetch(`${base}/api/v1/workflow/office`, {
    headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(officeResponse.status, 200);
  assert(officeResponse.headers.get("cache-control").includes("no-store"));
  const office = await officeResponse.json(),
    desk = office.tasks.find((t) => t.id === taskId);
  assert.deepEqual(desk.context, telemetry.context);
  assert.deepEqual(desk.usage, telemetry.usage);
  const foreignOffice = await fetch(`${base}/api/v1/workflow/office`, {
    headers: { authorization: `Bearer ${foreignKey}` },
  });
  assert(!(await foreignOffice.json()).tasks.some((t) => t.id === taskId));
  // Real streaming route: workspace isolation, subsequent MCP reports, and revocation.
  assert.equal(
    (await fetch(`${base}/api/v1/workflow/office/events`)).status,
    401,
  );
  async function live(secret) {
    const abort = new AbortController(),
      deadline = setTimeout(() => abort.abort(), 12000);
    const response = await fetch(`${base}/api/v1/workflow/office/events`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: abort.signal,
    });
    assert.equal(response.status, 200);
    assert(response.headers.get("content-type").includes("text/event-stream"));
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    return {
      async next() {
        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            return {
              event: frame.split("\n")[0].slice(7),
              data: JSON.parse(
                frame
                  .split("\n")
                  .find((line) => line.startsWith("data: "))
                  .slice(6),
              ),
            };
          }
          const chunk = await reader.read();
          if (chunk.done) return null;
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      },
      close() {
        clearTimeout(deadline);
        abort.abort();
      },
    };
  }
  const updates = await live(key),
    foreignUpdates = await live(foreignKey);
  try {
    assert((await updates.next()).data.tasks.some((t) => t.id === taskId));
    assert(
      !(await foreignUpdates.next()).data.tasks.some((t) => t.id === taskId),
    );
    const streamed = payload(
      await tool(a, "workflow_update", {
        taskId,
        eventKey: "live-office-change",
        expectedRevision: reported.task.revision,
        phase: "testing",
        summary: "Exercise the live report stream.",
      }),
    );
    let event;
    do {
      event = await updates.next();
    } while (event?.event === "heartbeat");
    assert.equal(
      event.data.tasks.find((t) => t.id === taskId).revision,
      streamed.task.revision,
    );
    await sql`UPDATE api_keys SET revoked_at=now() WHERE key_hash=${keyHash(foreignKey)}`;
    while (await foreignUpdates.next()) {
      /* Drain an already delivered heartbeat before EOF. */
    }
  } finally {
    updates.close();
    foreignUpdates.close();
  }
  const unauthorized = await fetch(
    `${base}/api/v1/runner/claim?workspace_id=${workspaceId}`,
    { headers: { authorization: `Bearer ${key}` } },
  );
  assert.equal(unauthorized.status, 403);
  await sql`UPDATE api_keys SET revoked_at=now() WHERE key_hash=${keyHash(foreignKey)}`;
  assert((await tool(foreign, "workflow_list")).isError);
  state = {
    workspaceId,
    taskId,
    ownerId,
    sessionToken: token,
    key,
    base,
    target,
    deliveryId,
  };
  if (process.env.PROOF_STATE_FILE) {
    await writeFile(process.env.PROOF_STATE_FILE, JSON.stringify(state));
    await chmod(process.env.PROOF_STATE_FILE, 0o600);
  }
  console.log(
    JSON.stringify({
      passed: true,
      workspaceId,
      taskId,
      checks: [
        "real MCP protocol",
        "live Office updates, tenant isolation and stream revocation",
        "two independent client identities",
        "context/workflow tools only",
        "start retry deduplication",
        "stale update refusal",
        "configured check subprocess",
        "check replay once",
        "concurrent check hold",
        "reservation credential custody",
        "dirty-after receipt",
        "post-check Git failure receipt",
        "wrong branch refusal",
        "tenant isolation",
        "human origin and terminal control",
        "actor custody",
        "credential separation",
        "revocation",
        "Office MCP telemetry roundtrip",
        "Office tenant isolation",
        "feature, fix and PR entry points",
        "cross-client planning, review and release checkpoints",
        "wrong PR head, deployed version, deployment URL, and smoke failures refuse verified status",
        "ordinary workflow keys cannot submit verifier receipts",
        "release check replay does not contact the deployment twice",
        "verified release and follow-up visible in Console",
      ],
      proofLevel:
        "local runtime with a GitHub fixture and an HTTP test deployment",
    }),
  );
} finally {
  await Promise.allSettled(clients.map((c) => c.close()));
  await sql.end();
  preview.closeAllConnections();
  await new Promise((resolve) => preview.close(resolve));
  if (!process.env.PROOF_STATE_FILE)
    await rm(fixture, { recursive: true, force: true });
}
