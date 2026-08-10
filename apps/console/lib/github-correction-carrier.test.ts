import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  getGithubCorrectionCarrierCredential: vi.fn(),
  reserveNextGithubCorrectionFindingPublication: vi.fn(),
  reportGithubCorrectionFindingPublication: vi.fn(),
  reserveGithubCorrectionActivation: vi.fn(),
  reportGithubCorrectionActivation: vi.fn(),
}));
vi.mock("./github-correction-carrier-preflight", () => ({ preflightGithubCorrectionCarrier: vi.fn() }));
vi.mock("./github-current-pr", () => ({ readCurrentGithubPullRequest: vi.fn() }));
vi.mock("./github-correction-carrier-comment", () => ({
  postGithubCorrectionCarrierComment: vi.fn(),
  validateDbIssuedGithubCorrectionActivationBody: vi.fn(),
}));

import {
  getGithubCorrectionCarrierCredential,
  reserveNextGithubCorrectionFindingPublication,
  reportGithubCorrectionFindingPublication,
  reserveGithubCorrectionActivation,
  reportGithubCorrectionActivation,
} from "@agentrail/db-postgres";
import { preflightGithubCorrectionCarrier } from "./github-correction-carrier-preflight";
import { readCurrentGithubPullRequest } from "./github-current-pr";
import {
  postGithubCorrectionCarrierComment,
  validateDbIssuedGithubCorrectionActivationBody,
} from "./github-correction-carrier-comment";
import { runGithubCorrectionCarrier } from "./github-correction-carrier";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const DISPATCH_ID = "22222222-2222-4222-8222-222222222222";
const BUNDLE = "eyJraW5kIjoiY29ycmVjdGlvbl9wYWNrZXRfYnVuZGxlIn0";
const SHA = "a".repeat(64);
const ACTIVATION_BODY = `## AgentRail correction activation\n\nBundle: ${BUNDLE}\nSHA-256: ${SHA}\n\n@codex`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(preflightGithubCorrectionCarrier).mockResolvedValue({
    kind: "ready", repo: "acme/widgets", prNumber: 42,
    headSha: "a".repeat(40), baseSha: "b".repeat(40),
  } as never);
  vi.mocked(getGithubCorrectionCarrierCredential).mockResolvedValue({
    ok: true, token: "ghs_scoped",
  } as never);
  vi.mocked(readCurrentGithubPullRequest).mockResolvedValue({
    ok: true,
    pullRequest: {
      repo: "acme/widgets", prNumber: 42,
      headSha: "a".repeat(40), baseSha: "b".repeat(40),
      state: "open", draft: false, merged: false,
      htmlUrl: "https://github.com/acme/widgets/pull/42",
    },
  });
  vi.mocked(reportGithubCorrectionFindingPublication).mockResolvedValue({ kind: "reported" } as never);
  vi.mocked(reportGithubCorrectionActivation).mockResolvedValue({ kind: "reported" } as never);
  vi.mocked(validateDbIssuedGithubCorrectionActivationBody).mockReturnValue(true);
});

describe("runGithubCorrectionCarrier", () => {
  it("publishes every DB-issued ordinary finding before exactly one DB-issued final activation", async () => {
    vi.mocked(reserveNextGithubCorrectionFindingPublication)
      .mockResolvedValueOnce({
        kind: "reserved", publication: { id: "pub-1" }, packet: { packetId: "packet-1" },
        body: "## AgentRail correction finding\n\nordinary human-visible finding",
      } as never)
      .mockResolvedValueOnce({ kind: "complete" } as never);
    vi.mocked(reserveGithubCorrectionActivation).mockResolvedValue({
      kind: "reserved", activation: { id: "activation-1" }, body: ACTIVATION_BODY,
      packetBundleBase64url: BUNDLE, packetBundleSha256: SHA, recipient: "codex",
    } as never);
    vi.mocked(postGithubCorrectionCarrierComment)
      .mockResolvedValueOnce({ kind: "published", commentId: "101", commentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-101", bodySha256: "b".repeat(64) })
      .mockResolvedValueOnce({ kind: "published", commentId: "102", commentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-102", bodySha256: "c".repeat(64) });

    await expect(runGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID }))
      .resolves.toEqual({
        kind: "carrier_accepted", githubCommentId: "102",
        githubCommentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-102",
      });
    expect(reportGithubCorrectionFindingPublication).toHaveBeenCalledWith(expect.objectContaining({
      publicationId: "pub-1",
      outcome: { kind: "published", githubCommentId: "101", githubCommentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-101" },
    }));
    expect(vi.mocked(postGithubCorrectionCarrierComment).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(reportGithubCorrectionFindingPublication).mock.invocationCallOrder[0]!);
    expect(vi.mocked(reportGithubCorrectionFindingPublication).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(reserveGithubCorrectionActivation).mock.invocationCallOrder[0]!);
    expect(validateDbIssuedGithubCorrectionActivationBody).toHaveBeenCalledWith({
      body: ACTIVATION_BODY, recipient: "codex", packetBundleBase64url: BUNDLE, packetBundleSha256: SHA,
    });
    expect(postGithubCorrectionCarrierComment).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "activation", body: ACTIVATION_BODY,
    }));
  });

  it("holds an unknown finding POST outcome and never reserves or posts activation", async () => {
    vi.mocked(reserveNextGithubCorrectionFindingPublication).mockResolvedValue({
      kind: "reserved", publication: { id: "pub-1" }, packet: {}, body: "ordinary finding",
    } as never);
    vi.mocked(postGithubCorrectionCarrierComment).mockResolvedValue({
      kind: "unknown", reason: "ambiguous_response",
    });
    await expect(runGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID }))
      .resolves.toEqual({ kind: "held", reason: "unknown_post_outcome" });
    expect(reportGithubCorrectionFindingPublication).toHaveBeenCalledWith(expect.objectContaining({
      outcome: { kind: "unknown_post_outcome", reason: "ambiguous_response" },
    }));
    expect(reserveGithubCorrectionActivation).not.toHaveBeenCalled();
  });

  it("records a bounded finding failure, continues remaining findings, then performs one activation", async () => {
    vi.mocked(reserveNextGithubCorrectionFindingPublication)
      .mockResolvedValueOnce({ kind: "reserved", publication: { id: "pub-1" }, packet: {}, body: "first finding" } as never)
      .mockResolvedValueOnce({ kind: "reserved", publication: { id: "pub-2" }, packet: {}, body: "second finding" } as never)
      .mockResolvedValueOnce({ kind: "complete" } as never);
    vi.mocked(reserveGithubCorrectionActivation).mockResolvedValue({
      kind: "reserved", activation: { id: "activation-1" }, body: ACTIVATION_BODY,
      packetBundleBase64url: BUNDLE, packetBundleSha256: SHA, recipient: "codex",
    } as never);
    vi.mocked(postGithubCorrectionCarrierComment)
      .mockResolvedValueOnce({ kind: "known_failure", reason: "github_rejected" })
      .mockResolvedValueOnce({ kind: "published", commentId: "102", commentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-102", bodySha256: "b".repeat(64) })
      .mockResolvedValueOnce({ kind: "published", commentId: "103", commentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-103", bodySha256: "c".repeat(64) });

    const result = await runGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID });
    expect(result).toEqual({
      kind: "carrier_accepted", githubCommentId: "103",
      githubCommentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-103",
    });
    expect(reportGithubCorrectionFindingPublication).toHaveBeenNthCalledWith(1, expect.objectContaining({
      publicationId: "pub-1", outcome: { kind: "bounded_failed", reason: "github_rejected" },
    }));
    expect(reportGithubCorrectionFindingPublication).toHaveBeenNthCalledWith(2, expect.objectContaining({
      publicationId: "pub-2", outcome: expect.objectContaining({ kind: "published" }) }),
    );
    expect(JSON.stringify(result)).not.toMatch(/ack|repair|started/i);
  });

  it("does not issue a second activation when its reservation is held/replayed", async () => {
    vi.mocked(reserveNextGithubCorrectionFindingPublication).mockResolvedValue({ kind: "complete" } as never);
    vi.mocked(reserveGithubCorrectionActivation).mockResolvedValue({ kind: "held" } as never);
    await expect(runGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID }))
      .resolves.toEqual({ kind: "held", reason: "unknown_post_outcome" });
    expect(postGithubCorrectionCarrierComment).not.toHaveBeenCalled();
  });

  it("replays a persisted carrier receipt without posting another comment", async () => {
    vi.mocked(reserveNextGithubCorrectionFindingPublication).mockResolvedValue({ kind: "complete" } as never);
    vi.mocked(reserveGithubCorrectionActivation).mockResolvedValue({
      kind: "carrier_accepted", activation: { id: "activation-1" },
      githubCommentId: "102",
      githubCommentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-102",
    } as never);

    await expect(runGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID }))
      .resolves.toEqual({
        kind: "carrier_accepted", githubCommentId: "102",
        githubCommentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-102",
      });
    expect(postGithubCorrectionCarrierComment).not.toHaveBeenCalled();
    expect(reportGithubCorrectionActivation).not.toHaveBeenCalled();
  });

  it("replays a persisted bounded activation failure without posting another comment", async () => {
    vi.mocked(reserveNextGithubCorrectionFindingPublication).mockResolvedValue({ kind: "complete" } as never);
    vi.mocked(reserveGithubCorrectionActivation).mockResolvedValue({
      kind: "bounded_failed", activation: { id: "activation-1" }, reason: "github_rejected",
    } as never);

    await expect(runGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID }))
      .resolves.toEqual({ kind: "bounded_failed" });
    expect(postGithubCorrectionCarrierComment).not.toHaveBeenCalled();
    expect(reportGithubCorrectionActivation).not.toHaveBeenCalled();
  });

  it("reports DB-bounded oversized activation without a final mention POST", async () => {
    vi.mocked(reserveNextGithubCorrectionFindingPublication).mockResolvedValue({ kind: "complete" } as never);
    vi.mocked(reserveGithubCorrectionActivation).mockResolvedValue({
      kind: "bounded_failed", activation: { id: "activation-1" }, reason: "activation_body_too_large",
    } as never);
    await expect(runGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID }))
      .resolves.toEqual({ kind: "bounded_failed" });
    expect(postGithubCorrectionCarrierComment).not.toHaveBeenCalled();
    expect(reportGithubCorrectionActivation).not.toHaveBeenCalled();
  });

  it("refuses the final mention when the authenticated remote head changes after findings", async () => {
    vi.mocked(reserveNextGithubCorrectionFindingPublication)
      .mockResolvedValueOnce({
        kind: "reserved", publication: { id: "pub-1" }, body: "ordinary finding",
      } as never)
      .mockResolvedValueOnce({ kind: "complete" } as never);
    vi.mocked(postGithubCorrectionCarrierComment).mockResolvedValue({
      kind: "published", commentId: "101",
      commentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-101",
      bodySha256: "b".repeat(64),
    });
    vi.mocked(readCurrentGithubPullRequest).mockResolvedValue({
      ok: true,
      pullRequest: {
        repo: "acme/widgets", prNumber: 42,
        headSha: "c".repeat(40), baseSha: "b".repeat(40),
        state: "open", draft: false, merged: false,
        htmlUrl: "https://github.com/acme/widgets/pull/42",
      },
    });

    await expect(runGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID }))
      .resolves.toEqual({ kind: "not_current" });
    expect(postGithubCorrectionCarrierComment).toHaveBeenCalledTimes(1);
    expect(postGithubCorrectionCarrierComment).toHaveBeenCalledWith(expect.objectContaining({ kind: "finding" }));
    expect(reserveGithubCorrectionActivation).not.toHaveBeenCalled();
  });

  it("maps a rejected DB-issued body to the closed custody failure instead of a storage hold", async () => {
    vi.mocked(reserveNextGithubCorrectionFindingPublication)
      .mockResolvedValueOnce({
        kind: "reserved", publication: { id: "pub-1" }, body: "ordinary finding",
      } as never)
      .mockResolvedValueOnce({ kind: "complete" } as never);
    vi.mocked(reserveGithubCorrectionActivation).mockResolvedValue({
      kind: "reserved", activation: { id: "activation-1" }, body: ACTIVATION_BODY,
      packetBundleBase64url: BUNDLE, packetBundleSha256: SHA, recipient: "codex",
    } as never);
    vi.mocked(postGithubCorrectionCarrierComment)
      .mockResolvedValueOnce({ kind: "known_failure", reason: "invalid_input" })
      .mockResolvedValueOnce({ kind: "known_failure", reason: "invalid_input" });

    await expect(runGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID }))
      .resolves.toEqual({ kind: "bounded_failed" });
    expect(reportGithubCorrectionFindingPublication).toHaveBeenCalledWith(expect.objectContaining({
      publicationId: "pub-1",
      outcome: { kind: "bounded_failed", reason: "invalid_db_issued_body" },
    }));
    expect(reportGithubCorrectionActivation).toHaveBeenCalledWith(expect.objectContaining({
      activationId: "activation-1",
      outcome: { kind: "bounded_failed", reason: "invalid_db_issued_body" },
    }));
  });

  it("does no credential or carrier work when exact preflight is not ready", async () => {
    vi.mocked(preflightGithubCorrectionCarrier).mockResolvedValue({ kind: "held" } as never);
    await expect(runGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID }))
      .resolves.toEqual({ kind: "not_ready" });
    expect(getGithubCorrectionCarrierCredential).not.toHaveBeenCalled();
    expect(reserveNextGithubCorrectionFindingPublication).not.toHaveBeenCalled();
    expect(reserveGithubCorrectionActivation).not.toHaveBeenCalled();
  });

  it("accepts no widened caller input", async () => {
    await expect(runGithubCorrectionCarrier({
      workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID, repo: "attacker/controlled",
    } as never)).resolves.toEqual({ kind: "invalid_input" });
    expect(preflightGithubCorrectionCarrier).not.toHaveBeenCalled();
  });

  it("holds after a successful POST when its durable report cannot be stored", async () => {
    vi.mocked(reserveNextGithubCorrectionFindingPublication).mockResolvedValue({
      kind: "reserved", publication: { id: "pub-1" }, packet: {}, body: "ordinary finding",
    } as never);
    vi.mocked(postGithubCorrectionCarrierComment).mockResolvedValue({
      kind: "published", commentId: "101", commentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-101", bodySha256: "b".repeat(64),
    });
    vi.mocked(reportGithubCorrectionFindingPublication).mockRejectedValue(new Error("storage outage"));
    await expect(runGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID }))
      .resolves.toEqual({ kind: "held", reason: "storage_unavailable" });
    expect(reserveGithubCorrectionActivation).not.toHaveBeenCalled();
  });

  it("resumes remaining findings after a restart and still posts one activation", async () => {
    vi.mocked(reserveNextGithubCorrectionFindingPublication)
      .mockResolvedValueOnce({ kind: "reserved", publication: { id: "pub-1" }, body: "first finding" } as never)
      .mockRejectedValueOnce(new Error("process interrupted before the next reservation"))
      .mockResolvedValueOnce({ kind: "reserved", publication: { id: "pub-2" }, body: "second finding" } as never)
      .mockResolvedValueOnce({ kind: "complete" } as never);
    vi.mocked(reserveGithubCorrectionActivation).mockResolvedValue({
      kind: "reserved", activation: { id: "activation-1" }, body: ACTIVATION_BODY,
      packetBundleBase64url: BUNDLE, packetBundleSha256: SHA, recipient: "codex",
    } as never);
    vi.mocked(postGithubCorrectionCarrierComment)
      .mockResolvedValueOnce({ kind: "published", commentId: "101", commentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-101", bodySha256: "b".repeat(64) })
      .mockResolvedValueOnce({ kind: "published", commentId: "102", commentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-102", bodySha256: "c".repeat(64) })
      .mockResolvedValueOnce({ kind: "published", commentId: "103", commentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-103", bodySha256: "d".repeat(64) });

    await expect(runGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID }))
      .resolves.toEqual({ kind: "held", reason: "storage_unavailable" });
    await expect(runGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID }))
      .resolves.toEqual({
        kind: "carrier_accepted", githubCommentId: "103",
        githubCommentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-103",
      });
    expect(reserveGithubCorrectionActivation).toHaveBeenCalledTimes(1);
    expect(postGithubCorrectionCarrierComment).toHaveBeenCalledTimes(3);
  });

  it("resumes the sole activation after all findings were already terminal", async () => {
    vi.mocked(reserveNextGithubCorrectionFindingPublication).mockResolvedValue({ kind: "complete" } as never);
    vi.mocked(reserveGithubCorrectionActivation)
      .mockRejectedValueOnce(new Error("process interrupted before activation reservation"))
      .mockResolvedValueOnce({
        kind: "reserved", activation: { id: "activation-1" }, body: ACTIVATION_BODY,
        packetBundleBase64url: BUNDLE, packetBundleSha256: SHA, recipient: "codex",
      } as never);
    vi.mocked(postGithubCorrectionCarrierComment).mockResolvedValue({
      kind: "published", commentId: "104",
      commentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-104",
      bodySha256: "e".repeat(64),
    });

    await expect(runGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID }))
      .resolves.toEqual({ kind: "held", reason: "storage_unavailable" });
    await expect(runGithubCorrectionCarrier({ workspaceId: WORKSPACE_ID, dispatchId: DISPATCH_ID }))
      .resolves.toEqual({
        kind: "carrier_accepted", githubCommentId: "104",
        githubCommentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-104",
      });
    expect(postGithubCorrectionCarrierComment).toHaveBeenCalledTimes(1);
  });
});
