import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The github/webhook route's `push` handler (owner ask: "the auto recompile
 * feature for the llm wiki when changes is made") — in isolation from
 * `route.test.ts`/`route.reconciler-trigger.test.ts`/
 * `route.issues-edited.test.ts` (all `issues`-event concerns) and from
 * `route.per-workspace-secret.test.ts` (signature verification across event
 * types, including a couple of push-specific cases — this file mocks
 * `verifySignature`'s inputs away entirely by never setting
 * `GITHUB_WEBHOOK_SECRET`/a per-workspace secret, so every request here is
 * unsigned-and-accepted, keeping this file's focus purely on push semantics).
 *
 * Covers the full trigger/ignore matrix from `handlePush`'s own doc-comment:
 * flag off, unknown repo, non-default branch, deleted, zero-commit, the
 * minimum-interval guard, and the queued/already_pending success outcomes —
 * plus the burst-collapse behavior AT THIS ROUTE'S OWN LEVEL (the underlying
 * debounce mechanism itself is pinned against the REAL `enqueueOnboard` in
 * `packages/db-postgres/src/__tests__/onboard-push-debounce.test.ts`; this
 * file only needs to prove the route calls `enqueueOnboard` on EVERY
 * admitted push — honestly relaying whatever it reports — rather than doing
 * any suppression of its own).
 */
vi.mock("@agentrail/db-postgres", () => ({
  findWorkspaceByRepo: vi.fn(),
  getConnector: vi.fn(),
  appendJudgmentEvent: vi.fn(),
  enqueueGithubIssue: vi.fn(),
  findQueueEntryByExternalId: vi.fn(),
  getRepositoryByName: vi.fn(),
  enqueueOnboard: vi.fn(),
  findOnboardEntryStatus: vi.fn(),
  ONBOARD_ALREADY_PENDING_REASON: "already_pending",
}));

vi.mock("../../../../../../lib/alignment-reconciler", () => ({
  postAlignmentBrief: vi.fn(),
  reconcileAlignmentBriefs: vi.fn(),
  reviseAndRepostAlignmentBrief: vi.fn(),
}));

import { POST } from "./route";
import {
  appendJudgmentEvent,
  findWorkspaceByRepo,
  getConnector,
  getRepositoryByName,
  enqueueOnboard,
  findOnboardEntryStatus,
} from "@agentrail/db-postgres";

const mockFindWorkspace = vi.mocked(findWorkspaceByRepo);
const mockGetConnector = vi.mocked(getConnector);
const mockAppendJudgmentEvent = vi.mocked(appendJudgmentEvent);
const mockGetRepo = vi.mocked(getRepositoryByName);
const mockEnqueueOnboard = vi.mocked(enqueueOnboard);
const mockFindOnboardStatus = vi.mocked(findOnboardEntryStatus);

const FLAG = "AGENTRAIL_WIKI_RECOMPILE_ON_PUSH";
const MIN_INTERVAL_ENV = "AGENTRAIL_WIKI_PUSH_MIN_INTERVAL_SECONDS";
const ORIGINAL_FLAG = process.env[FLAG];
const ORIGINAL_INTERVAL = process.env[MIN_INTERVAL_ENV];
const ORIGINAL_SECRET = process.env["GITHUB_WEBHOOK_SECRET"];

const WS = "ws-1";
const REPO = "acme/widgets";

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/connectors/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-github-delivery": "delivery-1",
    },
    body: JSON.stringify(body),
  });
}

function pushPayload(overrides: Record<string, unknown> = {}) {
  return {
    ref: "refs/heads/main",
    deleted: false,
    commits: [{ id: "abc123", message: "fix: something" }],
    repository: { full_name: REPO },
    ...overrides,
  };
}

const REPO_ROW = {
  id: "repo-1",
  workspaceId: WS,
  name: REPO,
  url: `https://github.com/${REPO}`,
  defaultBranch: "main",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env[FLAG] = "1";
  delete process.env[MIN_INTERVAL_ENV];
  delete process.env["GITHUB_WEBHOOK_SECRET"];
  mockFindWorkspace.mockResolvedValue(WS);
  mockGetConnector.mockResolvedValue({ config: {} } as never);
  mockGetRepo.mockResolvedValue(REPO_ROW as never);
  mockFindOnboardStatus.mockResolvedValue(null); // no prior onboard row → interval guard never blocks
  mockEnqueueOnboard.mockResolvedValue({
    enqueued: true,
    id: "entry-1",
    state: "queued",
    blockedBy: [],
  } as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env[FLAG];
  else process.env[FLAG] = ORIGINAL_FLAG;
  if (ORIGINAL_INTERVAL === undefined) delete process.env[MIN_INTERVAL_ENV];
  else process.env[MIN_INTERVAL_ENV] = ORIGINAL_INTERVAL;
  if (ORIGINAL_SECRET === undefined) delete process.env["GITHUB_WEBHOOK_SECRET"];
  else process.env["GITHUB_WEBHOOK_SECRET"] = ORIGINAL_SECRET;
  vi.restoreAllMocks();
});

describe("POST /api/v1/connectors/github/webhook — push: flag gate", () => {
  it("flag unset: ignored:flag_off, skips wiki enqueue but still permits judgment-ledger capture", async () => {
    delete process.env[FLAG];
    const res = await POST(req(pushPayload()));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ event: "push", status: "ignored:flag_off" });
    expect(mockFindOnboardStatus).not.toHaveBeenCalled();
    expect(mockEnqueueOnboard).not.toHaveBeenCalled();
  });

  it("flag set to something other than '1': still ignored:flag_off", async () => {
    process.env[FLAG] = "true";
    const res = await POST(req(pushPayload()));
    const body = await res.json();

    expect(body).toEqual({ event: "push", status: "ignored:flag_off" });
    expect(mockEnqueueOnboard).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/connectors/github/webhook — push: false_green capture", () => {
  it("default-branch GitHub revert commit appends one false_green judgment event", async () => {
    const res = await POST(
      req(
        pushPayload({
          commits: [
            {
              id: "def456",
              timestamp: "2026-08-03T12:34:56.000Z",
              message:
                'Revert "Add reviewer smoke VM (#1547)"\n\nThis reverts commit abc123def4567890abc123def4567890abc123de.',
            },
          ],
          sender: { login: "bensigo" },
        })
      )
    );

    expect((await res.json()).status).toBe("queued");
    expect(mockAppendJudgmentEvent).toHaveBeenCalledWith({
      workspaceId: WS,
      repo: REPO,
      eventKey: "false-green:revert:def456",
      type: "false_green",
      refs: {
        revertCommitSha: "def456",
        revertedCommitSha: "abc123def4567890abc123def4567890abc123de",
        pullRequestNumber: 1547,
      },
      payload: {
        gateOutcome: "reverted",
        revertCommitSha: "def456",
        revertedCommitSha: "abc123def4567890abc123def4567890abc123de",
        pullRequestNumber: 1547,
        message:
          'Revert "Add reviewer smoke VM (#1547)"\n\nThis reverts commit abc123def4567890abc123def4567890abc123de.',
        messageTruncated: false,
      },
      actorRef: { kind: "github_user", id: "bensigo" },
      sourceRef: { kind: "github_webhook", id: "delivery-1" },
      occurredAt: new Date("2026-08-03T12:34:56.000Z"),
    });
  });

  it("non-revert commits and non-default branch revert commits do not append false_green", async () => {
    await POST(req(pushPayload({ commits: [{ id: "c1", message: "fix: normal change" }] })));
    expect(mockAppendJudgmentEvent).not.toHaveBeenCalled();

    await POST(
      req(
        pushPayload({
          ref: "refs/heads/feature-x",
          commits: [{ id: "c2", message: "This reverts commit abc1234." }],
        })
      )
    );
    expect(mockAppendJudgmentEvent).not.toHaveBeenCalled();
  });

  it("false_green capture failure is logged and never changes the push response", async () => {
    mockAppendJudgmentEvent.mockRejectedValue(new Error("ledger down"));

    const res = await POST(
      req(pushPayload({ commits: [{ id: "def456", message: "This reverts commit abc1234." }] }))
    );

    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe("queued");
    expect(console.error).toHaveBeenCalled();
  });
});

describe("POST /api/v1/connectors/github/webhook — push: admission (flag on)", () => {
  it("default-branch push with commits: force-enqueues the onboard job and reports queued", async () => {
    const res = await POST(req(pushPayload()));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ event: "push", status: "queued", id: "entry-1" });
    expect(mockGetRepo).toHaveBeenCalledWith(WS, REPO);
    expect(mockEnqueueOnboard).toHaveBeenCalledWith({
      workspaceId: WS,
      repoFullName: REPO,
      force: true,
    });
  });

  it("reports already_pending honestly when enqueueOnboard finds an active row — never fabricates queued", async () => {
    mockEnqueueOnboard.mockResolvedValue({
      enqueued: false,
      reason: "already_pending",
    } as never);

    const res = await POST(req(pushPayload()));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ event: "push", status: "already_pending" });
  });

  it("enqueueOnboard throwing is caught: 202 ignored:enqueue_failed, never a 500", async () => {
    mockEnqueueOnboard.mockRejectedValue(new Error("db down"));

    const res = await POST(req(pushPayload()));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ event: "push", status: "ignored:enqueue_failed" });
    expect(console.error).toHaveBeenCalled();
  });

  it("an unexpected (non-already_pending) not-enqueued reason: 202 ignored:enqueue_failed, never a fabricated queued", async () => {
    mockEnqueueOnboard.mockResolvedValue({
      enqueued: false,
      reason: "some unforeseen reason",
    } as never);

    const res = await POST(req(pushPayload()));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ event: "push", status: "ignored:enqueue_failed" });
    expect(console.error).toHaveBeenCalled();
  });
});

describe("POST /api/v1/connectors/github/webhook — push: ignore rules", () => {
  it("non-default branch push: ignored:non_default_branch, enqueueOnboard never called", async () => {
    const res = await POST(req(pushPayload({ ref: "refs/heads/feature-x" })));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ event: "push", status: "ignored:non_default_branch" });
    expect(mockEnqueueOnboard).not.toHaveBeenCalled();
  });

  it("respects a NON-'main' default branch (e.g. 'develop') — the repo row's own defaultBranch, not a hardcoded 'main'", async () => {
    mockGetRepo.mockResolvedValue({ ...REPO_ROW, defaultBranch: "develop" } as never);

    const ignoredForMain = await POST(req(pushPayload({ ref: "refs/heads/main" })));
    expect((await ignoredForMain.json()).status).toBe("ignored:non_default_branch");
    expect(mockEnqueueOnboard).not.toHaveBeenCalled();

    const queuedForDevelop = await POST(req(pushPayload({ ref: "refs/heads/develop" })));
    expect((await queuedForDevelop.json()).status).toBe("queued");
  });

  it("deleted ref (branch delete): ignored:deleted, enqueueOnboard never called", async () => {
    const res = await POST(
      req(pushPayload({ deleted: true, commits: [], after: "0".repeat(40) }))
    );
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ event: "push", status: "ignored:deleted" });
    expect(mockEnqueueOnboard).not.toHaveBeenCalled();
  });

  it("zero-commit push (e.g. a branch pointed at an already-known commit): ignored:zero_commit", async () => {
    const res = await POST(req(pushPayload({ commits: [] })));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ event: "push", status: "ignored:zero_commit" });
    expect(mockEnqueueOnboard).not.toHaveBeenCalled();
  });

  it("no workspace owns the repo: ignored:unknown_repo, no cross-workspace leak (getRepositoryByName never called)", async () => {
    mockFindWorkspace.mockResolvedValue(null);

    const res = await POST(req(pushPayload()));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ event: "push", status: "ignored:unknown_repo" });
    expect(mockGetRepo).not.toHaveBeenCalled();
    expect(mockEnqueueOnboard).not.toHaveBeenCalled();
  });

  it("workspace resolved but no repositories row for it: ignored:unknown_repo (still honest, no leak)", async () => {
    mockGetRepo.mockResolvedValue(null as never);

    const res = await POST(req(pushPayload()));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ event: "push", status: "ignored:unknown_repo" });
    expect(mockEnqueueOnboard).not.toHaveBeenCalled();
  });

  it("malformed payload (repository.full_name missing): ignored:unknown_repo, never a 500", async () => {
    const res = await POST(req({ ref: "refs/heads/main", commits: [{ id: "1" }] }));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ event: "push", status: "ignored:unknown_repo" });
  });

  it("unparseable JSON body on a push delivery: 400 invalid json (same posture as the issues handler)", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/v1/connectors/github/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-github-event": "push" },
        body: "not-json{{",
      })
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid json" });
  });
});

describe("POST /api/v1/connectors/github/webhook — push: minimum-interval guard", () => {
  it("no prior onboard row at all: guard never blocks (first-ever connect scenario, though normally connect itself onboards)", async () => {
    mockFindOnboardStatus.mockResolvedValue(null);

    const res = await POST(req(pushPayload()));
    expect((await res.json()).status).toBe("queued");
  });

  it("prior onboard row is still 'queued': the guard steps aside — enqueueOnboard's own dedupe reports the outcome", async () => {
    mockFindOnboardStatus.mockResolvedValue({ state: "queued", updatedAt: new Date() } as never);
    mockEnqueueOnboard.mockResolvedValue({
      enqueued: false,
      reason: "already_pending",
    } as never);

    const res = await POST(req(pushPayload()));
    expect((await res.json()).status).toBe("already_pending");
    expect(mockEnqueueOnboard).toHaveBeenCalled();
  });

  it("prior onboard row is 'running': the guard steps aside too", async () => {
    mockFindOnboardStatus.mockResolvedValue({ state: "running", updatedAt: new Date() } as never);

    const res = await POST(req(pushPayload()));
    expect(mockEnqueueOnboard).toHaveBeenCalled();
  });

  it("terminal row updated well within the default 300s window: ignored:min_interval, enqueueOnboard never called", async () => {
    mockFindOnboardStatus.mockResolvedValue({
      state: "green",
      updatedAt: new Date(Date.now() - 30_000), // 30s ago
    } as never);

    const res = await POST(req(pushPayload()));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ event: "push", status: "ignored:min_interval" });
    expect(mockEnqueueOnboard).not.toHaveBeenCalled();
  });

  it("terminal row updated outside the default 300s window: proceeds to enqueue", async () => {
    mockFindOnboardStatus.mockResolvedValue({
      state: "green",
      updatedAt: new Date(Date.now() - 301_000), // just over 300s ago
    } as never);

    const res = await POST(req(pushPayload()));
    expect((await res.json()).status).toBe("queued");
    expect(mockEnqueueOnboard).toHaveBeenCalled();
  });

  it("honors AGENTRAIL_WIKI_PUSH_MIN_INTERVAL_SECONDS override: a shorter window lets an earlier push through", async () => {
    process.env[MIN_INTERVAL_ENV] = "60";
    mockFindOnboardStatus.mockResolvedValue({
      state: "green",
      updatedAt: new Date(Date.now() - 90_000), // 90s ago — inside default 300s, outside 60s
    } as never);

    const res = await POST(req(pushPayload()));
    expect((await res.json()).status).toBe("queued");
  });

  it("honors AGENTRAIL_WIKI_PUSH_MIN_INTERVAL_SECONDS override: a longer window blocks a push the default would have allowed", async () => {
    process.env[MIN_INTERVAL_ENV] = "600";
    mockFindOnboardStatus.mockResolvedValue({
      state: "green",
      updatedAt: new Date(Date.now() - 400_000), // 400s ago — outside default 300s, inside 600s
    } as never);

    const res = await POST(req(pushPayload()));
    expect((await res.json()).status).toBe("ignored:min_interval");
    expect(mockEnqueueOnboard).not.toHaveBeenCalled();
  });

  it("a non-numeric override falls back to the 300s default rather than throwing", async () => {
    process.env[MIN_INTERVAL_ENV] = "not-a-number";
    mockFindOnboardStatus.mockResolvedValue({
      state: "green",
      updatedAt: new Date(Date.now() - 30_000),
    } as never);

    const res = await POST(req(pushPayload()));
    expect((await res.json()).status).toBe("ignored:min_interval");
  });
});

describe("POST /api/v1/connectors/github/webhook — push: burst (route-level relay, not its own suppression)", () => {
  it("three pushes in a row: the route calls enqueueOnboard every time and relays each outcome honestly (queued, then already_pending twice) — the actual collapse-to-one is enqueueOnboard's own job, pinned in db-postgres's onboard-push-debounce.test.ts", async () => {
    mockEnqueueOnboard
      .mockResolvedValueOnce({ enqueued: true, id: "entry-1", state: "queued", blockedBy: [] } as never)
      .mockResolvedValueOnce({ enqueued: false, reason: "already_pending" } as never)
      .mockResolvedValueOnce({ enqueued: false, reason: "already_pending" } as never);

    const first = await POST(req(pushPayload({ commits: [{ id: "c1" }] })));
    const second = await POST(req(pushPayload({ commits: [{ id: "c2" }] })));
    const third = await POST(req(pushPayload({ commits: [{ id: "c3" }] })));

    expect(await first.json()).toEqual({ event: "push", status: "queued", id: "entry-1" });
    expect(await second.json()).toEqual({ event: "push", status: "already_pending" });
    expect(await third.json()).toEqual({ event: "push", status: "already_pending" });

    // One admitted compile, not three — but via enqueueOnboard's own guard,
    // not any route-level suppression: the route attempted all three.
    expect(mockEnqueueOnboard).toHaveBeenCalledTimes(3);
    expect(mockEnqueueOnboard).toHaveBeenNthCalledWith(1, {
      workspaceId: WS,
      repoFullName: REPO,
      force: true,
    });
  });
});

describe("POST /api/v1/connectors/github/webhook — push: unrelated event types untouched", () => {
  it("a 'ping' delivery is still handled exactly as before (regression pin)", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/v1/connectors/github/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-github-event": "ping" },
        body: JSON.stringify({ zen: "Keep it logically awesome.", repository: { full_name: REPO } }),
      })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ignored: "ping" });
    expect(mockEnqueueOnboard).not.toHaveBeenCalled();
  });
});
