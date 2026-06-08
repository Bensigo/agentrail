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

  console.log("Seed complete.");
  console.log(`  workspace id : ${DEV_WORKSPACE_ID}`);
  console.log(`  user id      : ${DEV_USER_ID}`);

  await client.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
