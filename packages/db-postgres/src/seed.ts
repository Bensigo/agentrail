import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema/index.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://agentrail:agentrail@localhost:5432/agentrail";

const DEV_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const DEV_USER_ID = "00000000-0000-0000-0000-000000000002";

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

  console.log("Seed complete.");
  console.log(`  workspace id : ${DEV_WORKSPACE_ID}`);
  console.log(`  user id      : ${DEV_USER_ID}`);

  await client.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
