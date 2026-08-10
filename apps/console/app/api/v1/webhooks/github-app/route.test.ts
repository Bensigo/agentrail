import { createHmac } from "crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  advanceConfirmedAcceptanceRecordPullRequestHead: vi.fn(),
  getWorkspaceByGithubInstallationId: vi.fn(),
  getRepositoryByName: vi.fn(),
  appendChangeRecordEvent: vi.fn(),
  findOrCreateChangeRecord: vi.fn(),
  invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent: vi.fn(),
  readChangeRecordByPr: vi.fn(),
  recordReviewEvent: vi.fn(),
}));
import { POST } from "./route";
import {
  advanceConfirmedAcceptanceRecordPullRequestHead,
  getWorkspaceByGithubInstallationId,
  getRepositoryByName,
  appendChangeRecordEvent,
  findOrCreateChangeRecord,
  invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent,
  readChangeRecordByPr,
  recordReviewEvent,
} from "@agentrail/db-postgres";

// --- fixtures ---------------------------------------------------------------

const SECRET_ENV = "GITHUB_APP_WEBHOOK_SECRET";
const ENROLL_ENV = "REVIEWER_OF_RECORD_WORKSPACES";
const SECRET = "gh-app-webhook-secret-abc123";
const ORIGINAL_SECRET = process.env[SECRET_ENV];
const ORIGINAL_ENROLL = process.env[ENROLL_ENV];
const DELIVERY_ID = "gh-delivery-1";
const DEFAULT_HEAD_SHA = "a".repeat(40);

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
    htmlUrl?: string | null;
    acceptanceRecordMarker?: string | null;
    beforeHeadSha?: string | null;
    afterHeadSha?: string | null;
  } = {}
): Record<string, unknown> {
  const {
    action = "opened",
    draft = false,
    headSha = DEFAULT_HEAD_SHA,
    prNumber = 42,
    repoFullName = "ada/widgets",
    installationId = 999,
    omitInstallation = false,
    merged = false,
    mergeCommitSha = "merge-sha-1",
    acceptanceRecordMarker = "11111111-1111-4111-8111-111111111111",
  } = opts;
  const htmlUrl = opts.htmlUrl === undefined
    ? `https://github.com/${repoFullName}/pull/${prNumber}`
    : opts.htmlUrl;
  const beforeHeadSha = opts.beforeHeadSha === undefined
    ? "0".repeat(40)
    : opts.beforeHeadSha;
  const afterHeadSha = opts.afterHeadSha === undefined
    ? headSha
    : opts.afterHeadSha;
  return {
    action,
    number: prNumber,
    ...(action === "synchronize"
      ? {
          ...(beforeHeadSha == null ? {} : { before: beforeHeadSha }),
          ...(afterHeadSha == null ? {} : { after: afterHeadSha }),
        }
      : {}),
    pull_request: {
      number: prNumber,
      draft,
      head: { sha: headSha },
      merged,
      merge_commit_sha: mergeCommitSha,
      ...(htmlUrl == null ? {} : { html_url: htmlUrl }),
      body: acceptanceRecordMarker == null ? null : `<!-- jace-acceptance-record: ${acceptanceRecordMarker} -->`,
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
  vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockResolvedValue({
    kind: "advanced",
    record: { id: "11111111-1111-4111-8111-111111111111" },
    jobId: "job-1",
    jobAdmitted: true,
    deduped: false,
    superseded: 0,
    previousHeadSha: null,
    headChanged: true,
  } as never);
  vi.mocked(findOrCreateChangeRecord).mockResolvedValue({ id: "change-1" } as never);
  vi.mocked(invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent).mockResolvedValue({
    kind: "invalidated",
    inserted: true,
    provenanceEventId: "terminal-event-1",
    superseded: 1,
    previewBootsTornDown: 2,
    currentHeadSha: DEFAULT_HEAD_SHA,
    currentHeadCycleId: "job-1",
  } as never);
  vi.mocked(readChangeRecordByPr).mockResolvedValue(null as never);
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
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
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

  it("2d. a signed delivery without a bounded carrier id is acknowledged but never admitted", async () => {
    const body = JSON.stringify(prPayload());
    const res = await POST(makeRequest(body, { deliveryId: null }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      ignored: true,
      reason: "invalid delivery id",
    });
    expect(getWorkspaceByGithubInstallationId).not.toHaveBeenCalled();
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
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
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // 4. pull_request action outside the trigger set -> 200 ignored
  // ---------------------------------------------------------------------

  it("4. pull_request action outside opened|ready_for_review|reopened|synchronize|closed -> 200 ignored", async () => {
    for (const action of ["labeled", "edited", "assigned", "review_requested"]) {
      const body = JSON.stringify(prPayload({ action }));
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, ignored: true });
    }
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
  });

  it("4b. a merged closed PR appends one idempotent merge-stage Change Record event", async () => {
    const body = JSON.stringify(prPayload({ action: "closed", merged: true }));
    const res = await POST(makeRequest(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      merged: true,
      invalidated: false,
      superseded: 0,
      previewBootsTornDown: 0,
    });
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
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
      headShas: [DEFAULT_HEAD_SHA],
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
    expect(invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent).not.toHaveBeenCalled();
  });

  it("4c. a non-merged close invalidates the attached cycle and admits no job", async () => {
    vi.mocked(readChangeRecordByPr).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
    } as never);
    const body = JSON.stringify(prPayload({ action: "closed", merged: false }));

    const res = await POST(makeRequest(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      closed: true,
      invalidated: true,
      superseded: 1,
      previewBootsTornDown: 2,
    });
    expect(invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      recordId: "11111111-1111-4111-8111-111111111111",
      repo: "ada/widgets",
      prNumber: 42,
      headSha: DEFAULT_HEAD_SHA,
      event: "closed",
      deliveryId: DELIVERY_ID,
      source: "github_webhook",
    });
    expect(recordReviewEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "closed", headSha: DEFAULT_HEAD_SHA })
    );
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
    expect(findOrCreateChangeRecord).not.toHaveBeenCalled();
  });

  it("4d. an attached merge invalidates without promoting the observed terminal head", async () => {
    vi.mocked(readChangeRecordByPr).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
    } as never);
    const observedHead = "b".repeat(40);
    const body = JSON.stringify(prPayload({
      action: "closed",
      merged: true,
      headSha: observedHead,
    }));

    const res = await POST(makeRequest(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({
      merged: true,
      invalidated: true,
      superseded: 1,
      previewBootsTornDown: 2,
    }));
    expect(invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: "11111111-1111-4111-8111-111111111111",
        headSha: observedHead,
        event: "merged",
      })
    );
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // 5. draft PR custody without premature review admission
  // ---------------------------------------------------------------------

  it("5. draft opened/reopened deliveries maintain custody without admitting a job", async () => {
    for (const action of ["opened", "reopened"]) {
      vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockResolvedValueOnce({
        kind: "advanced",
        record: { id: "11111111-1111-4111-8111-111111111111" },
        jobId: "job-draft",
        jobAdmitted: false,
        deduped: false,
        superseded: 0,
        previousHeadSha: null,
        headChanged: true,
      } as never);
      const body = JSON.stringify(prPayload({ action, draft: true }));
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(expect.objectContaining({
        ok: true,
        enqueued: false,
      }));
      expect(advanceConfirmedAcceptanceRecordPullRequestHead).toHaveBeenLastCalledWith(
        expect.objectContaining({ admitReviewJob: false })
      );
    }
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).toHaveBeenCalledTimes(2);
  });

  it("5a0. a draft reopened at a different head fail-closes as blocked rather than leaving old work live", async () => {
    vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockResolvedValueOnce({
      kind: "stale_delivery",
      superseded: 1,
    } as never);
    const body = JSON.stringify(prPayload({
      action: "reopened",
      draft: true,
      headSha: "b".repeat(40),
    }));

    const response = await POST(makeRequest(body));

    expect(await response.json()).toEqual({
      ok: true,
      ignored: true,
      enqueued: false,
      blocked: true,
      reason: "stale delivery; current head requires reconciliation",
      superseded: 1,
    });
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "reopened",
        admitReviewJob: false,
        headTransition: null,
      })
    );
  });

  it("5a. draft synchronize advances and invalidates the head without admitting a review job", async () => {
    vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockResolvedValueOnce({
      kind: "advanced",
      record: { id: "11111111-1111-4111-8111-111111111111" },
      jobId: "job-2",
      jobAdmitted: false,
      deduped: false,
      superseded: 1,
      previousHeadSha: "a".repeat(40),
      headChanged: true,
    } as never);
    const body = JSON.stringify(prPayload({
      action: "synchronize",
      draft: true,
      beforeHeadSha: "a".repeat(40),
      headSha: "b".repeat(40),
    }));

    const res = await POST(makeRequest(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      enqueued: false,
      deduped: false,
      superseded: 1,
      headChanged: true,
      previousHeadSha: "a".repeat(40),
    });
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).toHaveBeenCalledWith(
      expect.objectContaining({
        headSha: "b".repeat(40),
        admitReviewJob: false,
        headTransition: {
          beforeHeadSha: "a".repeat(40),
          afterHeadSha: "b".repeat(40),
        },
      })
    );
  });

  it("5b. a draft PR's ready_for_review action is NEVER draft-gated — it proceeds to enqueue", async () => {
    const body = JSON.stringify(prPayload({ action: "ready_for_review", draft: true }));
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({ enqueued: true }));
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).toHaveBeenCalledTimes(1);
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).toHaveBeenCalledWith(
      expect.objectContaining({ admitReviewJob: true, headTransition: null })
    );
  });

  it("5c. non-draft trigger actions admit their exact review job", async () => {
    for (const action of ["opened", "reopened", "synchronize"]) {
      vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockClear();
      const body = JSON.stringify(prPayload({ action, draft: false }));
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(200);
      expect(advanceConfirmedAcceptanceRecordPullRequestHead).toHaveBeenCalledTimes(1);
      expect(advanceConfirmedAcceptanceRecordPullRequestHead).toHaveBeenCalledWith(
        expect.objectContaining({ admitReviewJob: true })
      );
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
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
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
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
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
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).toHaveBeenCalledTimes(1);
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
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // 9. happy path — enqueue + dedupe/supersede pass-through
  // ---------------------------------------------------------------------

  it("9a. atomically advances the signed head and enqueues without separate attach/queue calls", async () => {
    vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockResolvedValue({
      kind: "advanced",
      record: { id: "11111111-1111-4111-8111-111111111111" },
      jobId: "job-1",
      jobAdmitted: true,
      deduped: false,
      superseded: 0,
      previewBootsTornDown: 0,
      previousHeadSha: null,
      headChanged: true,
    } as never);
    const body = JSON.stringify(
      prPayload({ headSha: "d".repeat(40), prNumber: 7, repoFullName: "ada/widgets" })
    );
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).toHaveBeenCalledTimes(1);
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      recordId: "11111111-1111-4111-8111-111111111111",
      repo: "ada/widgets",
      prNumber: 7,
      headSha: "d".repeat(40),
      event: "opened",
      deliveryId: DELIVERY_ID,
      headTransition: null,
      admitReviewJob: true,
      source: "github_webhook",
      prUrl: "https://github.com/ada/widgets/pull/7",
    });
    expect(recordReviewEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        repo: "ada/widgets",
        prNumber: 7,
        deliveryId: DELIVERY_ID,
        eventType: "opened",
        headSha: "d".repeat(40),
      })
    );
    expect(await res.json()).toEqual({
      ok: true,
      enqueued: true,
      deduped: false,
      superseded: 0,
      previewBootsTornDown: 0,
      headChanged: true,
      previousHeadSha: null,
    });
  });

  it("9f. missing, malformed, or duplicate Record markers fail closed before a review job is enqueued", async () => {
    for (const acceptanceRecordMarker of [null, "not-a-record", "11111111-1111-4111-8111-111111111111 --><!-- jace-acceptance-record: 22222222-2222-4222-8222-222222222222"]) {
      vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockClear();
      const body = JSON.stringify(prPayload({ acceptanceRecordMarker }));
      const res = await POST(makeRequest(body));
      expect(await res.json()).toEqual(expect.objectContaining({ ok: true, ignored: true }));
      expect(advanceConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
    }
  });

  it("9f2. an existing PR binding wins when a later sync omits, corrupts, or changes the marker", async () => {
    vi.mocked(readChangeRecordByPr).mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
    } as never);
    for (const acceptanceRecordMarker of [
      null,
      "not-a-record",
      "33333333-3333-4333-8333-333333333333",
    ]) {
      vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockClear();
      const body = JSON.stringify(prPayload({
        action: "synchronize",
        beforeHeadSha: "a".repeat(40),
        headSha: "b".repeat(40),
        acceptanceRecordMarker,
      }));

      const response = await POST(makeRequest(body));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expect.objectContaining({
        enqueued: true,
      }));
      expect(advanceConfirmedAcceptanceRecordPullRequestHead).toHaveBeenCalledWith(
        expect.objectContaining({
          recordId: "22222222-2222-4222-8222-222222222222",
          headSha: "b".repeat(40),
        })
      );
    }
  });

  it("9g. a foreign, unconfirmed, or already-attached Record marker never enqueues a review", async () => {
    for (const kind of ["not_found", "not_confirmed", "already_attached"] as const) {
      vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockResolvedValueOnce({ kind } as never);
      const body = JSON.stringify(prPayload());
      const res = await POST(makeRequest(body));
      expect(await res.json()).toEqual({ ok: true, ignored: true, reason: `acceptance record ${kind}` });
    }
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).toHaveBeenCalledTimes(3);
  });

  it("9b. a same-head replay is atomically deduped without changing the current head", async () => {
    vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockResolvedValue({
      kind: "advanced",
      record: { id: "11111111-1111-4111-8111-111111111111" },
      jobId: "job-1",
      jobAdmitted: true,
      deduped: true,
      superseded: 0,
      previousHeadSha: DEFAULT_HEAD_SHA,
      headChanged: false,
    } as never);
    const body = JSON.stringify(prPayload());
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      enqueued: true,
      deduped: true,
      superseded: 0,
      headChanged: false,
      previousHeadSha: DEFAULT_HEAD_SHA,
    });
  });

  it("9c. a new signed head reports the superseded job and prior current head", async () => {
    vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockResolvedValue({
      kind: "advanced",
      record: { id: "11111111-1111-4111-8111-111111111111" },
      jobId: "job-2",
      jobAdmitted: true,
      deduped: false,
      superseded: 1,
      previousHeadSha: "oldsha",
      headChanged: true,
    } as never);
    const body = JSON.stringify(
      prPayload({ action: "synchronize", headSha: "b".repeat(40) })
    );
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      enqueued: true,
      deduped: false,
      superseded: 1,
      headChanged: true,
      previousHeadSha: "oldsha",
    });
  });

  it("9d. passes the pull_request action through as the job's event field (synchronize)", async () => {
    const body = JSON.stringify(prPayload({ action: "synchronize" }));
    await POST(makeRequest(body));
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "synchronize",
        headTransition: {
          beforeHeadSha: "0".repeat(40),
          afterHeadSha: DEFAULT_HEAD_SHA,
        },
      })
    );
    expect(recordReviewEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "head_updated", deliveryId: DELIVERY_ID })
    );
  });

  it("9d2. rejects missing, malformed, or head-mismatched signed synchronize transitions", async () => {
    const headSha = "a".repeat(40);
    const cases = [
      { beforeHeadSha: null },
      { afterHeadSha: null },
      { beforeHeadSha: "not-a-sha" },
      { afterHeadSha: "not-a-sha" },
      { afterHeadSha: "b".repeat(40) },
    ];
    for (const transition of cases) {
      vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockClear();
      const body = JSON.stringify(
        prPayload({ action: "synchronize", headSha, ...transition })
      );
      const response = await POST(makeRequest(body));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        ignored: true,
        reason: "invalid head transition",
      });
      expect(advanceConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
    }
    expect(getWorkspaceByGithubInstallationId).not.toHaveBeenCalled();
    expect(getRepositoryByName).not.toHaveBeenCalled();
  });

  it("9d2b. rejects a short head, invalid PR number, or mismatched canonical URL before DB", async () => {
    const shortHead = await POST(makeRequest(JSON.stringify(
      prPayload({ headSha: "deadbeef" })
    )));
    expect(await shortHead.json()).toEqual({ ok: true, ignored: true });

    for (const prNumber of [0, 1.5]) {
      const invalidNumber = await POST(makeRequest(JSON.stringify(
        prPayload({ prNumber })
      )));
      expect(await invalidNumber.json()).toEqual({ ok: true, ignored: true });
    }

    const mismatchedUrl = await POST(makeRequest(JSON.stringify(
      prPayload({ htmlUrl: "https://github.com/ada/widgets/pull/999" })
    )));
    expect(await mismatchedUrl.json()).toEqual({
      ok: true,
      ignored: true,
      reason: "invalid pull request URL",
    });

    expect(getWorkspaceByGithubInstallationId).not.toHaveBeenCalled();
    expect(getRepositoryByName).not.toHaveBeenCalled();
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
  });

  it("9d3. treats a delayed old-head delivery as stale without reporting an enqueue", async () => {
    vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockResolvedValueOnce({
      kind: "stale_delivery",
      superseded: 1,
    } as never);
    const body = JSON.stringify(
      prPayload({
        action: "synchronize",
        beforeHeadSha: "0".repeat(40),
        headSha: "a".repeat(40),
      })
    );

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      ignored: true,
      enqueued: false,
      blocked: true,
      reason: "stale delivery; current head requires reconciliation",
      superseded: 1,
    });
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).toHaveBeenCalledOnce();
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
        head: { sha: DEFAULT_HEAD_SHA },
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
        headSha: DEFAULT_HEAD_SHA,
      })
    );
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
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
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
  });

  it("10b. syntactically valid JSON missing pull_request/installation/repository shape never throws — 200 ignored", async () => {
    const body = JSON.stringify({ action: "opened" });
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
  });
});
