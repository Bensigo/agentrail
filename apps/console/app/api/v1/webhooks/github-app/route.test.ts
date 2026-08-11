import { createHmac } from "crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  SignedAcceptanceRecordMergeConflictError: class SignedAcceptanceRecordMergeConflictError extends Error {},
  advanceConfirmedAcceptanceRecordPullRequestHead: vi.fn(),
  reconcileConfirmedAcceptanceRecordPullRequestHead: vi.fn(),
  getWorkspaceByGithubInstallationId: vi.fn(),
  getInstallationToken: vi.fn(),
  getRepositoryByName: vi.fn(),
  invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent: vi.fn(),
  readChangeRecordByPr: vi.fn(),
  recordSignedAcceptanceRecordMerge: vi.fn(),
  recordReviewEvent: vi.fn(),
}));
vi.mock("../../../../../lib/github-current-pr", () => ({
  readCurrentGithubPullRequest: vi.fn(),
}));
import { POST } from "./route";
import {
  SignedAcceptanceRecordMergeConflictError,
  advanceConfirmedAcceptanceRecordPullRequestHead,
  reconcileConfirmedAcceptanceRecordPullRequestHead,
  getWorkspaceByGithubInstallationId,
  getInstallationToken,
  getRepositoryByName,
  invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent,
  readChangeRecordByPr,
  recordSignedAcceptanceRecordMerge,
  recordReviewEvent,
} from "@agentrail/db-postgres";
import { readCurrentGithubPullRequest } from "../../../../../lib/github-current-pr";

// --- fixtures ---------------------------------------------------------------

const SECRET_ENV = "GITHUB_APP_WEBHOOK_SECRET";
const ENROLL_ENV = "REVIEWER_OF_RECORD_WORKSPACES";
const SECRET = "gh-app-webhook-secret-abc123";
const ORIGINAL_SECRET = process.env[SECRET_ENV];
const ORIGINAL_ENROLL = process.env[ENROLL_ENV];
const DELIVERY_ID = "gh-delivery-1";
const DEFAULT_HEAD_SHA = "a".repeat(40);
const DEFAULT_BASE_SHA = "b".repeat(40);
const DEFAULT_MERGE_SHA = "c".repeat(40);
const MERGED_AT = "2026-08-11T08:30:00Z";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
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
    baseSha?: string | null;
    mergeCommitSha?: string | null;
    mergedAt?: string | null;
    htmlUrl?: string | null;
    senderId?: number | null;
    senderLogin?: string | null;
    senderType?: string | null;
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
    baseSha = DEFAULT_BASE_SHA,
    mergeCommitSha = DEFAULT_MERGE_SHA,
    mergedAt = MERGED_AT,
    senderId = 1234,
    senderLogin = "ada",
    senderType = "User",
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
      ...(baseSha == null ? {} : { base: { sha: baseSha } }),
      merged,
      ...(mergeCommitSha == null ? {} : { merge_commit_sha: mergeCommitSha }),
      ...(mergedAt == null ? {} : { merged_at: mergedAt }),
      ...(htmlUrl == null ? {} : { html_url: htmlUrl }),
      body: acceptanceRecordMarker == null ? null : `<!-- jace-acceptance-record: ${acceptanceRecordMarker} -->`,
    },
    repository: { full_name: repoFullName },
    ...(omitInstallation ? {} : { installation: { id: installationId } }),
    sender: {
      ...(senderId == null ? {} : { id: senderId }),
      ...(senderLogin == null ? {} : { login: senderLogin }),
      ...(senderType == null ? {} : { type: senderType }),
    },
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
  vi.mocked(getInstallationToken).mockResolvedValue(null);
  vi.mocked(readCurrentGithubPullRequest).mockResolvedValue({
    ok: false,
    kind: "not_proven",
    reason: "github_unavailable",
  });
  vi.mocked(invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent).mockResolvedValue({
    kind: "invalidated",
    inserted: true,
    provenanceEventId: "terminal-event-1",
    superseded: 1,
    previewBootsTornDown: 2,
    currentHeadSha: DEFAULT_HEAD_SHA,
    currentHeadCycleId: "job-1",
    authorityGeneration: 2,
    currentAuthoritative: false,
  } as never);
  vi.mocked(readChangeRecordByPr).mockResolvedValue(null as never);
  vi.mocked(recordSignedAcceptanceRecordMerge).mockResolvedValue({
    kind: "recorded",
    mergeEventId: "merge-event-1",
    deliveryEventId: "delivery-event-1",
    decisionAlignment: {
      kind: "aligned",
      decision: "approved",
      decisionEventId: "decision-event-1",
      binding: {},
    },
    superseded: 1,
    previewBootsTornDown: 2,
    correctionDispatchesInvalidated: 1,
  } as never);
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

  it("4b. records one canonical signed merge transaction for an attached Acceptance Record", async () => {
    vi.mocked(readChangeRecordByPr).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
    } as never);
    const body = JSON.stringify(prPayload({ action: "closed", merged: true }));
    const res = await POST(makeRequest(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      merged: true,
      recorded: true,
      acceptanceOutcomeRecorded: true,
      kind: "recorded",
      decisionAlignment: "aligned",
      superseded: 1,
      previewBootsTornDown: 2,
    });
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
    expect(recordSignedAcceptanceRecordMerge).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      recordId: "11111111-1111-4111-8111-111111111111",
      repo: "ada/widgets",
      prNumber: 42,
      deliveryId: DELIVERY_ID,
      headSha: DEFAULT_HEAD_SHA,
      baseSha: DEFAULT_BASE_SHA,
      mergeSha: DEFAULT_MERGE_SHA,
      mergedAt: new Date(MERGED_AT),
      prUrl: "https://github.com/ada/widgets/pull/42",
      githubActor: { id: 1234, login: "ada", type: "User" },
      source: "github_webhook",
    });
    expect(invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent).not.toHaveBeenCalled();
    expect(recordReviewEvent).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      repo: "ada/widgets",
      prNumber: 42,
      deliveryId: DELIVERY_ID,
      eventType: "merged",
      occurredAt: new Date(MERGED_AT),
      headSha: DEFAULT_HEAD_SHA,
    }));
  });

  it("4b1. keeps an unattached signed merge metrics-only without fabricating Record custody", async () => {
    const response = await POST(makeRequest(JSON.stringify(prPayload({
      action: "closed",
      merged: true,
    }))));

    expect(await response.json()).toEqual({
      ok: true,
      ignored: true,
      merged: true,
      recorded: false,
      reason: "acceptance record missing",
    });
    expect(recordReviewEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "merged",
      occurredAt: new Date(MERGED_AT),
      headSha: DEFAULT_HEAD_SHA,
    }));
    expect(recordSignedAcceptanceRecordMerge).not.toHaveBeenCalled();
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
    expect(recordSignedAcceptanceRecordMerge).not.toHaveBeenCalled();
  });

  it("4d. invalid signed merge metadata revokes authority without recording canonical merge custody", async () => {
    vi.mocked(readChangeRecordByPr).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
    } as never);
    const observedHead = "b".repeat(40);
    const body = JSON.stringify(prPayload({
      action: "closed",
      merged: true,
      headSha: observedHead,
      baseSha: null,
    }));

    const res = await POST(makeRequest(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      ignored: true,
      merged: true,
      recorded: false,
      reason: "invalid signed merge metadata",
      invalidated: true,
      superseded: 1,
      previewBootsTornDown: 2,
    });
    expect(invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: "11111111-1111-4111-8111-111111111111",
        headSha: observedHead,
        event: "merged",
      })
    );
    expect(recordSignedAcceptanceRecordMerge).not.toHaveBeenCalled();
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
  });

  it.each([
    [{ mergeCommitSha: null }, "missing merge SHA"],
    [{ mergeCommitSha: "not-a-sha" }, "malformed merge SHA"],
    [{ mergeCommitSha: "C".repeat(40) }, "noncanonical merge SHA"],
    [{ baseSha: null }, "missing base SHA"],
    [{ baseSha: "not-a-sha" }, "malformed base SHA"],
    [{ baseSha: "B".repeat(40) }, "noncanonical base SHA"],
    [{ headSha: "A".repeat(40) }, "noncanonical head SHA"],
    [{ mergedAt: null }, "missing merge timestamp"],
    [{ mergedAt: "not-a-timestamp" }, "invalid merge timestamp"],
    [{ htmlUrl: "https://github.com/evil/widgets/pull/42" }, "noncanonical PR URL"],
    [{ senderId: null }, "missing sender id"],
    [{ senderLogin: " ada " }, "noncanonical sender login"],
    [{ senderLogin: "ada_user" }, "unsupported sender login"],
    [{ senderType: "EnterpriseUser" }, "unsupported sender type"],
  ] as const)("4e. %s is terminal-only and never canonical merge evidence (%s)", async (options, _description) => {
    void _description;
    vi.mocked(readChangeRecordByPr).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
    } as never);

    const response = await POST(makeRequest(JSON.stringify(prPayload({
      action: "closed",
      merged: true,
      ...options,
    }))));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      ok: true,
      ignored: true,
      merged: true,
      recorded: false,
      reason: "invalid signed merge metadata",
    }));
    expect(recordSignedAcceptanceRecordMerge).not.toHaveBeenCalled();
    expect(invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent).toHaveBeenCalledOnce();
  });

  it.each([
    ["replayed", "not_recorded"],
    ["recorded", "decision_conflicts_merge"],
    ["recorded", "not_current"],
    ["recorded", "custody_unavailable"],
  ] as const)("4f. reports %s merge custody separately from %s decision alignment", async (
    kind,
    decisionAlignment,
  ) => {
    vi.mocked(readChangeRecordByPr).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
    } as never);
    vi.mocked(recordSignedAcceptanceRecordMerge).mockResolvedValueOnce({
      kind,
      mergeEventId: "merge-event-1",
      deliveryEventId: "delivery-event-1",
      decisionAlignment: { kind: decisionAlignment },
      superseded: 0,
      previewBootsTornDown: 0,
      correctionDispatchesInvalidated: 0,
    } as never);

    const response = await POST(makeRequest(JSON.stringify(prPayload({
      action: "closed",
      merged: true,
    }))));

    expect(await response.json()).toEqual({
      ok: true,
      merged: true,
      recorded: true,
      acceptanceOutcomeRecorded: false,
      kind,
      decisionAlignment,
      superseded: 0,
      previewBootsTornDown: 0,
    });
  });

  it("4g. holds DB conflicts and unavailable storage without claiming canonical merge custody", async () => {
    vi.mocked(readChangeRecordByPr).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
    } as never);
    vi.mocked(recordSignedAcceptanceRecordMerge).mockRejectedValueOnce(
      new SignedAcceptanceRecordMergeConflictError(),
    );
    const conflict = await POST(makeRequest(JSON.stringify(prPayload({
      action: "closed",
      merged: true,
    }))));
    expect(conflict.status).toBe(200);
    expect(await conflict.json()).toEqual({
      ok: true,
      ignored: true,
      merged: true,
      recorded: false,
      invalidated: true,
      reason: "signed merge conflicts with acceptance record custody",
      superseded: 1,
      previewBootsTornDown: 2,
    });

    vi.mocked(recordSignedAcceptanceRecordMerge).mockRejectedValueOnce(
      new Error("postgres://secret@internal/db"),
    );
    const unavailable = await POST(makeRequest(JSON.stringify(prPayload({
      action: "closed",
      merged: true,
    }))));
    expect(unavailable.status).toBe(200);
    const unavailableBody = await unavailable.text();
    expect(JSON.parse(unavailableBody)).toEqual({
      ok: true,
      ignored: true,
      merged: true,
      recorded: false,
      invalidated: true,
      reason: "signed merge custody unavailable",
      superseded: 1,
      previewBootsTornDown: 2,
    });
    expect(unavailableBody).not.toContain("secret");
    expect(invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent)
      .toHaveBeenCalledTimes(2);
  });

  it("4g0. acknowledges a sanitized fail-closed hold when neither merge custody nor terminal invalidation persists", async () => {
    vi.mocked(readChangeRecordByPr).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
    } as never);
    vi.mocked(recordSignedAcceptanceRecordMerge).mockRejectedValueOnce(
      new Error("postgres://merge-secret@internal/db"),
    );
    vi.mocked(invalidateConfirmedAcceptanceRecordPullRequestHeadForTerminalEvent)
      .mockRejectedValueOnce(new Error("postgres://terminal-secret@internal/db"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(makeRequest(JSON.stringify(prPayload({
      action: "closed",
      merged: true,
    }))));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      ok: true,
      ignored: true,
      merged: true,
      recorded: false,
      invalidated: false,
      reason: "signed merge custody unavailable; terminal invalidation unavailable",
    });
    expect(body).not.toMatch(/merge-secret|terminal-secret|postgres/);
    consoleError.mockRestore();
  });

  it.each(["not_found", "not_attached"] as const)(
    "4g1. a transaction-time %s result never becomes canonical merge custody",
    async (kind) => {
      vi.mocked(readChangeRecordByPr).mockResolvedValue({
        id: "11111111-1111-4111-8111-111111111111",
      } as never);
      vi.mocked(recordSignedAcceptanceRecordMerge).mockResolvedValueOnce({ kind });

      const response = await POST(makeRequest(JSON.stringify(prPayload({
        action: "closed",
        merged: true,
      }))));

      expect(await response.json()).toEqual({
        ok: true,
        ignored: true,
        merged: true,
        recorded: false,
        reason: `acceptance record ${kind}`,
      });
    },
  );

  it("4h. best-effort merge metrics failure cannot downgrade canonical signed merge custody", async () => {
    vi.mocked(readChangeRecordByPr).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
    } as never);
    vi.mocked(recordReviewEvent).mockRejectedValueOnce(new Error("metrics unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(makeRequest(JSON.stringify(prPayload({
      action: "closed",
      merged: true,
    }))));

    expect(await response.json()).toEqual(expect.objectContaining({
      ok: true,
      merged: true,
      recorded: true,
      kind: "recorded",
    }));
    expect(recordSignedAcceptanceRecordMerge).toHaveBeenCalledOnce();
    consoleError.mockRestore();
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
      provenanceEventId: "held-draft",
      blockedHeadSha: "a".repeat(40),
      blockedCycleId: "cycle-old",
      authorityGeneration: 7,
      superseded: 1,
      previewBootsTornDown: 0,
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
      reason: "GitHub reconciliation is unavailable",
      superseded: 1,
    });
    expect(readCurrentGithubPullRequest).not.toHaveBeenCalled();
    expect(advanceConfirmedAcceptanceRecordPullRequestHead).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "reopened",
        admitReviewJob: false,
        headTransition: null,
      })
    );
  });

  it("5a0r. a replayed delivery is acknowledged as deduped without minting a token or reading GitHub", async () => {
    vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockResolvedValueOnce({
      kind: "delivery_replayed",
      currentAuthoritative: true,
    } as never);

    const response = await POST(makeRequest(JSON.stringify(prPayload({ action: "reopened" }))));

    expect(await response.json()).toEqual({
      ok: true, enqueued: false, deduped: true, replayed: true, blocked: false,
    });
    expect(getInstallationToken).not.toHaveBeenCalled();
    expect(readCurrentGithubPullRequest).not.toHaveBeenCalled();
    expect(reconcileConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
  });

  it("5a0a. an authenticated current GitHub read reconciles only its exact blocked tuple, without exposing its token", async () => {
    const token = "ghs-never-return-this";
    const blockedHeadSha = "a".repeat(40);
    const currentHeadSha = "b".repeat(40);
    vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockResolvedValueOnce({
      kind: "stale_delivery",
      provenanceEventId: "held-event-1",
      blockedHeadSha,
      blockedCycleId: "cycle-old",
      authorityGeneration: 7,
      superseded: 1,
      previewBootsTornDown: 0,
    } as never);
    vi.mocked(getInstallationToken).mockResolvedValueOnce(token);
    vi.mocked(readCurrentGithubPullRequest).mockResolvedValueOnce({
      ok: true,
      pullRequest: {
        repo: "ada/widgets",
        prNumber: 42,
        headSha: currentHeadSha,
        baseSha: "c".repeat(40),
        state: "open",
        draft: false,
        merged: false,
        htmlUrl: "https://github.com/ada/widgets/pull/42",
      },
    });
    vi.mocked(reconcileConfirmedAcceptanceRecordPullRequestHead).mockResolvedValueOnce({
      kind: "reconciled",
      jobAdmitted: true,
    } as never);

    const response = await POST(makeRequest(JSON.stringify(prPayload({
      action: "reopened", headSha: currentHeadSha,
    }))));

    const responseBody = await response.text();
    expect(JSON.parse(responseBody)).toEqual({
      ok: true, reconciled: true, alreadyCurrent: false,
      enqueued: true, blocked: false, superseded: 1,
    });
    expect(responseBody).not.toContain(token);
    expect(getInstallationToken).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(readCurrentGithubPullRequest).toHaveBeenCalledWith({
      token, repo: "ada/widgets", prNumber: 42,
    });
    expect(reconcileConfirmedAcceptanceRecordPullRequestHead).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      recordId: "11111111-1111-4111-8111-111111111111",
      repo: "ada/widgets",
      prNumber: 42,
      expectedBlockedHeadSha: blockedHeadSha,
      expectedBlockedCycleId: "cycle-old",
      expectedBlockedAuthorityGeneration: 7,
      observedHeadSha: currentHeadSha,
      observedBaseSha: "c".repeat(40),
      observedState: "open",
      observedDraft: false,
      observedMerged: false,
      source: "github_app_api",
    });
  });

  it("5a0b. a later signed delivery wins the GitHub-read/DB-commit race without a false blocked claim", async () => {
    vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockResolvedValueOnce({
      kind: "stale_delivery",
      provenanceEventId: "held-event-1",
      blockedHeadSha: "a".repeat(40),
      blockedCycleId: "cycle-old",
      authorityGeneration: 7,
      superseded: 1,
      previewBootsTornDown: 0,
    } as never);
    vi.mocked(getInstallationToken).mockResolvedValueOnce("ghs-token");
    vi.mocked(readCurrentGithubPullRequest).mockResolvedValueOnce({
      ok: true,
      pullRequest: {
        repo: "ada/widgets", prNumber: 42, headSha: "b".repeat(40), baseSha: "c".repeat(40),
        state: "open", draft: false, merged: false, htmlUrl: "https://github.com/ada/widgets/pull/42",
      },
    });
    vi.mocked(reconcileConfirmedAcceptanceRecordPullRequestHead).mockResolvedValueOnce({
      kind: "blocked_precondition_changed",
      currentAuthoritative: true,
    } as never);

    const response = await POST(makeRequest(JSON.stringify(prPayload({ action: "reopened", headSha: "b".repeat(40) }))));

    expect(await response.json()).toEqual({
      ok: true, ignored: true, enqueued: false, reconciled: false, blocked: false,
      reason: "reconciliation precondition changed", superseded: 1,
    });
  });

  it("5a0c. malformed or unavailable current reads remain blocked and never call reconciliation", async () => {
    for (const reason of ["invalid_pr_metadata", "github_unavailable"] as const) {
      vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockResolvedValueOnce({
        kind: "stale_delivery", provenanceEventId: `held-${reason}`,
        blockedHeadSha: "a".repeat(40), blockedCycleId: "cycle-old", authorityGeneration: 7,
        superseded: 0, previewBootsTornDown: 0,
      } as never);
      vi.mocked(getInstallationToken).mockResolvedValueOnce("ghs-token");
      vi.mocked(readCurrentGithubPullRequest).mockResolvedValueOnce({
        ok: false, kind: "not_proven", reason,
      });
      const response = await POST(makeRequest(JSON.stringify(prPayload({ action: "reopened", headSha: "b".repeat(40) }))));
      expect((await response.json()).blocked).toBe(true);
    }
    expect(reconcileConfirmedAcceptanceRecordPullRequestHead).not.toHaveBeenCalled();
  });

  it("5a0d. authenticated closed or merged metadata reaches the DB terminal path and never enqueues", async () => {
    vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockResolvedValueOnce({
      kind: "stale_delivery", provenanceEventId: "held-closed",
      blockedHeadSha: "a".repeat(40), blockedCycleId: "cycle-old", authorityGeneration: 7,
      superseded: 0, previewBootsTornDown: 0,
    } as never);
    vi.mocked(getInstallationToken).mockResolvedValueOnce("ghs-token");
    vi.mocked(readCurrentGithubPullRequest).mockResolvedValueOnce({
      ok: true,
      pullRequest: {
        repo: "ada/widgets", prNumber: 42, headSha: "b".repeat(40), baseSha: "c".repeat(40),
        state: "closed", draft: false, merged: true, htmlUrl: "https://github.com/ada/widgets/pull/42",
      },
    });
    vi.mocked(reconcileConfirmedAcceptanceRecordPullRequestHead).mockResolvedValueOnce({
      kind: "closed", currentAuthoritative: false,
    } as never);

    const response = await POST(makeRequest(JSON.stringify(prPayload({ action: "reopened", headSha: "b".repeat(40) }))));

    expect(await response.json()).toEqual({
      ok: true, ignored: true, enqueued: false, reconciled: false, blocked: true,
      reason: "current pull request is closed or merged", superseded: 0,
    });
    expect(reconcileConfirmedAcceptanceRecordPullRequestHead).toHaveBeenCalledWith(expect.objectContaining({
      observedState: "closed", observedMerged: true,
    }));
  });

  it("5a0e. an authenticated draft head restores custody without claiming a review job", async () => {
    vi.mocked(advanceConfirmedAcceptanceRecordPullRequestHead).mockResolvedValueOnce({
      kind: "stale_delivery", provenanceEventId: "held-draft-reconcile",
      blockedHeadSha: "a".repeat(40), blockedCycleId: "cycle-old", authorityGeneration: 7,
      superseded: 0, previewBootsTornDown: 0,
    } as never);
    vi.mocked(getInstallationToken).mockResolvedValueOnce("ghs-token");
    vi.mocked(readCurrentGithubPullRequest).mockResolvedValueOnce({
      ok: true,
      pullRequest: {
        repo: "ada/widgets", prNumber: 42, headSha: "b".repeat(40), baseSha: "c".repeat(40),
        state: "open", draft: true, merged: false, htmlUrl: "https://github.com/ada/widgets/pull/42",
      },
    });
    vi.mocked(reconcileConfirmedAcceptanceRecordPullRequestHead).mockResolvedValueOnce({
      kind: "reconciled", jobAdmitted: false,
    } as never);

    const response = await POST(makeRequest(JSON.stringify(prPayload({ action: "reopened", headSha: "b".repeat(40) }))));

    expect(await response.json()).toEqual({
      ok: true, reconciled: true, alreadyCurrent: false,
      enqueued: false, blocked: false, superseded: 0,
    });
    expect(reconcileConfirmedAcceptanceRecordPullRequestHead).toHaveBeenCalledWith(expect.objectContaining({
      observedDraft: true,
    }));
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
    process.env[ENROLL_ENV] = ` some-ws , ${WORKSPACE_ID} ,another-ws `;
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
      provenanceEventId: "held-delayed",
      blockedHeadSha: "a".repeat(40),
      blockedCycleId: "cycle-old",
      authorityGeneration: 7,
      superseded: 1,
      previewBootsTornDown: 0,
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
      reason: "GitHub reconciliation is unavailable",
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
