import { createHmac } from "crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  enqueueReviewJob: vi.fn(),
  getWorkspaceByGithubInstallationId: vi.fn(),
  getRepositoryByName: vi.fn(),
  appendChangeRecordEvent: vi.fn(),
  findOrCreateChangeRecord: vi.fn(),
  recordReviewEvent: vi.fn(),
}));
import { POST } from "./route";
import {
  enqueueReviewJob,
  getWorkspaceByGithubInstallationId,
  getRepositoryByName,
  appendChangeRecordEvent,
  findOrCreateChangeRecord,
  recordReviewEvent,
} from "@agentrail/db-postgres";

// --- fixtures ---------------------------------------------------------------

const SECRET_ENV = "GITHUB_APP_WEBHOOK_SECRET";
const ENROLL_ENV = "REVIEWER_OF_RECORD_WORKSPACES";
const SECRET = "gh-app-webhook-secret-abc123";
const ORIGINAL_SECRET = process.env[SECRET_ENV];
const ORIGINAL_ENROLL = process.env[ENROLL_ENV];
const DELIVERY_ID = "gh-delivery-1";

const WORKSPACE_ID = "ws-1";
const WORKSPACE = { workspaceId: WORKSPACE_ID };
const CONNECTED_REPO = {
  id: "repo-1",
  workspaceId: WORKSPACE_ID,
  name: "ada/widgets",
  url: "https://github.com/ada/widgets",
  defaultBranch: "main",
};

/** The brief's own recipe: HMAC-SHA256 of the RAW body, hex-encoded, `sha256=` prefixed. */
function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function makeRequest(
  body: string,
  opts: {
    event?: string | null;
    signature?: string | null;
    omitSignatureHeader?: boolean;
    deliveryId?: string | null;
  } = {}
): NextRequest {
  const {
    event = "pull_request",
    signature,
    omitSignatureHeader = false,
    deliveryId = DELIVERY_ID,
  } = opts;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (event !== null) headers["x-github-event"] = event;
  if (deliveryId !== null) headers["x-github-delivery"] = deliveryId;
  if (!omitSignatureHeader) {
    headers["x-hub-signature-256"] = signature ?? sign(body, SECRET);
  }
  return new NextRequest("http://localhost/api/v1/webhooks/github-app", {
    method: "POST",
    headers,
    body,
  });
}

function prPayload(
  opts: {
    action?: string;
    draft?: boolean;
    headSha?: string;
    prNumber?: number;
    repoFullName?: string;
    installationId?: number;
    omitInstallation?: boolean;
    merged?: boolean;
    mergeCommitSha?: string;
    htmlUrl?: string;
  } = {}
): Record<string, unknown> {
  const {
    action = "opened",
    draft = false,
    headSha = "abc123def4567890",
    prNumber = 42,
    repoFullName = "ada/widgets",
    installationId = 999,
    omitInstallation = false,
    merged = false,
    mergeCommitSha = "merge-sha-1",
    htmlUrl = "https://github.com/ada/widgets/pull/42",
  } = opts;
  return {
    action,
    number: prNumber,
    pull_request: {
      number: prNumber,
      draft,
      head: { sha: headSha },
      merged,
      merge_commit_sha: mergeCommitSha,
      html_url: htmlUrl,
    },
    repository: { full_name: repoFullName },
    ...(omitInstallation ? {} : { installation: { id: installationId } }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[SECRET_ENV] = SECRET;
  process.env[ENROLL_ENV] = WORKSPACE_ID;
  vi.mocked(getWorkspaceByGithubInstallationId).mockResolvedValue(WORKSPACE as never);
  vi.mocked(getRepositoryByName).mockResolvedValue(CONNECTED_REPO as never);
  vi.mocked(enqueueReviewJob).mockResolvedValue({
    id: "job-1",
    deduped: false,
    superseded: 0,
  } as never);
  vi.mocked(findOrCreateChangeRecord).mockResolvedValue({ id: "change-1" } as never);
  vi.mocked(appendChangeRecordEvent).mockResolvedValue({} as never);
  vi.mocked(recordReviewEvent).mockResolvedValue({ recorded: true, eventId: "review-event-1" } as never);
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env[SECRET_ENV];
  else process.env[SECRET_ENV] = ORIGINAL_SECRET;
  if (ORIGINAL_ENROLL === undefined) delete process.env[ENROLL_ENV];
  else process.env[ENROLL_ENV] = ORIGINAL_ENROLL;
});

describe("POST /api/v1/webhooks/github-app", () => {
  // ---------------------------------------------------------------------
  // 1. secret unset -> fail closed 401 (pinned message)
  // ---------------------------------------------------------------------

  it("1. 401 'webhook secret not configured' when GITHUB_APP_WEBHOOK_SECRET is unset — fail closed, never touches the DB", async () => {
    delete process.env[SECRET_ENV];
    const body = JSON.stringify(prPayload());
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "webhook secret not configured" });
    expect(getWorkspaceByGithubInstallationId).not.toHaveBeenCalled();
    expect(getRepositoryByName).not.toHaveBeenCalled();
    expect(enqueueReviewJob).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // 2. missing/invalid signature -> 401, verified BEFORE the body is trusted
  // ---------------------------------------------------------------------

  it("2a. 401 when X-Hub-Signature-256 is missing entirely", async () => {
    const body = JSON.stringify(prPayload());
    const res = await POST(makeRequest(body, { omitSignatureHeader: true }));
    expect(res.status).toBe(401);
    expect(getWorkspaceByGithubInstallationId).not.toHaveBeenCalled();
  });

  it("2b. 401 when the signature does not match (wrong secret)", async () => {
    const body = JSON.stringify(prPayload());
    const res = await POST(makeRequest(body, { signature: sign(body, "wrong-secret") }));
    expect(res.status).toBe(401);
    expect(getWorkspaceByGithubInstallationId).not.toHaveBeenCalled();
  });

  it("2c. 401 when the signature is well-formed but a different length than expected (never reaches timingSafeEqual with mismatched buffers)", async () => {
    const body = JSON.stringify(prPayload());
    const res = await POST(makeRequest(body, { signature: "sha256=deadbeef" }));
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------
  // 3. non-pull_request event -> 200 ignored
  // ---------------------------------------------------------------------

  it("3. a valid signature on a non-pull_request event (e.g. 'issues') -> 200 {ok:true, ignored:true}, no DB calls", async () => {
    const body = JSON.stringify(prPayload());
    const res = await POST(makeRequest(body, { event: "issues" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(getWorkspaceByGithubInstallationId).not.toHaveBeenCalled();
    expect(enqueueReviewJob).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // 4. pull_request action outside the trigger set -> 200 ignored
  // ---------------------------------------------------------------------

  it("4. pull_request action outside opened|ready_for_review|reopened|synchronize -> 200 ignored", async () => {
    for (const action of ["closed", "labeled", "edited", "assigned", "review_requested"]) {
      const body = JSON.stringify(prPayload({ action }));
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, ignored: true });
    }
    expect(enqueueReviewJob).not.toHaveBeenCalled();
  });

  it("4b. a merged closed PR appends one idempotent merge-stage Change Record event", async () => {
    const body = JSON.stringify(prPayload({ action: "closed", merged: true }));
    const res = await POST(makeRequest(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, merged: true });
    expect(enqueueReviewJob).not.toHaveBeenCalled();
    expect(recordReviewEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        repo: "ada/widgets",
        prNumber: 42,
        deliveryId: DELIVERY_ID,
        eventType: "merged",
      })
    );
    expect(findOrCreateChangeRecord).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      repo: "ada/widgets",
      prNumber: 42,
      headShas: ["abc123def4567890"],
      mergedSha: "merge-sha-1",
      state: "merged",
    });
    expect(appendChangeRecordEvent).toHaveBeenCalledWith({
      recordId: "change-1",
      eventKey: "merge:pr:42:merged",
      stage: "merge",
      actor: "github-webhook",
      payloadRef: {
        kind: "merge",
        repo: "ada/widgets",
        prNumber: 42,
        url: "https://github.com/ada/widgets/pull/42",
        mergeCommitSha: "merge-sha-1",
        outcome: "merged",
      },
    });
  });

  // ---------------------------------------------------------------------
  // 5. draft PR skip rule
  // ---------------------------------------------------------------------

  it("5. draft PR (draft===true) with action opened/reopened/synchronize -> 200 ignored", async () => {
    for (const action of ["opened", "reopened", "synchronize"]) {
      const body = JSON.stringify(prPayload({ action, draft: true }));
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, ignored: true });
    }
    expect(enqueueReviewJob).not.toHaveBeenCalled();
  });

  it("5b. a draft PR's ready_for_review action is NEVER draft-gated — it proceeds to enqueue", async () => {
    const body = JSON.stringify(prPayload({ action: "ready_for_review", draft: true }));
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(enqueueReviewJob).toHaveBeenCalledTimes(1);
  });

  it("5c. a non-draft PR (draft===false) is never skipped by the draft rule", async () => {
    for (const action of ["opened", "reopened", "synchronize"]) {
      vi.mocked(enqueueReviewJob).mockClear();
      const body = JSON.stringify(prPayload({ action, draft: false }));
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(200);
      expect(enqueueReviewJob).toHaveBeenCalledTimes(1);
    }
  });

  // ---------------------------------------------------------------------
  // 6. unknown installation.id (no workspace) -> 200 ignored
  // ---------------------------------------------------------------------

  it("6a. installation.id resolves to no workspace -> 200 ignored, never checks the repo or enrollment", async () => {
    vi.mocked(getWorkspaceByGithubInstallationId).mockResolvedValue(null);
    const body = JSON.stringify(prPayload());
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(getRepositoryByName).not.toHaveBeenCalled();
    expect(enqueueReviewJob).not.toHaveBeenCalled();
  });

  it("6b. payload carries no installation object at all -> 200 ignored without calling the DB", async () => {
    const body = JSON.stringify(prPayload({ omitInstallation: true }));
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(getWorkspaceByGithubInstallationId).not.toHaveBeenCalled();
  });

  it("6c. resolves the workspace using the numeric installation.id straight off the payload", async () => {
    const body = JSON.stringify(prPayload({ installationId: 424242 }));
    await POST(makeRequest(body));
    expect(getWorkspaceByGithubInstallationId).toHaveBeenCalledWith(424242);
  });

  // ---------------------------------------------------------------------
  // 7. rollout gate — REVIEWER_OF_RECORD_WORKSPACES
  // ---------------------------------------------------------------------

  it("7a. workspace resolved but not in REVIEWER_OF_RECORD_WORKSPACES -> 200 {ok:true, ignored:true, reason:'not enrolled'}", async () => {
    process.env[ENROLL_ENV] = "some-other-workspace";
    const body = JSON.stringify(prPayload());
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true, reason: "not enrolled" });
    expect(getRepositoryByName).not.toHaveBeenCalled();
    expect(enqueueReviewJob).not.toHaveBeenCalled();
  });

  it("7b. unset REVIEWER_OF_RECORD_WORKSPACES disables intake for every workspace", async () => {
    delete process.env[ENROLL_ENV];
    const body = JSON.stringify(prPayload());
    const res = await POST(makeRequest(body));
    expect(await res.json()).toEqual({ ok: true, ignored: true, reason: "not enrolled" });
  });

  it("7c. empty-string REVIEWER_OF_RECORD_WORKSPACES disables intake for every workspace", async () => {
    process.env[ENROLL_ENV] = "";
    const body = JSON.stringify(prPayload());
    const res = await POST(makeRequest(body));
    expect(await res.json()).toEqual({ ok: true, ignored: true, reason: "not enrolled" });
  });

  it("7d. matches a workspace id among several comma-separated, untrimmed entries", async () => {
    process.env[ENROLL_ENV] = " some-ws , ws-1 ,another-ws ";
    const body = JSON.stringify(prPayload());
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(enqueueReviewJob).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------
  // 8. repo not connected to the workspace -> 200 ignored
  // ---------------------------------------------------------------------

  it("8. repository.full_name not connected to the workspace (getRepositoryByName -> null) -> 200 ignored", async () => {
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
    const body = JSON.stringify(prPayload({ repoFullName: "someone/else" }));
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(getRepositoryByName).toHaveBeenCalledWith(WORKSPACE_ID, "someone/else");
    expect(enqueueReviewJob).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // 9. happy path — enqueue + dedupe/supersede pass-through
  // ---------------------------------------------------------------------

  it("9a. happy path enqueues with headSha = pull_request.head.sha and returns ok/enqueued/deduped/superseded", async () => {
    vi.mocked(enqueueReviewJob).mockResolvedValue({
      id: "job-1",
      deduped: false,
      superseded: 0,
    } as never);
    const body = JSON.stringify(
      prPayload({ headSha: "deadbeef1234", prNumber: 7, repoFullName: "ada/widgets" })
    );
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(enqueueReviewJob).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      repo: "ada/widgets",
      prNumber: 7,
      headSha: "deadbeef1234",
      event: "opened",
    });
    expect(recordReviewEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        repo: "ada/widgets",
        prNumber: 7,
        deliveryId: DELIVERY_ID,
        eventType: "opened",
        headSha: "deadbeef1234",
      })
    );
    expect(await res.json()).toEqual({
      ok: true,
      enqueued: true,
      deduped: false,
      superseded: 0,
    });
  });

  it("9b. a replayed delivery comes back deduped:true, still 200", async () => {
    vi.mocked(enqueueReviewJob).mockResolvedValue({
      id: "job-1",
      deduped: true,
      superseded: 0,
    } as never);
    const body = JSON.stringify(prPayload());
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      enqueued: true,
      deduped: true,
      superseded: 0,
    });
  });

  it("9c. a push that supersedes an older queued job surfaces superseded > 0", async () => {
    vi.mocked(enqueueReviewJob).mockResolvedValue({
      id: "job-2",
      deduped: false,
      superseded: 1,
    } as never);
    const body = JSON.stringify(prPayload({ action: "synchronize", headSha: "newsha" }));
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      enqueued: true,
      deduped: false,
      superseded: 1,
    });
  });

  it("9d. passes the pull_request action through as the job's event field (synchronize)", async () => {
    const body = JSON.stringify(prPayload({ action: "synchronize" }));
    await POST(makeRequest(body));
    expect(enqueueReviewJob).toHaveBeenCalledWith(
      expect.objectContaining({ event: "synchronize" })
    );
    expect(recordReviewEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "head_updated", deliveryId: DELIVERY_ID })
    );
  });

  it("9e. pull_request_review submitted records the review ledger and stops after acking", async () => {
    const payload = JSON.stringify({
      action: "submitted",
      review: {
        state: "approved",
        submitted_at: "2026-08-01T11:00:00Z",
        user: { type: "User" },
      },
      pull_request: {
        number: 42,
        draft: false,
        head: { sha: "abc123def4567890" },
        created_at: "2026-08-01T09:00:00Z",
        additions: 1,
        deletions: 2,
        changed_files: 3,
      },
      repository: { full_name: "ada/widgets" },
      installation: { id: 999 },
      sender: { type: "User" },
    });
    const res = await POST(makeRequest(payload, { event: "pull_request_review" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: true });
    expect(recordReviewEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        repo: "ada/widgets",
        prNumber: 42,
        deliveryId: DELIVERY_ID,
        eventType: "review_submitted",
        reviewState: "approved",
        headSha: "abc123def4567890",
      })
    );
    expect(enqueueReviewJob).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // 10. malformed JSON after a valid signature -> 200 ignored, never an error
  // ---------------------------------------------------------------------

  it("10. malformed JSON body (still HMAC-valid over the raw bytes) -> 200 ignored, no DB calls", async () => {
    const body = "{not valid json";
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(getWorkspaceByGithubInstallationId).not.toHaveBeenCalled();
    expect(enqueueReviewJob).not.toHaveBeenCalled();
  });

  it("10b. syntactically valid JSON missing pull_request/installation/repository shape never throws — 200 ignored", async () => {
    const body = JSON.stringify({ action: "opened" });
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
  });
});
