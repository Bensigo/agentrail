import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

const WORKFLOW = new URL(
  "../../../.github/workflows/github-claude-correction-ack.yml",
  import.meta.url
);
const CLAUDE_ACTION_SHA = "6b082c41935b4c8a3b8b0ef85ba4ba4d9eeb8975";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const REPOSITORY = "Bensigo/example";
const PR_NUMBER = "42";

function extractNodeScript(source: string, jobName: string): string {
  const jobStart = source.indexOf(`  ${jobName}:`);
  if (jobStart < 0) throw new Error(`missing ${jobName} job`);
  const afterStart = source.slice(jobStart + 1);
  const nextJob = /\n  [A-Za-z0-9_-]+:\n/.exec(afterStart);
  const job = source.slice(
    jobStart,
    nextJob ? jobStart + 1 + nextJob.index : source.length
  );
  const match = /node <<'NODE'\n([\s\S]*?)\n {10}NODE/.exec(job);
  if (!match) throw new Error(`missing embedded Node script for ${jobName}`);
  return match[1].replace(/^ {10}/gm, "");
}

function pullRequest(headSha: string) {
  return {
    number: Number(PR_NUMBER),
    html_url: `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}`,
    head: { sha: headSha },
    base: { repo: { full_name: REPOSITORY } },
    state: "open",
    draft: false,
    merged: false,
  };
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

async function executeEmbeddedScript(input: {
  script: string;
  env: Record<string, string>;
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  appendFileSync?: (path: string, value: string, encoding: string) => void;
  abortSignal?: { timeout(milliseconds: number): AbortSignal };
}) {
  const stderr: string[] = [];
  const processValue: {
    env: Record<string, string>;
    stderr: { write: (value: string) => boolean };
    exitCode?: number;
  } = {
    env: input.env,
    stderr: {
      write(value) {
        stderr.push(String(value));
        return true;
      },
    },
  };
  const localRequire = (specifier: string) => {
    if (specifier === "node:crypto") return { createHash };
    if (specifier === "node:fs" && input.appendFileSync) {
      return { appendFileSync: input.appendFileSync };
    }
    throw new Error(`unexpected embedded module ${specifier}`);
  };

  await Promise.resolve(
    runInNewContext(input.script, {
      AbortSignal: input.abortSignal ?? AbortSignal,
      TextDecoder,
      Uint8Array,
      URL,
      fetch: input.fetch,
      process: processValue,
      require: localRequire,
    })
  );
  return { exitCode: processValue.exitCode, stderr: stderr.join("") };
}

async function runBeforeObservation(input: {
  commentBody: string;
  remoteHeadSha?: string;
}) {
  const source = await readFile(WORKFLOW, "utf8");
  const output: string[] = [];
  const fetchMock = vi.fn(async (request: string | URL, init?: RequestInit) => {
    void request;
    void init;
    return jsonResponse(pullRequest(input.remoteHeadSha ?? HEAD_A));
  });
  const result = await executeEmbeddedScript({
    script: extractNodeScript(source, "observe_before"),
    env: {
      ACTIVATION_COMMENT_BODY: input.commentBody,
      GITHUB_OUTPUT: "/tmp/agentrail-github-output",
      GITHUB_REPOSITORY_VALUE: REPOSITORY,
      GITHUB_TOKEN_VALUE: "github-token",
      PR_NUMBER_VALUE: PR_NUMBER,
    },
    fetch: fetchMock,
    appendFileSync(path, value, encoding) {
      expect(path).toBe("/tmp/agentrail-github-output");
      expect(encoding).toBe("utf8");
      output.push(value);
    },
  });
  return { ...result, fetchMock, output: output.join("") };
}

type AcknowledgePrOutcome =
  | { kind: "valid"; headSha: string }
  | { kind: "identity_mismatch" }
  | { kind: "malformed" }
  | { kind: "oversize" }
  | { kind: "streamed_oversize" }
  | { kind: "stalled" }
  | { kind: "timeout" };

async function runAcknowledgement(prOutcome: AcknowledgePrOutcome) {
  const source = await readFile(WORKFLOW, "utf8");
  const activationBody = [
    "@claude consume this immutable correction packet.",
    "- Dispatch ID: dispatch_123",
    `- Original exact head: ${HEAD_A}`,
  ].join("\n");
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  let streamCancelled = false;
  let markStalledReaderStarted!: () => void;
  const stalledReaderStarted = new Promise<void>((resolve) => {
    markStalledReaderStarted = resolve;
  });
  const timeoutCalls: number[] = [];
  const testAbortSignal = prOutcome.kind === "stalled"
    ? {
        timeout(milliseconds: number) {
          timeoutCalls.push(milliseconds);
          const controller = new AbortController();
          setTimeout(() => controller.abort(), milliseconds);
          return controller.signal;
        },
      }
    : undefined;
  const fetchMock = vi.fn(async (request: string | URL, init?: RequestInit) => {
    const url = new URL(String(request));
    requests.push({ url, init });
    if (url.hostname === "token.actions.githubusercontent.com") {
      const repair = url.searchParams.get("audience")?.includes("/repair-observation/");
      return jsonResponse({ value: repair ? "repair.token.signature" : "ack.token.signature" });
    }
    if (url.pathname === "/api/v1/webhooks/github-actions/claude-ack") {
      return new Response(null, { status: 201 });
    }
    if (url.hostname === "api.github.com") {
      if (prOutcome.kind === "timeout") throw new Error("request timed out");
      if (prOutcome.kind === "oversize") {
        return new Response("{}", {
          status: 200,
          headers: { "content-length": String(256 * 1024 + 1) },
        });
      }
      if (prOutcome.kind === "streamed_oversize") {
        let reads = 0;
        return {
          ok: true,
          headers: new Headers(),
          body: {
            getReader() {
              return {
                async read() {
                  reads += 1;
                  return reads === 1
                    ? { done: false, value: new Uint8Array(200 * 1024) }
                    : { done: false, value: new Uint8Array(100 * 1024) };
                },
                async cancel() {
                  streamCancelled = true;
                },
                releaseLock() {},
              };
            },
          },
        } as unknown as Response;
      }
      if (prOutcome.kind === "stalled") {
        const signal = init?.signal;
        if (!signal) throw new Error("missing request timeout signal");
        return {
          ok: true,
          headers: new Headers(),
          body: {
            getReader() {
              return {
                read() {
                  markStalledReaderStarted();
                  return new Promise<never>((_resolve, reject) => {
                    const fail = () => reject(new Error("body read aborted"));
                    if (signal.aborted) fail();
                    else signal.addEventListener("abort", fail, { once: true });
                  });
                },
                async cancel() {
                  streamCancelled = true;
                },
                releaseLock() {},
              };
            },
          },
        } as unknown as Response;
      }
      if (prOutcome.kind === "malformed") return new Response("not-json", { status: 200 });
      if (prOutcome.kind === "identity_mismatch") {
        return jsonResponse({
          ...pullRequest(HEAD_B),
          html_url: `https://github.com/attacker/example/pull/${PR_NUMBER}`,
        });
      }
      return jsonResponse(pullRequest(prOutcome.headSha));
    }
    if (url.pathname === "/api/v1/webhooks/github-actions/claude-repair-observation") {
      return new Response(null, { status: 201 });
    }
    throw new Error(`unexpected request ${url}`);
  });
  const execution = executeEmbeddedScript({
    script: extractNodeScript(source, "acknowledge"),
    env: {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
      ACTIONS_ID_TOKEN_REQUEST_URL:
        "https://token.actions.githubusercontent.com/.well-known/oidc?api-version=1",
      ACTIVATION_COMMENT_BODY: activationBody,
      ACTIVATION_COMMENT_ID: "99112233",
      AGENTRAIL_ACK_URL:
        "https://www.heyjace.com/api/v1/webhooks/github-actions/claude-ack",
      BEFORE_HEAD_SHA: HEAD_A,
      CLAUDE_SESSION_ID: "session_12345678",
      GITHUB_REPOSITORY_VALUE: REPOSITORY,
      GITHUB_RUN_ATTEMPT_VALUE: "1",
      GITHUB_RUN_ID_VALUE: "88776655",
      GITHUB_TOKEN_VALUE: "github-token",
      PR_NUMBER_VALUE: PR_NUMBER,
    },
    fetch: fetchMock,
    abortSignal: testAbortSignal,
  });
  if (prOutcome.kind === "stalled") {
    await stalledReaderStarted;
    await vi.advanceTimersByTimeAsync(8_000);
  }
  const result = await execution;
  return {
    ...result,
    activationBody,
    fetchMock,
    requests,
    streamCancelled,
    timeoutCalls,
  };
}

describe("trusted GitHub Claude acknowledgement workflow", () => {
  it("pins the selected action and admits only the exact Jace bot trigger", async () => {
    const source = await readFile(WORKFLOW, "utf8");
    expect(source).toContain(`anthropics/claude-code-action@${CLAUDE_ACTION_SHA}`);
    expect(source).not.toMatch(/anthropics\/claude-code-action@(v|main|master)/);
    expect(source).toContain("github.event.comment.user.login == 'jace[bot]'");
    expect(source).toMatch(/allowed_bots:\s+jace\[bot\]/);
    expect(source).not.toMatch(/allowed_bots:\s+["']?\*/);
    expect(source).toContain("contains(github.event.comment.body, '@claude')");
    expect(source).toContain("contains(github.event.comment.body, '- Dispatch ID:')");
  });

  it("mints OIDC only in a fresh success-gated job and never checks out source there", async () => {
    const source = await readFile(WORKFLOW, "utf8");
    const acknowledgementJob = source.slice(source.indexOf("  acknowledge:"));
    expect(acknowledgementJob).toContain("needs: [observe_before, claude]");
    expect(acknowledgementJob).toContain("needs.claude.outputs.conclusion == 'success'");
    expect(acknowledgementJob).toContain("needs.claude.outputs.session_id != ''");
    expect(acknowledgementJob).toMatch(/id-token:\s+write/);
    expect(acknowledgementJob).not.toContain("actions/checkout@");
    expect(acknowledgementJob).not.toContain("anthropics/claude-code-action@");
    expect(source.slice(0, source.indexOf("  acknowledge:"))).not.toMatch(/id-token:\s+write/);
  });

  it("requires one canonical activation head and observes that exact live head before Claude", async () => {
    const result = await runBeforeObservation({
      commentBody: `@claude\n- Original exact head: ${HEAD_A}\n- Dispatch ID: dispatch_123`,
    });
    expect(result.exitCode).toBeUndefined();
    expect(result.output).toBe(`head_sha=${HEAD_A}\n`);
    expect(result.fetchMock).toHaveBeenCalledOnce();
    const [, init] = result.fetchMock.mock.calls[0];
    expect(init).toMatchObject({ redirect: "error" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["missing", `@claude\n- Dispatch ID: dispatch_123`, false],
    [
      "duplicate",
      `@claude\n- Original exact head: ${HEAD_A}\n- Original exact head: ${HEAD_A}\n- Dispatch ID: dispatch_123`,
      false,
    ],
    [
      "non-canonical",
      `@claude\n- Original exact head: ${HEAD_A.toUpperCase()}\n- Dispatch ID: dispatch_123`,
      false,
    ],
    [
      "stale",
      `@claude\n- Original exact head: ${HEAD_A}\n- Dispatch ID: dispatch_123`,
      true,
    ],
  ])("blocks Claude when the activation head is %s", async (_case, commentBody, fetchesPr) => {
    const result = await runBeforeObservation({
      commentBody,
      remoteHeadSha: fetchesPr ? HEAD_B : HEAD_A,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("");
    expect(result.fetchMock).toHaveBeenCalledTimes(fetchesPr ? 1 : 0);
  });

  it("binds the first run attempt and posts only to fixed AgentRail callback paths", async () => {
    const source = await readFile(WORKFLOW, "utf8");
    expect(source).toContain('runAttempt !== "1"');
    expect(source).toMatch(
      /"github_claude_ack",\s*"1",\s*activationCommentId,\s*runId,\s*runAttempt,?/
    );
    expect(source).toContain(
      "agentrail://correction-dispatch/github-claude/ack/v1/${digest(["
    );
    expect(source).toContain(
      'callback.pathname !== "/api/v1/webhooks/github-actions/claude-ack"'
    );
    expect(source).toContain(
      '"/api/v1/webhooks/github-actions/claude-repair-observation"'
    );
    expect(source).toContain('["heyjace.com", "www.heyjace.com"]');
    expect(source).toContain(
      "const activationBodySha256 = digest(required(\"ACTIVATION_COMMENT_BODY\"))"
    );
    expect(source).toContain("sessionId: required(\"CLAUDE_SESSION_ID\")");
    expect(source).not.toContain("console.log");
  });

  it("does not mint or post repair evidence when the selected run leaves the head unchanged", async () => {
    const result = await runAcknowledgement({ kind: "valid", headSha: HEAD_A });
    expect(result.exitCode).toBeUndefined();
    expect(result.requests.filter(({ url }) =>
      url.hostname === "token.actions.githubusercontent.com"
    )).toHaveLength(1);
    expect(result.requests.filter(({ url }) =>
      url.pathname === "/api/v1/webhooks/github-actions/claude-ack"
    )).toHaveLength(1);
    expect(result.requests.some(({ url }) =>
      url.pathname === "/api/v1/webhooks/github-actions/claude-repair-observation"
    )).toBe(false);
  });

  it("mints a second bound token and posts the exact changed-head observation", async () => {
    const result = await runAcknowledgement({ kind: "valid", headSha: HEAD_B });
    expect(result.exitCode).toBeUndefined();
    const oidcRequests = result.requests.filter(({ url }) =>
      url.hostname === "token.actions.githubusercontent.com"
    );
    expect(oidcRequests).toHaveLength(2);
    const activationBodySha256 = createHash("sha256")
      .update(result.activationBody, "utf8")
      .digest("hex");
    const repairBinding = [
      "github_claude_repair_observation",
      "1",
      "99112233",
      activationBodySha256,
      HEAD_A,
      HEAD_B,
      "88776655",
      "1",
    ].join(":");
    const expectedAudience =
      "agentrail://correction-dispatch/github-claude/repair-observation/v1/" +
      createHash("sha256").update(repairBinding, "utf8").digest("hex");
    expect(oidcRequests[1].url.searchParams.get("audience")).toBe(expectedAudience);

    const repairRequest = result.requests.find(({ url }) =>
      url.pathname === "/api/v1/webhooks/github-actions/claude-repair-observation"
    );
    expect(repairRequest?.init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: "Bearer repair.token.signature",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(repairRequest?.init?.body))).toEqual({
      version: 1,
      activationCommentId: "99112233",
      activationBodySha256,
      beforeHeadSha: HEAD_A,
      afterHeadSha: HEAD_B,
      sessionId: "session_12345678",
      runId: "88776655",
      runAttempt: 1,
    });
  });

  it.each([
    { kind: "identity_mismatch" as const },
    { kind: "malformed" as const },
    { kind: "oversize" as const },
    { kind: "streamed_oversize" as const },
    { kind: "timeout" as const },
  ])("fails closed after acknowledgement for an invalid PR read: $kind", async (outcome) => {
    const result = await runAcknowledgement(outcome);
    expect(result.exitCode).toBe(1);
    expect(result.requests.filter(({ url }) =>
      url.pathname === "/api/v1/webhooks/github-actions/claude-ack"
    )).toHaveLength(1);
    expect(result.requests.some(({ url }) =>
      url.pathname === "/api/v1/webhooks/github-actions/claude-repair-observation"
    )).toBe(false);
    expect(result.stderr).toBe("AgentRail Claude acknowledgement workflow failed\n");
  });

  it("cancels an over-limit streamed PR body", async () => {
    const result = await runAcknowledgement({ kind: "streamed_oversize" });
    expect(result.exitCode).toBe(1);
    expect(result.streamCancelled).toBe(true);
    expect(result.requests.some(({ url }) =>
      url.pathname === "/api/v1/webhooks/github-actions/claude-repair-observation"
    )).toBe(false);
  });

  it("aborts a stalled PR response body at the fixed eight-second deadline", async () => {
    vi.useFakeTimers();
    try {
      const result = await runAcknowledgement({ kind: "stalled" });
      expect(result.exitCode).toBe(1);
      expect(result.timeoutCalls).toEqual([8_000, 8_000, 8_000]);
      expect(result.requests.some(({ url }) =>
        url.pathname === "/api/v1/webhooks/github-actions/claude-repair-observation"
      )).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
