import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

// ── Module mocks ───────────────────────────────────────────────────────────
vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  listWorkspaceRepositories: vi.fn(),
  getRepository: vi.fn(),
  listWikiPages: vi.fn(),
}));

vi.mock("@agentrail/db-clickhouse", () => ({
  getLatestWikiCompileEvent: vi.fn(),
  getLatestIndexSnapshotsForWorkspace: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listWorkspaceRepositories,
  getRepository,
  listWikiPages,
} from "@agentrail/db-postgres";
import {
  getLatestWikiCompileEvent,
  getLatestIndexSnapshotsForWorkspace,
} from "@agentrail/db-clickhouse";

// ── Helpers ────────────────────────────────────────────────────────────────
const WORKSPACE_ID = "ws-123";
const USER_ID = "user-1";

function makeRequest(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/wiki${query}`
  );
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

function mockAuthed(role: string = "member") {
  vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role,
  } as never);
}

const repoA = {
  id: "repo-a",
  workspaceId: WORKSPACE_ID,
  name: "bensigo/agentrail",
  url: "https://github.com/bensigo/agentrail",
  defaultBranch: "main",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const repoB = {
  ...repoA,
  id: "repo-b",
  name: "bensigo/other",
  url: "https://github.com/bensigo/other",
};

const pageRow = {
  id: "page-1",
  workspaceId: WORKSPACE_ID,
  repositoryId: "repo-a",
  slug: "wiki/overview",
  title: "AgentRail — overview",
  kind: "overview" as const,
  bodyMd: "## Responsibility\nCompiles repository knowledge.",
  skeleton: { fileCount: 31 },
  links: { related: [], dependsOn: [], dependedOnBy: ["wiki/unit/context"] },
  citations: ["agentrail/context/index.py"],
  commitSha: "129103aa",
  inputsHash: "sha256:abc",
  model: "claude-haiku-4-5",
  writtenBy: "wiki-compiler",
  generatedAt: new Date("2026-07-23T14:00:00.000Z"),
  stale: false,
  createdAt: new Date("2026-07-23T14:00:00.000Z"),
  updatedAt: new Date("2026-07-23T14:00:00.000Z"),
};

const compileEvent = {
  workspace_id: WORKSPACE_ID,
  repository_id: "repo-a",
  commit_sha: "129103aa",
  pages_written: 3,
  pages_reused: 21,
  cost_usd: 0.04,
  model: "claude-haiku-4-5",
  duration_ms: 5200,
  created_at: "2026-07-23T14:00:05.000Z",
  event_id: "deadbeef",
};

/** A fresh (30s-old) index snapshot for a repo — unambiguously "healthy"
 * however long the test suite takes to run, avoiding fake timers. */
function freshSnapshot(repositoryId: string, overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: WORKSPACE_ID,
    repository_id: repositoryId,
    commit_sha: "129103aa",
    indexed_at: new Date(Date.now() - 30_000).toISOString(),
    source_count: 31,
    graph_edge_count: 76000,
    event_id: "snap-1",
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe("GET /api/v1/workspaces/:workspaceId/wiki", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(listWikiPages).mockResolvedValue([pageRow] as never);
    vi.mocked(getLatestWikiCompileEvent).mockResolvedValue(compileEvent as never);
    vi.mocked(getLatestIndexSnapshotsForWorkspace).mockResolvedValue([] as never);
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(401);
    expect(listWorkspaceRepositories).not.toHaveBeenCalled();
  });

  it("returns 403 when the user is not a workspace member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(listWorkspaceRepositories).not.toHaveBeenCalled();
  });

  it("multi-repo workspace with no ?repoId returns the health-enriched repo list — no wiki round trip", async () => {
    mockAuthed();
    vi.mocked(listWorkspaceRepositories).mockResolvedValue([repoA, repoB] as never);
    vi.mocked(getLatestIndexSnapshotsForWorkspace).mockResolvedValue([
      freshSnapshot("repo-a"),
    ] as never);

    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.repos).toEqual([
      {
        id: "repo-a",
        name: "bensigo/agentrail",
        healthStatus: "healthy",
        lastIndexedAt: expect.any(String),
        lastCommitSha: "129103aa",
        sourceCount: 31,
      },
      {
        id: "repo-b",
        name: "bensigo/other",
        // Never indexed (no snapshot) -> critical, per repoHealth's own contract.
        healthStatus: "critical",
        lastIndexedAt: null,
        lastCommitSha: null,
        sourceCount: null,
      },
    ]);
    expect(json.selectedRepoId).toBeNull();
    expect(json.pages).toBeNull();
    expect(json.latestCompile).toBeNull();
    expect(listWikiPages).not.toHaveBeenCalled();
    expect(getLatestWikiCompileEvent).not.toHaveBeenCalled();
  });

  it("includes canManage: true for an owner/admin, false for a plain member", async () => {
    vi.mocked(listWorkspaceRepositories).mockResolvedValue([repoA, repoB] as never);

    mockAuthed("owner");
    const ownerRes = await GET(makeRequest(), makeParams());
    expect((await ownerRes.json()).canManage).toBe(true);

    mockAuthed("admin");
    const adminRes = await GET(makeRequest(), makeParams());
    expect((await adminRes.json()).canManage).toBe(true);

    mockAuthed("member");
    const memberRes = await GET(makeRequest(), makeParams());
    expect((await memberRes.json()).canManage).toBe(false);
  });

  it("degrades gracefully when the index-snapshot lookup throws — the repo list still renders, every repo reads critical", async () => {
    mockAuthed();
    // Two repos so this stays on the "picker list only" branch — the point
    // of this test is the snapshot-lookup failure, not repo auto-select.
    vi.mocked(listWorkspaceRepositories).mockResolvedValue([repoA, repoB] as never);
    vi.mocked(getLatestIndexSnapshotsForWorkspace).mockRejectedValue(new Error("ClickHouse down"));

    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.repos).toEqual([
      {
        id: "repo-a",
        name: "bensigo/agentrail",
        healthStatus: "critical",
        lastIndexedAt: null,
        lastCommitSha: null,
        sourceCount: null,
      },
      {
        id: "repo-b",
        name: "bensigo/other",
        healthStatus: "critical",
        lastIndexedAt: null,
        lastCommitSha: null,
        sourceCount: null,
      },
    ]);
  });

  it("single-repo workspace auto-selects without a ?repoId (spec §4.5)", async () => {
    mockAuthed();
    vi.mocked(listWorkspaceRepositories).mockResolvedValue([repoA] as never);
    vi.mocked(getRepository).mockResolvedValue(repoA as never);

    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.selectedRepoId).toBe("repo-a");
    expect(json.repoUrl).toBe("https://github.com/bensigo/agentrail");
    expect(getRepository).toHaveBeenCalledWith(WORKSPACE_ID, "repo-a");
    expect(listWikiPages).toHaveBeenCalledWith(WORKSPACE_ID, "repo-a");
  });

  it("maps wiki page rows to the wire shape (verbatim bodyMd, skeleton passed through opaque, no id/writtenBy leaked)", async () => {
    mockAuthed();
    vi.mocked(listWorkspaceRepositories).mockResolvedValue([repoA] as never);
    vi.mocked(getRepository).mockResolvedValue(repoA as never);

    const res = await GET(makeRequest("?repoId=repo-a"), makeParams());
    const json = await res.json();

    expect(json.pages).toEqual([
      {
        slug: "wiki/overview",
        title: "AgentRail — overview",
        kind: "overview",
        bodyMd: "## Responsibility\nCompiles repository knowledge.",
        citations: ["agentrail/context/index.py"],
        links: { related: [], dependsOn: [], dependedOnBy: ["wiki/unit/context"] },
        commitSha: "129103aa",
        model: "claude-haiku-4-5",
        generatedAt: "2026-07-23T14:00:00.000Z",
        stale: false,
        skeleton: { fileCount: 31 },
      },
    ]);
    expect(json.pages[0]).not.toHaveProperty("id");
    expect(json.pages[0]).not.toHaveProperty("writtenBy");
  });

  it("maps the latest compile event to the wire shape", async () => {
    mockAuthed();
    vi.mocked(listWorkspaceRepositories).mockResolvedValue([repoA] as never);
    vi.mocked(getRepository).mockResolvedValue(repoA as never);

    const res = await GET(makeRequest("?repoId=repo-a"), makeParams());
    const json = await res.json();

    expect(json.latestCompile).toEqual({
      commitSha: "129103aa",
      pagesWritten: 3,
      pagesReused: 21,
      costUsd: 0.04,
      model: "claude-haiku-4-5",
      durationMs: 5200,
      createdAt: "2026-07-23T14:00:05.000Z",
    });
  });

  it("omits the cost line gracefully when there is no compile event yet", async () => {
    mockAuthed();
    vi.mocked(listWorkspaceRepositories).mockResolvedValue([repoA] as never);
    vi.mocked(getRepository).mockResolvedValue(repoA as never);
    vi.mocked(getLatestWikiCompileEvent).mockResolvedValue(null);

    const res = await GET(makeRequest("?repoId=repo-a"), makeParams());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.latestCompile).toBeNull();
    expect(json.pages).toHaveLength(1);
  });

  it("degrades gracefully when ClickHouse throws — the wiki body still renders", async () => {
    mockAuthed();
    vi.mocked(listWorkspaceRepositories).mockResolvedValue([repoA] as never);
    vi.mocked(getRepository).mockResolvedValue(repoA as never);
    vi.mocked(getLatestWikiCompileEvent).mockRejectedValue(new Error("ClickHouse down"));

    const res = await GET(makeRequest("?repoId=repo-a"), makeParams());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.latestCompile).toBeNull();
    expect(json.pages).toHaveLength(1);
  });

  it("returns 404 for a repoId outside this workspace", async () => {
    mockAuthed();
    vi.mocked(listWorkspaceRepositories).mockResolvedValue([repoA] as never);
    vi.mocked(getRepository).mockResolvedValue(null as never);

    const res = await GET(makeRequest("?repoId=repo-in-another-workspace"), makeParams());
    expect(res.status).toBe(404);
    expect(listWikiPages).not.toHaveBeenCalled();
  });

  it("an explicit ?repoId overrides auto-select even in a multi-repo workspace", async () => {
    mockAuthed();
    vi.mocked(listWorkspaceRepositories).mockResolvedValue([repoA, repoB] as never);
    vi.mocked(getRepository).mockResolvedValue(repoB as never);

    const res = await GET(makeRequest("?repoId=repo-b"), makeParams());
    const json = await res.json();

    expect(json.selectedRepoId).toBe("repo-b");
    expect(getRepository).toHaveBeenCalledWith(WORKSPACE_ID, "repo-b");
  });

  it("returns an empty pages array (not the empty-state null) when the repo has no wiki yet — never compiled vs no repo selected are distinct states", async () => {
    mockAuthed();
    vi.mocked(listWorkspaceRepositories).mockResolvedValue([repoA] as never);
    vi.mocked(getRepository).mockResolvedValue(repoA as never);
    vi.mocked(listWikiPages).mockResolvedValue([]);
    vi.mocked(getLatestWikiCompileEvent).mockResolvedValue(null);

    const res = await GET(makeRequest("?repoId=repo-a"), makeParams());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.selectedRepoId).toBe("repo-a");
    expect(json.pages).toEqual([]);
  });
});
