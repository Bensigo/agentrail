import { db, queryClient } from "./client";
import { workspaces, workspaceMemberships } from "./schema";

async function main() {
  console.log("Seeding database...");

  const [workspace] = await db
    .insert(workspaces)
    .values({
      name: "Dev Workspace",
      slug: "dev",
    })
    .onConflictDoNothing({ target: workspaces.slug })
    .returning();

  if (workspace) {
    await db
      .insert(workspaceMemberships)
      .values({
        userId: "dev-user-001",
        workspaceId: workspace.id,
        role: "owner",
      })
      .onConflictDoNothing();

    console.log(`Created workspace: ${workspace.name} (${workspace.id})`);
    console.log(`Added dev-user-001 as owner`);
  } else {
    console.log("Dev workspace already exists, skipping.");
  }

  await queryClient.end();
  console.log("Seed complete.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
