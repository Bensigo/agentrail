import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class ConflictError extends Error {}
  return {
    record: vi.fn(),
    audience: vi.fn(() =>
      `agentrail://correction-dispatch/github-claude/repair-observation/v1/${"a".repeat(64)}`),
    verify: vi.fn(),
    ConflictError,
  };
});

vi.mock("@agentrail/db-postgres", () => ({
  recordGithubClaudeRepairHeadObservation: mocks.record,
  githubClaudeRepairObservationAudience: mocks.audience,
  GithubClaudeRepairObservationConflictError: mocks.ConflictError,
}));

vi.mock("../../../../../../lib/github-actions-oidc", () => ({
  verifyGithubClaudeRepairObservationOidcToken: mocks.verify,
}));

import { POST } from "./route";

const body = {
  version: 1,
  activationCommentId: "99112233",
  activationBodySha256: "b".repeat(64),
  beforeHeadSha: "c".repeat(40),
  afterHeadSha: "d".repeat(40),
  sessionId: "session_12345678",
  runId: "88776655",
  runAttempt: 1,
} as const;

const claims = {
  issuer: "https://token.actions.githubusercontent.com",
  audience:
    `agentrail://correction-dispatch/github-claude/repair-observation/v1/${"a".repeat(64)}`,
  subject: "repo:Bensigo/example:ref:refs/heads/main",
  subjectSha256: "e".repeat(64),
  jtiSha256: "f".repeat(64),
  issuedAt: 1_800_000_000,
  notBefore: 1_799_999_999,
  expiresAt: 1_800_000_300,
  repository: "Bensigo/example",
  repositoryId: "12345",
  repositoryOwner: "Bensigo",
  repositoryOwnerId: "67890",
  actor: "jace[bot]",
  actorId: "424242",
  eventName: "issue_comment",
  ref: "refs/heads/main",
  workflowRef: "Bensigo/example/.github/workflows/agentrail.yml@refs/heads/main",
  workflowSha: "1".repeat(40),
  jobWorkflowRef:
    `Bensigo/agentrail/.github/workflows/github-claude-correction-ack.yml@${"2".repeat(40)}`,
  jobWorkflowSha: "2".repeat(40),
  runId: body.runId,
  runAttempt: 1,
  checkRunId: "123456789",
} as const;

function request(input: {
  value?: unknown;
  authorization?: string | null;
  contentType?: string;
  raw?: string;
} = {}): Request {
  const headers = new Headers();
  if (input.authorization !== null) {
    headers.set("authorization", input.authorization ?? "Bearer a.b.c");
  }
  headers.set("content-type", input.contentType ?? "application/json");
  return new Request(
    "https://www.heyjace.com/api/v1/webhooks/github-actions/claude-repair-observation",
    {
      method: "POST",
      headers,
      body: input.raw ?? JSON.stringify(
        Object.prototype.hasOwnProperty.call(input, "value") ? input.value : body
      ),
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.audience.mockReturnValue(
    `agentrail://correction-dispatch/github-claude/repair-observation/v1/${"a".repeat(64)}`
  );
  mocks.verify.mockResolvedValue({ ok: true, claims });
  mocks.record.mockResolvedValue({ kind: "recorded", observation: { id: "observation" } });
});

describe("POST GitHub Claude repair observation", () => {
  it("rejects missing or malformed bearer auth before reading or storing", async () => {
    for (const authorization of [null, "Basic abc", "Bearer not-a-jwt"]) {
      const response = await POST(request({ authorization, raw: "{" }));
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    }
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong content type", { contentType: "text/plain" }],
    ["malformed JSON", { raw: "{" }],
    ["null", { value: null }],
    ["array", { value: [] }],
    ["extra target authority", { value: { ...body, workspaceId: crypto.randomUUID() } }],
    ["wrong attempt", { value: { ...body, runAttempt: 2 } }],
    ["same head", { value: { ...body, afterHeadSha: body.beforeHeadSha } }],
    ["noncanonical head", { value: { ...body, afterHeadSha: "D".repeat(40) } }],
    ["raw source-sized session", { value: { ...body, sessionId: "x".repeat(257) } }],
  ])("rejects %s as a closed request", async (_name, options) => {
    const response = await POST(request(options));
    expect(response.status).toBe(400);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("caps the streamed request body before JWT or DB work", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(4_097)));
      },
      cancel,
    });
    const response = await POST(new Request(
      "https://www.heyjace.com/api/v1/webhooks/github-actions/claude-repair-observation",
      {
        method: "POST",
        headers: { authorization: "Bearer a.b.c", "content-type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" }
    ));
    expect(response.status).toBe(400);
    expect(cancel).toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("requires the exact repair audience and signed run", async () => {
    mocks.verify.mockResolvedValueOnce({ ok: false, reason: "invalid_token" });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.record).not.toHaveBeenCalled();

    mocks.verify.mockResolvedValueOnce({
      ok: true,
      claims: { ...claims, runId: "999999" },
    });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("records only the verified bounded observation and ephemeral session locator", async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual({
      ok: true,
      status: "repair_observation_recorded",
      replayed: false,
    });
    expect(mocks.audience).toHaveBeenCalledWith({
      activationCommentId: body.activationCommentId,
      activationBodySha256: body.activationBodySha256,
      beforeHeadSha: body.beforeHeadSha,
      afterHeadSha: body.afterHeadSha,
      runId: body.runId,
      runAttempt: 1,
    });
    expect(mocks.verify).toHaveBeenCalledWith({ token: "a.b.c", audience: claims.audience });
    expect(mocks.record).toHaveBeenCalledWith({
      activationCommentId: body.activationCommentId,
      activationBodySha256: body.activationBodySha256,
      beforeHeadSha: body.beforeHeadSha,
      afterHeadSha: body.afterHeadSha,
      providerSessionId: body.sessionId,
      oidc: claims,
    });
    expect(responseText).not.toContain(body.sessionId);
    expect(responseText).not.toContain(body.afterHeadSha);
  });

  it("returns exact replay truth", async () => {
    mocks.record.mockResolvedValueOnce({ kind: "replayed", observation: { id: "observation" } });
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: "repair_observation_recorded",
      replayed: true,
    });
  });

  it("maps stale/conflicting custody to 409 and storage failure to a fixed 503", async () => {
    mocks.record.mockResolvedValueOnce({ kind: "not_admitted" });
    const stale = await POST(request());
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ error: "Repair observation not admitted" });

    mocks.record.mockRejectedValueOnce(new mocks.ConflictError());
    expect((await POST(request())).status).toBe(409);

    mocks.record.mockRejectedValueOnce(new Error("db secret should not leak"));
    const unavailable = await POST(request());
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: "Repair observation unavailable" });
  });
});
