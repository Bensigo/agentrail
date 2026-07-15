import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listWorkspaceRepositories,
  getRepositoryByName,
  createRepository,
  getConnector,
  upsertConnector,
  enqueueOnboard,
  hasActiveRunner,
} from "@agentrail/db-postgres";
import { getLatestIndexSnapshotsForWorkspace } from "@agentrail/db-clickhouse";
import { repoHealth, type HealthStatus } from "../../../../../../lib/repo-health";

const ADMIN_ROLES = ["owner", "admin"] as const;

// Onboard-on-connect: default-OFF rollout flag (only the exact value "1" enables it).
const ONBOARD_ON_CONNECT_FLAG = "AGENTRAIL_ONBOARD_ON_CONNECT";

const REPO_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Reject refs with control chars, spaces, and git-unsafe sequences
const GIT_UNSAFE_RE = /[\x00-\x1f\x7f ~^:?*[\\\s]|\.\.|\.lock$|\/$/ ;

function isGitSafeRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith("/") && !GIT_UNSAFE_RE.test(ref);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const repos = await listWorkspaceRepositories(workspaceId);
  const repoIds = repos.map((r) => r.id);

  let snapshots: Awaited<ReturnType<typeof getLatestIndexSnapshotsForWorkspace>> = [];
  try {
    snapshots = await getLatestIndexSnapshotsForWorkspace(workspaceId, repoIds);
  } catch {
    // ClickHouse unavailable — return repos with critical health
  }

  const snapshotByRepo = new Map(snapshots.map((s) => [s.repository_id, s]));
  const now = Date.now();

  const result = repos.map((repo) => {
    const snap = snapshotByRepo.get(repo.id) ?? null;
    const health = repoHealth(snap, now);

    return {
      id: repo.id,
      name: repo.name,
      url: repo.url,
      default_branch: repo.defaultBranch,
      last_indexed_at: health.last_indexed_at,
      last_commit_sha: snap?.commit_sha ?? null,
      staleness_seconds: health.staleness_seconds,
      codebase_units_count: snap?.source_count ?? null,
      health_status: health.health_status,
    };
  });

  return NextResponse.json({ repos: result });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json(
      { error: "Owner or admin role required" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({})) as {
    name?: unknown;
    url?: unknown;
    default_branch?: unknown;
  };

  const errors: Record<string, string> = {};

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    errors.name = "name is required";
  } else if (!REPO_NAME_RE.test(name)) {
    errors.name = "name must match owner/repo format (e.g. bensigo/agentrail)";
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    errors.url = "url is required";
  } else {
    const expectedPrefix = "https://github.com/";
    if (!url.startsWith(expectedPrefix)) {
      errors.url = "url must start with https://github.com/";
    } else {
      // path after https://github.com/ should match name (strip trailing slash)
      const urlPath = url.slice(expectedPrefix.length).replace(/\/$/, "");
      if (name && urlPath !== name) {
        errors.url = `url path must match repository name (expected https://github.com/${name})`;
      }
    }
  }

  const defaultBranch =
    typeof body.default_branch === "string" ? body.default_branch.trim() : "";
  if (!defaultBranch) {
    errors.default_branch = "default_branch is required";
  } else if (!isGitSafeRef(defaultBranch)) {
    errors.default_branch = "default_branch must be a valid git ref name";
  }

  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ errors }, { status: 400 });
  }

  const existing = await getRepositoryByName(workspaceId, name);
  if (existing) {
    return NextResponse.json(
      { error: "A repository with this name already exists in the workspace" },
      { status: 409 }
    );
  }

  const created = await createRepository({
    workspaceId,
    name,
    url,
    defaultBranch,
  });

  // Self-configure the GitHub connector (and thereby the heartbeat) on connect:
  // linking a repo is how GitHub is "connected" to a workspace, so seed/extend
  // the connector's polled repos with sane defaults (enabled, default label +
  // interval). Best-effort — a connector write failure must not fail the repo
  // link, which is the primary action.
  try {
    const existingConnector = await getConnector(workspaceId, "github");
    const repos = new Set(existingConnector?.config.repos ?? []);
    repos.add(name);
    await upsertConnector(workspaceId, "github", {
      enabled: true,
      config: { repos: [...repos] },
    });
  } catch (err) {
    console.error("[repos] failed to self-configure github connector:", err);
  }

  // When the workspace has an active self-hosted runner, enqueue a one-shot
  // idempotent onboard entry so the runner indexes the repo and seeds workspace
  // memory. Flag-gated OFF by default (rollout safety); best-effort.
  if (process.env[ONBOARD_ON_CONNECT_FLAG] === "1") {
    try {
      if (await hasActiveRunner(workspaceId)) {
        await enqueueOnboard({ workspaceId, repoFullName: created.name });
      }
    } catch (err) {
      console.error("[repos] failed to enqueue onboard:", err);
    }
  }

  return NextResponse.json(
    {
      repository: {
        id: created.id,
        name: created.name,
        url: created.url,
        default_branch: created.defaultBranch,
        last_indexed_at: null,
        last_commit_sha: null,
        staleness_seconds: null,
        codebase_units_count: null,
        health_status: "critical" as HealthStatus,
      },
    },
    { status: 201 }
  );
}
