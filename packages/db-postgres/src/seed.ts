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
    .insert(schema.runs)
    .values([
      {
        workspaceId: DEV_WORKSPACE_ID,
        repositoryId: "bensigo/agentrail",
        agent: "claude",
        branch: "main",
        status: "success",
        startedAt: new Date("2026-06-08T08:00:00Z"),
        finishedAt: new Date("2026-06-08T08:05:00Z"),
      },
      {
        workspaceId: DEV_WORKSPACE_ID,
        repositoryId: "bensigo/agentrail",
        agent: "claude",
        branch: "feat/issue-212",
        status: "running",
        startedAt: new Date("2026-06-08T09:00:00Z"),
      },
      {
        workspaceId: DEV_WORKSPACE_ID,
        repositoryId: "bensigo/agentrail",
        agent: "codex",
        branch: "main",
        status: "queued",
      },
    ])
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

  console.log("Seed complete.");
  console.log(`  workspace id : ${DEV_WORKSPACE_ID}`);
  console.log(`  user id      : ${DEV_USER_ID}`);
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
