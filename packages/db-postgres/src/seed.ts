import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema/index.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://agentrail:agentrail@localhost:5432/agentrail";

const DEV_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const DEV_USER_ID = "00000000-0000-0000-0000-000000000002";
const DEV_USER_2_ID = "00000000-0000-0000-0000-000000000003";
const DEV_USER_3_ID = "00000000-0000-0000-0000-000000000004";
const DEV_RUN_ID = "00000000-0000-0000-0000-000000000010";
const DEV_REPO_1_ID = "00000000-0000-0000-0000-000000000010";
const DEV_REPO_2_ID = "00000000-0000-0000-0000-000000000011";
const DEV_REPO_3_ID = "00000000-0000-0000-0000-000000000012";
const DEV_TEAM_1_ID = "00000000-0000-0000-0000-000000000020";
const DEV_TEAM_2_ID = "00000000-0000-0000-0000-000000000021";

async function seed() {
  const client = postgres(DATABASE_URL);
  const db = drizzle(client, { schema });

  console.log("Seeding dev workspace...");

  await db
    .insert(schema.workspaces)
    .values({
      id: DEV_WORKSPACE_ID,
      name: "Dev Workspace",
      slug: "dev",
    })
    .onConflictDoNothing();

  await db
    .insert(schema.workspaceMemberships)
    .values({
      userId: DEV_USER_ID,
      workspaceId: DEV_WORKSPACE_ID,
      role: "owner",
    })
    .onConflictDoNothing();

  await db
    .insert(schema.repositories)
    .values([
      {
        id: DEV_REPO_1_ID,
        workspaceId: DEV_WORKSPACE_ID,
        name: "bensigo/agentrail",
        url: "https://github.com/bensigo/agentrail",
        defaultBranch: "main",
      },
      {
        id: DEV_REPO_2_ID,
        workspaceId: DEV_WORKSPACE_ID,
        name: "bensigo/console-ui",
        url: "https://github.com/bensigo/console-ui",
        defaultBranch: "main",
      },
      {
        id: DEV_REPO_3_ID,
        workspaceId: DEV_WORKSPACE_ID,
        name: "bensigo/legacy-indexer",
        url: "https://github.com/bensigo/legacy-indexer",
        defaultBranch: "master",
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.runs)
    .values([
      {
        id: DEV_RUN_ID,
        workspaceId: DEV_WORKSPACE_ID,
        repositoryId: DEV_REPO_1_ID,
        agent: "claude",
        branch: "main",
        status: "success",
        startedAt: new Date("2026-06-08T08:00:00Z"),
        finishedAt: new Date("2026-06-08T08:05:00Z"),
      },
      {
        workspaceId: DEV_WORKSPACE_ID,
        repositoryId: DEV_REPO_1_ID,
        agent: "claude",
        branch: "feat/issue-212",
        status: "running",
        startedAt: new Date("2026-06-08T09:00:00Z"),
      },
      {
        workspaceId: DEV_WORKSPACE_ID,
        repositoryId: DEV_REPO_1_ID,
        agent: "codex",
        branch: "main",
        status: "queued",
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.memoryItems)
    .values([
      {
        workspaceId: DEV_WORKSPACE_ID,
        source: "docs/adr/0001-server-control-plane-with-local-indexing.md",
        content:
          "The server is the team control plane. The local indexer keeps source access repo-adjacent and syncs only bounded graph metadata, context-pack artifacts, run evidence, and audit events according to workspace policy. Do not upload full source code to the server by default.",
        tags: ["architecture", "indexing", "policy"],
        createdAt: new Date("2026-06-01T10:00:00Z"),
        lastUsedAt: new Date("2026-06-08T08:05:00Z"),
      },
      {
        workspaceId: DEV_WORKSPACE_ID,
        source: "CONTEXT.md",
        content:
          "Context Memory is advisory, source-linked knowledge from prior decisions, lessons, preferences, and failure patterns that must be checked against current code and docs. Memory must not outrank current code or explicit docs.",
        tags: ["memory", "advisory"],
        createdAt: new Date("2026-06-02T12:00:00Z"),
        lastUsedAt: new Date("2026-06-07T09:00:00Z"),
      },
      {
        workspaceId: DEV_WORKSPACE_ID,
        source: "skills/backend-api/SKILL.md",
        content:
          "Always validate auth and workspace membership before returning workspace-scoped data. Use the getWorkspaceMembership guard pattern. Return 401 for missing session, 403 for missing membership.",
        tags: ["auth", "api", "security"],
        createdAt: new Date("2026-06-03T14:00:00Z"),
        lastUsedAt: null,
      },
      {
        workspaceId: DEV_WORKSPACE_ID,
        source: "packages/db-postgres/src/queries/index.ts:47",
        content:
          "Duplicate getRun export detected at lines 6–16 and 47–57. The second definition shadows the first. This is a known existing bug in the file. Do not introduce a third export; resolve by removing the duplicate in a separate cleanup PR.",
        tags: ["bug", "db-postgres", "technical-debt"],
        createdAt: new Date("2026-06-04T16:00:00Z"),
        lastUsedAt: new Date("2026-06-09T08:00:00Z"),
      },
      {
        workspaceId: DEV_WORKSPACE_ID,
        source: "TASTE.md",
        content:
          "Observability tools are dense. Prefer space-2 to space-4 gaps inside tables, sidebars, and filter bars. Use font-mono (Berkeley Mono) for IDs, paths, hashes, timestamps, JSON, and code. Row height 32–36px for data tables. No rounded-lg or rounded-xl for data-dense components.",
        tags: ["ui", "design", "console"],
        createdAt: new Date("2026-06-05T09:00:00Z"),
        lastUsedAt: new Date("2026-06-08T15:00:00Z"),
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.teams)
    .values([
      {
        id: DEV_TEAM_1_ID,
        workspaceId: DEV_WORKSPACE_ID,
        name: "Platform",
      },
      {
        id: DEV_TEAM_2_ID,
        workspaceId: DEV_WORKSPACE_ID,
        name: "Agent Ops",
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.teamMemberships)
    .values([
      { teamId: DEV_TEAM_1_ID, userId: DEV_USER_ID, role: "owner" },
      { teamId: DEV_TEAM_1_ID, userId: DEV_USER_2_ID, role: "member" },
      { teamId: DEV_TEAM_2_ID, userId: DEV_USER_ID, role: "member" },
      { teamId: DEV_TEAM_2_ID, userId: DEV_USER_2_ID, role: "owner" },
      { teamId: DEV_TEAM_2_ID, userId: DEV_USER_3_ID, role: "member" },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.teamRepositories)
    .values([
      { teamId: DEV_TEAM_1_ID, repositoryId: DEV_REPO_1_ID },
      { teamId: DEV_TEAM_1_ID, repositoryId: DEV_REPO_2_ID },
      { teamId: DEV_TEAM_2_ID, repositoryId: DEV_REPO_1_ID },
      { teamId: DEV_TEAM_2_ID, repositoryId: DEV_REPO_3_ID },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.reviewGates)
    .values([
      {
        id: "00000000-0000-0000-0000-000000000020",
        workspaceId: DEV_WORKSPACE_ID,
        runId: DEV_RUN_ID,
        gateName: "Context provenance",
        status: "passed",
        conditions: [
          { key: "citation_coverage", operator: "gte", value: 1.0 },
          { key: "stale_leakage", operator: "eq", value: 0 },
        ],
        blockingReasons: [],
        evidenceRefs: [
          { label: "Context pack #1", url: `/dashboard/${DEV_WORKSPACE_ID}/context-packs?runId=${DEV_RUN_ID}` },
        ],
        evaluatedAt: new Date("2026-06-08T08:03:00Z"),
      },
      {
        id: "00000000-0000-0000-0000-000000000021",
        workspaceId: DEV_WORKSPACE_ID,
        runId: DEV_RUN_ID,
        gateName: "Verification evidence",
        status: "failed",
        conditions: [
          { key: "test_pass_rate", operator: "gte", value: 1.0 },
          { key: "build_success", operator: "eq", value: true },
        ],
        blockingReasons: [
          "Build failed: 3 type errors in apps/console",
          "test_pass_rate is 0.85, required >= 1.0",
        ],
        evidenceRefs: [
          { label: "Failure detail", url: `/dashboard/${DEV_WORKSPACE_ID}/failures?runId=${DEV_RUN_ID}` },
        ],
        evaluatedAt: new Date("2026-06-08T08:04:00Z"),
      },
      {
        id: "00000000-0000-0000-0000-000000000022",
        workspaceId: DEV_WORKSPACE_ID,
        runId: DEV_RUN_ID,
        gateName: "Acceptance criteria mapping",
        status: "pending",
        conditions: [
          { key: "ac_coverage", operator: "gte", value: 1.0 },
        ],
        blockingReasons: [],
        evidenceRefs: [],
        evaluatedAt: null,
      },
    ])
    .onConflictDoNothing();

  console.log("Seed complete.");
  console.log(`  workspace id : ${DEV_WORKSPACE_ID}`);
  console.log(`  user id      : ${DEV_USER_ID}`);
  console.log(`  run id       : ${DEV_RUN_ID}`);
  console.log(`  repo 1 id    : ${DEV_REPO_1_ID} (healthy)`);
  console.log(`  repo 2 id    : ${DEV_REPO_2_ID} (stale)`);
  console.log(`  repo 3 id    : ${DEV_REPO_3_ID} (critical)`);
  console.log(`  team 1 id    : ${DEV_TEAM_1_ID} (Platform)`);
  console.log(`  team 2 id    : ${DEV_TEAM_2_ID} (Agent Ops)`);

  await client.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
